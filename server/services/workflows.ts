import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, resolve, sep } from 'path';
import { parse as parseYaml } from 'yaml';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { createHeadlessAgent, sendToHeadless, destroyHeadlessAgent } from './headless.js';
import { pushEvent } from './events.js';

const execAsync = promisify(execCb);

// ─── Types ───────────────────────────────────────────────────────────
//
// Design philosophy: Steps are CONVERSATIONS, not single prompts.
// Agents persist across the entire run. Review loops send follow-up
// messages to the same agent, which accumulates context and improves.
// Gate steps pause for human approval via the UI.

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  steps: StepDef[];
  // Scheduled triggers
  schedule?: { cron: string; enabled?: boolean };
  // Webhook trigger — auto-generated token
  webhook?: { enabled?: boolean; token?: string };
}

export interface StepDef {
  id: string;
  name?: string;
  needs?: string[];
  type?: 'step' | 'gate' | 'http' | 'shell' | 'file-read' | 'file-write' | 'workflow' | 'foreach';
  agent?: { model?: string; systemPrompt?: string };
  prompt?: string;
  prompt_file?: string;     // reference a .md file in data/stages/ instead of inline prompt
  timeout?: number;
  // Session sharing: steps with the same `session` value share one agent (preserving conversation context).
  // If omitted, each step gets its own fresh agent.
  session?: string;
  // Target: run this step on an existing named agent instead of creating a new one.
  // The agent won't be destroyed after the run. Mutually exclusive with `session`.
  target?: string;
  // Conditionals: expression evaluated before step runs — skip if false
  if?: string;
  // Output parsing: 'json' auto-extracts JSON from output → accessible as ${{ steps.X.outputs.key }}
  outputs?: 'json' | boolean;
  // Retry on failure
  retry?: number;           // max attempts (default 1 = no retry)
  retry_delay?: number;     // seconds between retries (default 2)
  // Error handling
  on_fail?: string;         // step ID to run as fallback if this step fails
  continue_on_fail?: boolean; // don't fail the entire run if this step fails
  // Iterative review: after step completes, a reviewer evaluates output.
  review?: {
    criteria: string;       // what "good" looks like
    max_iterations?: number; // default 3
  };
  // ── Tool step fields ──
  // HTTP step: url, method, headers, body (all interpolated)
  http?: { url: string; method?: string; headers?: Record<string, string>; body?: string };
  // Shell step: command to run (interpolated). stdout becomes output.
  shell?: { command: string; cwd?: string };
  // File-read: path to read (interpolated). Contents become output.
  file_read?: { path: string };
  // File-write: path and content (both interpolated). Writes file, output = path.
  file_write?: { path: string; content: string };
  // Sub-workflow: workflow ID to call, inputs mapped from template vars
  workflow?: { id: string; inputs?: Record<string, string> };
  // Foreach: iterate over items array. Each item runs the body step template.
  foreach?: {
    items: string;          // expression resolving to JSON array, e.g. "${{ steps.X.outputs.list }}"
    as?: string;            // variable name for current item (default: "item")
    step: StepDef;          // body step template (executed once per item)
    max_items?: number;     // safety cap (default: 50)
  };
}

export interface Iteration {
  attempt: number;
  output: string;
  review?: { pass: boolean; feedback: string };
  tokens?: number;
}

export type StepStatus = 'pending' | 'running' | 'reviewing' | 'waiting' | 'complete' | 'failed' | 'skipped';
export type RunStatus = 'pending' | 'running' | 'waiting' | 'paused' | 'complete' | 'failed' | 'cancelled';

export interface StepResult {
  id: string;
  name?: string;
  status: StepStatus;
  output: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  agentName?: string;
  tokens?: number;
  iteration: number;
  iterations: Iteration[];
  outputs?: Record<string, any>;  // parsed structured data from agent output
  retries?: number;               // retry attempts made
  artifacts?: Artifact[];         // files produced by this step
}

export interface Artifact {
  name: string;
  path: string;
  size: number;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  inputs: Record<string, string>;
  steps: StepResult[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

type RunListener = (run: WorkflowRun) => void;

// ─── State ───────────────────────────────────────────────────────────

const WORKFLOWS_DIR = join(process.cwd(), 'data', 'workflows');
const STAGES_DIR = join(process.cwd(), 'data', 'stages');
const RUNS_DIR = join(process.cwd(), 'data', 'runs');
const ARTIFACTS_DIR = join(process.cwd(), 'data', 'artifacts');
const workflows = new Map<string, WorkflowDef>();
const runs = new Map<string, WorkflowRun>();
const runListeners = new Set<RunListener>();
// Gate resolution: runId:stepId → resolve function
const gateResolvers = new Map<string, (approved: boolean, feedback?: string) => void>();
// Pause resolution: runId → resolve function (resumes the run)
const pauseResolvers = new Map<string, () => void>();
// Persistent agents: agents kept alive after workflow completion for post-run chat
// Maps runId → Set of agent names still alive
const persistentAgents = new Map<string, Set<string>>();
// Cleanup timers for persistent agents (auto-destroy after TTL)
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AGENT_TTL_MS = 30 * 60 * 1000; // 30 minutes
let runCounter = 0;

// ─── Loading ─────────────────────────────────────────────────────────

function normalizeSteps(steps: StepDef[]) {
  steps.forEach((s, i) => {
    if (!s.id) s.id = `step-${i}`;
    if (s.needs && !Array.isArray(s.needs)) s.needs = [s.needs];
  });
}

export async function loadWorkflows(): Promise<WorkflowDef[]> {
  workflows.clear();
  try {
    await mkdir(WORKFLOWS_DIR, { recursive: true });
    const files = await readdir(WORKFLOWS_DIR);
    for (const f of files) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      try {
        const raw = await readFile(join(WORKFLOWS_DIR, f), 'utf-8');
        const parsed = parseYaml(raw);
        const id = basename(f, f.endsWith('.yaml') ? '.yaml' : '.yml');
        const def: WorkflowDef = { id, ...parsed };
        if (!def.steps?.length) continue;
        normalizeSteps(def.steps);
        workflows.set(id, def);
      } catch (e: any) {
        console.error(`Failed to parse workflow ${f}:`, e.message);
      }
    }
  } catch {}
  restoreWebhookTokens();
  return Array.from(workflows.values());
}

// ─── Run Persistence ────────────────────────────────────────────────

async function persistRun(run: WorkflowRun): Promise<void> {
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    await writeFile(
      join(RUNS_DIR, `${run.runId}.json`),
      JSON.stringify(run, null, 2),
      'utf-8',
    );
  } catch (e: any) {
    console.error(`Failed to persist run ${run.runId}:`, e.message);
  }
}

export async function loadRuns(): Promise<void> {
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const files = await readdir(RUNS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(RUNS_DIR, f), 'utf-8');
        const run: WorkflowRun = JSON.parse(raw);
        runs.set(run.runId, run);
        // Restore runCounter to avoid ID collisions
        const match = run.runId.match(/^run-(\d+)-/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n >= runCounter) runCounter = n;
        }
      } catch (e: any) {
        console.error(`Failed to load run ${f}:`, e.message);
      }
    }
  } catch {}
}

export function getWorkflows(): WorkflowDef[] {
  return Array.from(workflows.values());
}

export function getWorkflow(id: string): WorkflowDef | undefined {
  return workflows.get(id);
}

// ─── Workflow CRUD ───────────────────────────────────────────────────

export async function saveWorkflow(id: string, yamlContent: string): Promise<WorkflowDef> {
  await mkdir(WORKFLOWS_DIR, { recursive: true });
  const parsed = parseYaml(yamlContent);
  const def: WorkflowDef = { id, ...parsed };
  normalizeSteps(def.steps || []);
  await writeFile(join(WORKFLOWS_DIR, `${id}.yaml`), yamlContent, 'utf-8');
  workflows.set(id, def);
  return def;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const filePath = join(WORKFLOWS_DIR, `${id}.yaml`);
  await unlink(filePath);
  workflows.delete(id);
}

// ─── Variable Interpolation ─────────────────────────────────────────

function interpolate(template: string, ctx: { inputs: Record<string, string>; steps: Record<string, StepResult> }): string {
  return template.replace(/\$\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    return resolveRef(expr.trim(), ctx);
  });
}

function resolveRef(ref: string, ctx: { inputs: Record<string, string>; steps: Record<string, StepResult> }): string {
  const parts = ref.split('.');
  if (parts[0] === 'inputs' && parts[1]) return ctx.inputs[parts[1]] || '';
  if (parts[0] === 'steps' && parts[1]) {
    const step = ctx.steps[parts[1]];
    if (!step) return '';
    if (parts[2] === 'output') return step.output || '';
    if (parts[2] === 'status') return step.status || '';
    if (parts[2] === 'error') return step.error || '';
    if (parts[2] === 'outputs' && parts[3]) return String(step.outputs?.[parts[3]] ?? '');
  }
  return '';
}

// ─── Condition Evaluator ────────────────────────────────────────────
//
// Simple expression language for step conditions. Supports:
//   ${{ steps.X.status }} == 'complete'
//   ${{ steps.X.output }} contains 'CRITICAL'
//   ${{ steps.X.outputs.severity }} == 'high'
//   ${{ inputs.flag }} != 'true'
//   expr && expr, expr || expr, !expr
//   true, false

function evaluateCondition(
  expr: string,
  ctx: { inputs: Record<string, string>; steps: Record<string, StepResult> },
): boolean {
  // First resolve all ${{ }} references to their string values
  const resolved = expr.replace(/\$\{\{\s*([^}]+)\s*\}\}/g, (_, ref: string) => {
    return resolveRef(ref.trim(), ctx);
  });
  return evalExpr(resolved.trim());
}

function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function evalExpr(expr: string): boolean {
  expr = expr.trim();
  if (!expr) return true;

  // Handle || (lowest precedence)
  if (expr.includes('||')) {
    return expr.split('||').some(part => evalExpr(part));
  }
  // Handle && 
  if (expr.includes('&&')) {
    return expr.split('&&').every(part => evalExpr(part));
  }
  // Handle negation
  if (expr.startsWith('!')) return !evalExpr(expr.slice(1));

  // Literal booleans
  if (expr === 'true') return true;
  if (expr === 'false') return false;

  // 'contains' operator
  if (expr.includes(' contains ')) {
    const idx = expr.indexOf(' contains ');
    const left = stripQuotes(expr.slice(0, idx));
    const right = stripQuotes(expr.slice(idx + 10));
    return left.toLowerCase().includes(right.toLowerCase());
  }
  // 'startsWith' operator
  if (expr.includes(' startsWith ')) {
    const idx = expr.indexOf(' startsWith ');
    const left = stripQuotes(expr.slice(0, idx));
    const right = stripQuotes(expr.slice(idx + 12));
    return left.startsWith(right);
  }
  // != operator
  if (expr.includes('!=')) {
    const [left, right] = expr.split('!=', 2);
    return stripQuotes(left) !== stripQuotes(right);
  }
  // == operator
  if (expr.includes('==')) {
    const [left, right] = expr.split('==', 2);
    return stripQuotes(left) === stripQuotes(right);
  }
  // > and < for numeric comparison
  if (expr.includes('>')) {
    const [left, right] = expr.split('>', 2);
    return Number(stripQuotes(left)) > Number(stripQuotes(right));
  }
  if (expr.includes('<')) {
    const [left, right] = expr.split('<', 2);
    return Number(stripQuotes(left)) < Number(stripQuotes(right));
  }

  // Truthy: non-empty, non-null string
  return expr !== '' && expr !== 'undefined' && expr !== 'null' && expr !== '0';
}

// ─── Output Parser ──────────────────────────────────────────────────
//
// Extracts structured data from agent output. When outputs: 'json',
// finds JSON in the response and parses it. Parsed fields become
// accessible via ${{ steps.X.outputs.key }} in downstream steps.

function parseStepOutputs(output: string): Record<string, any> {
  // Try to find a JSON object in the output
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  // Try parsing the entire trimmed output as JSON
  try { return JSON.parse(output.trim()); } catch {}
  return {};
}


// Resolve step prompt: load from file if prompt_file is set, otherwise use inline prompt
async function resolvePrompt(stepDef: StepDef): Promise<string> {
  if (stepDef.prompt_file) {
    try {
      const filePath = join(STAGES_DIR, stepDef.prompt_file);
      const resolvedPath = resolve(filePath);
      const resolvedDir = resolve(STAGES_DIR);
      if (!resolvedPath.startsWith(resolvedDir + sep)) {
        throw new Error('Invalid stage file path');
      }
      return await readFile(filePath, 'utf-8');
    } catch (e: any) {
      console.error(`Failed to load stage file "${stepDef.prompt_file}":`, e.message);
      if (stepDef.prompt) return stepDef.prompt;
      throw new Error(`Stage file "${stepDef.prompt_file}" not found and no inline prompt`);
    }
  }
  return stepDef.prompt || '';
}

// List available stage files
export async function getStageFiles(): Promise<string[]> {
  try {
    await mkdir(STAGES_DIR, { recursive: true });
    const files = await readdir(STAGES_DIR);
    return files.filter(f => f.endsWith('.md'));
  } catch { return []; }
}

// Read a stage file
export async function getStageFile(name: string): Promise<string> {
  return readFile(join(STAGES_DIR, name), 'utf-8');
}

// Save a stage file
export async function saveStageFile(name: string, content: string): Promise<void> {
  await mkdir(STAGES_DIR, { recursive: true });
  await writeFile(join(STAGES_DIR, name), content, 'utf-8');
}

export async function deleteStageFile(name: string): Promise<void> {
  await unlink(join(STAGES_DIR, name));
}

// ─── DAG Execution ──────────────────────────────────────────────────

function topologicalOrder(steps: StepDef[]): StepDef[][] {
  // Collect step IDs that are on_fail targets — they run inline, not in the DAG
  const fallbackIds = new Set(steps.map(s => s.on_fail).filter(Boolean) as string[]);
  const dagSteps = steps.filter(s => !fallbackIds.has(s.id));

  const remaining = new Map(dagSteps.map(s => [s.id, s]));
  const completed = new Set<string>();
  const layers: StepDef[][] = [];
  while (remaining.size > 0) {
    const ready: StepDef[] = [];
    for (const [, step] of remaining) {
      if ((step.needs || []).every(d => completed.has(d))) ready.push(step);
    }
    if (ready.length === 0) break; // circular
    layers.push(ready);
    for (const s of ready) { remaining.delete(s.id); completed.add(s.id); }
  }
  return layers;
}

// ─── Review Loop ────────────────────────────────────────────────────
//
// After a step produces output, spawn a short-lived reviewer agent that
// evaluates the output against criteria. Returns pass/fail + feedback.
// On failure, feedback is sent to the ORIGINAL agent (which has full
// conversation context) for revision. This naturally converges because
// the agent learns from each attempt.

async function reviewOutput(
  output: string,
  criteria: string,
  stepName: string,
  attempt: number,
  model: string,
): Promise<{ pass: boolean; feedback: string }> {
  const reviewerName = `reviewer-${Date.now().toString(36)}`;
  try {
    await createHeadlessAgent(reviewerName, {
      model: 'claude-haiku-4.5',
      reasoningEffort: 'low',
      systemPrompt: 'You are a quality reviewer. Evaluate output against criteria. Respond with EXACTLY this JSON format and nothing else: {"pass": true/false, "feedback": "brief explanation"}',
    });
    const reviewPrompt = `Evaluate this output from step "${stepName}" (attempt ${attempt}):\n\n---OUTPUT---\n${output.slice(0, 4000)}\n---END---\n\nCriteria: ${criteria}\n\nRespond with JSON only: {"pass": true/false, "feedback": "..."}`;
    const result = await sendToHeadless(reviewerName, reviewPrompt, { timeoutMs: 30_000 });
    // Parse JSON from response
    const jsonMatch = result.response.match(/\{[\s\S]*"pass"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { pass: !!parsed.pass, feedback: parsed.feedback || '' };
    }
    // If can't parse, assume pass (don't block on reviewer failure)
    return { pass: true, feedback: 'Review completed (could not parse verdict)' };
  } catch {
    return { pass: true, feedback: 'Review skipped (reviewer error)' };
  } finally {
    try { await destroyHeadlessAgent(reviewerName); } catch {}
  }
}

// ─── Step Execution Context ─────────────────────────────────────────
//
// Shared context passed to executeStep so it can manage agents, sessions,
// and step results the same way for both initial runs and reruns.

interface StepExecContext {
  run: WorkflowRun;
  def: WorkflowDef;
  inputs: Record<string, string>;
  stepResults: Record<string, StepResult>;
  runAgents: string[];
  sharedSessions: Map<string, string>;
  targetedAgents: Set<string>;
}

// ─── Execute a Single Step ──────────────────────────────────────────

async function executeStep(stepDef: StepDef, ctx: StepExecContext): Promise<void> {
  const { run, def, inputs, stepResults, runAgents, sharedSessions, targetedAgents } = ctx;
  const runId = run.runId;

  const stepResult = run.steps.find(s => s.id === stepDef.id)!;
  const agentName = `wf-${runId}-${stepDef.id}`;
  stepResult.agentName = agentName;
  const interpCtx = { inputs, steps: stepResults };

  // ── Conditional: evaluate if expression ──
  if (stepDef.if) {
    const shouldRun = evaluateCondition(stepDef.if, interpCtx);
    if (!shouldRun) {
      stepResult.status = 'skipped';
      stepResult.output = `Condition not met: ${stepDef.if}`;
      stepResult.finishedAt = new Date().toISOString();
      stepResults[stepDef.id] = stepResult;
      broadcast(run);
      return;
    }
  }

  // ── Gate step: pause for human approval ──
  if (stepDef.type === 'gate') {
    stepResult.status = 'waiting';
    stepResult.output = interpolate(stepDef.prompt || '', interpCtx);
    run.status = 'waiting';
    broadcast(run);

    const approved = await new Promise<boolean>((resolve) => {
      gateResolvers.set(`${runId}:${stepDef.id}`, (ok, feedback) => {
        if (feedback) stepResult.output += `\n\nHuman feedback: ${feedback}`;
        resolve(ok);
      });
    });
    gateResolvers.delete(`${runId}:${stepDef.id}`);

    if (!approved) {
      stepResult.status = 'failed';
      stepResult.error = 'Rejected by human';
      stepResult.finishedAt = new Date().toISOString();
      stepResults[stepDef.id] = stepResult;
      run.status = 'running';
      if (!stepDef.continue_on_fail) throw new Error(`Gate "${stepDef.id}" rejected`);
      broadcast(run);
      return;
    }

    stepResult.status = 'complete';
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    run.status = 'running';
    broadcast(run);
    return;
  }

  // ── HTTP step: make an HTTP request ──
  if (stepDef.type === 'http' && stepDef.http) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const cfg = stepDef.http;
      const url = interpolate(cfg.url, interpCtx);
      const method = (cfg.method || 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (cfg.headers) {
        for (const [k, v] of Object.entries(cfg.headers)) headers[k] = interpolate(v, interpCtx);
      }
      const body = cfg.body ? interpolate(cfg.body, interpCtx) : undefined;
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout((stepDef.timeout || 30) * 1000) });
      const text = await res.text();
      stepResult.output = text;
      if (stepDef.outputs) stepResult.outputs = parseStepOutputs(text);
      stepResult.status = res.ok ? 'complete' : 'failed';
      if (!res.ok) stepResult.error = `HTTP ${res.status} ${res.statusText}`;
    } catch (e: any) {
      stepResult.status = 'failed';
      stepResult.error = e.message;
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── Shell step: run a command ──
  if (stepDef.type === 'shell' && stepDef.shell) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const command = interpolate(stepDef.shell.command, interpCtx);
      const cwd = stepDef.shell.cwd ? interpolate(stepDef.shell.cwd, interpCtx) : process.cwd();
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: (stepDef.timeout || 120) * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stepResult.output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
      if (stepDef.outputs) stepResult.outputs = parseStepOutputs(stepResult.output);
      stepResult.status = 'complete';
    } catch (e: any) {
      stepResult.output = e.stdout || '';
      stepResult.error = e.stderr || e.message;
      stepResult.status = 'failed';
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── File-read step ──
  if (stepDef.type === 'file-read' && stepDef.file_read) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const filePath = interpolate(stepDef.file_read.path, interpCtx);
      stepResult.output = await readFile(filePath, 'utf-8');
      if (stepDef.outputs) stepResult.outputs = parseStepOutputs(stepResult.output);
      stepResult.status = 'complete';
    } catch (e: any) {
      stepResult.status = 'failed';
      stepResult.error = e.message;
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── File-write step (produces artifact) ──
  if (stepDef.type === 'file-write' && stepDef.file_write) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const filePath = interpolate(stepDef.file_write.path, interpCtx);
      const content = interpolate(stepDef.file_write.content, interpCtx);
      const artifactDir = join(ARTIFACTS_DIR, run.runId, stepDef.id);
      await mkdir(artifactDir, { recursive: true });
      const destPath = join(artifactDir, basename(filePath));
      await writeFile(destPath, content, 'utf-8');
      const fileStat = await stat(destPath);
      stepResult.artifacts = [{ name: basename(filePath), path: destPath, size: fileStat.size }];
      stepResult.output = `Wrote ${fileStat.size} bytes to ${basename(filePath)}`;
      stepResult.status = 'complete';
    } catch (e: any) {
      stepResult.status = 'failed';
      stepResult.error = e.message;
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── Sub-workflow step ──
  if (stepDef.type === 'workflow' && stepDef.workflow) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const subInputs: Record<string, string> = {};
      if (stepDef.workflow.inputs) {
        for (const [k, v] of Object.entries(stepDef.workflow.inputs)) {
          subInputs[k] = interpolate(v, interpCtx);
        }
      }
      const subRun = await executeWorkflow(stepDef.workflow.id, subInputs);
      // Collect all sub-workflow step outputs into this step's output
      const subOutputs: Record<string, any> = {};
      for (const s of subRun.steps) {
        if (s.outputs) Object.assign(subOutputs, s.outputs);
      }
      stepResult.output = subRun.steps.map(s => `[${s.id}] ${s.output}`).join('\n\n');
      stepResult.outputs = subOutputs;
      stepResult.status = subRun.status === 'complete' ? 'complete' : 'failed';
      if (subRun.status !== 'complete') stepResult.error = subRun.error || 'Sub-workflow failed';
    } catch (e: any) {
      stepResult.status = 'failed';
      stepResult.error = e.message;
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── Foreach step: iterate over items ──
  if (stepDef.type === 'foreach' && stepDef.foreach) {
    stepResult.status = 'running';
    stepResult.startedAt = new Date().toISOString();
    broadcast(run);
    try {
      const itemsRaw = interpolate(stepDef.foreach.items, interpCtx);
      let items: any[];
      try { items = JSON.parse(itemsRaw); } catch { items = itemsRaw.split('\n').filter(Boolean); }
      const maxItems = stepDef.foreach.max_items || 50;
      items = items.slice(0, maxItems);
      const varName = stepDef.foreach.as || 'item';
      const allOutputs: string[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = typeof items[i] === 'string' ? items[i] : JSON.stringify(items[i]);
        // Create a sub-context with the loop variable injected as an input
        const loopInputs = { ...inputs, [varName]: item, [`${varName}_index`]: String(i) };
        const loopInterpCtx = { inputs: loopInputs, steps: stepResults };
        const bodyDef = { ...stepDef.foreach.step, id: `${stepDef.id}-${i}` };

        // Create a synthetic step result for the body
        const bodyResult: StepResult = {
          id: bodyDef.id, name: `${stepDef.name || stepDef.id} [${i}]`,
          status: 'pending', output: '', iteration: 0, iterations: [],
        };
        run.steps.push(bodyResult);
        broadcast(run);

        // Execute the body step
        const bodyCtx: StepExecContext = {
          run, def, inputs: loopInputs, stepResults, runAgents, sharedSessions, targetedAgents,
        };
        // Override the prompt with loop context
        const origPrompt = bodyDef.prompt || '';
        bodyDef.prompt = interpolate(origPrompt, loopInterpCtx);
        await executeStep(bodyDef, bodyCtx);

        const executed = run.steps.find(s => s.id === bodyDef.id);
        if (executed) allOutputs.push(executed.output);
      }

      stepResult.output = allOutputs.join('\n---\n');
      if (stepDef.outputs) stepResult.outputs = parseStepOutputs(stepResult.output);
      stepResult.status = 'complete';
    } catch (e: any) {
      stepResult.status = 'failed';
      stepResult.error = e.message;
      if (!stepDef.continue_on_fail) throw e;
    }
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);
    return;
  }

  // ── Normal step: spawn agent, prompt, review-loop, with retry ──
  const maxAttempts = stepDef.retry || 1;
  const retryDelay = (stepDef.retry_delay || 2) * 1000;
  let lastError: Error | null = null;

  for (let retryAttempt = 1; retryAttempt <= maxAttempts; retryAttempt++) {
    stepResult.status = 'running';
    stepResult.startedAt = stepResult.startedAt || new Date().toISOString();
    if (retryAttempt > 1) stepResult.retries = retryAttempt - 1;
    broadcast(run);

    try {
      const rawPrompt = await resolvePrompt(stepDef);
      const prompt = interpolate(rawPrompt, interpCtx);
      const model = stepDef.agent?.model || 'claude-haiku-4.5';
      const timeout = (stepDef.timeout || 120) * 1000;

      let activeAgentName: string;
      const isTargeted = !!stepDef.target;
      const isShared = !!stepDef.session;

      if (isTargeted) {
        // ── Target mode: use an existing named agent (don't create or destroy) ──
        activeAgentName = stepDef.target!;
        stepResult.agentName = activeAgentName;
        targetedAgents.add(activeAgentName);
      } else if (isShared) {
        // ── Shared session: reuse agent if session group already has one ──
        const existingAgent = sharedSessions.get(stepDef.session!);
        if (existingAgent) {
          activeAgentName = existingAgent;
          stepResult.agentName = activeAgentName;
        } else {
          // First step in this session group — create the agent
          const sharedAgentName = `wf-${runId}-s-${stepDef.session}`;
          await createHeadlessAgent(sharedAgentName, {
            model,
            systemPrompt: stepDef.agent?.systemPrompt ||
              'You are a focused task agent. Complete the task concisely. Respond with your analysis/output directly.',
            source: 'workflow',
          });
          runAgents.push(sharedAgentName);
          sharedSessions.set(stepDef.session!, sharedAgentName);
          activeAgentName = sharedAgentName;
          stepResult.agentName = activeAgentName;
        }
      } else {
        // ── Default: fresh agent per step (with retry support) ──
        const retryAgentName = retryAttempt > 1 ? `${agentName}-r${retryAttempt}` : agentName;
        if (retryAttempt > 1) {
          try { await destroyHeadlessAgent(agentName); } catch {}
          stepResult.agentName = retryAgentName;
        }
        await createHeadlessAgent(retryAgentName, {
          model,
          systemPrompt: stepDef.agent?.systemPrompt ||
            'You are a focused task agent. Complete the task concisely. Respond with your analysis/output directly.',
          source: 'workflow',
        });
        runAgents.push(retryAgentName);
        activeAgentName = retryAgentName;
      }

      // Send initial prompt
      let result = await sendToHeadless(activeAgentName, prompt, { timeoutMs: timeout });
      let output = result.response || '';
      let totalTokens = result.outputTokens || 0;

      stepResult.iteration = 1;
      stepResult.iterations = [{
        attempt: 1, output, tokens: result.outputTokens,
      }];
      stepResult.output = output;
      stepResult.tokens = totalTokens;

      // ── Review loop (if review criteria defined) ──
      if (stepDef.review?.criteria) {
        const maxIter = stepDef.review.max_iterations || 3;

        for (let attempt = 1; attempt <= maxIter; attempt++) {
          stepResult.status = 'reviewing';
          broadcast(run);

          const review = await reviewOutput(
            output, stepDef.review.criteria, stepDef.name || stepDef.id, attempt, model,
          );

          stepResult.iterations[stepResult.iterations.length - 1].review = review;
          broadcast(run);

          if (review.pass) break;
          if (attempt === maxIter) break;

          stepResult.status = 'running';
          stepResult.iteration = attempt + 1;
          broadcast(run);

          const revisionPrompt =
            `Review feedback (attempt ${attempt}/${maxIter}):\n${review.feedback}\n\nPlease revise your previous output to address this feedback.`;
          result = await sendToHeadless(activeAgentName, revisionPrompt, { timeoutMs: timeout });
          output = result.response || '';
          totalTokens += result.outputTokens || 0;

          stepResult.iterations.push({
            attempt: attempt + 1, output, tokens: result.outputTokens,
          });
          stepResult.output = output;
          stepResult.tokens = totalTokens;
        }
      }

      // ── Parse outputs (if outputs defined) ──
      if (stepDef.outputs) {
        stepResult.outputs = parseStepOutputs(stepResult.output);
      }

      stepResult.status = 'complete';
      stepResult.finishedAt = new Date().toISOString();
      stepResults[stepDef.id] = stepResult;
      broadcast(run);
      lastError = null;
      break; // success — exit retry loop

    } catch (e: any) {
      lastError = e;
      if (retryAttempt < maxAttempts) {
        // Retry: wait then try again
        stepResult.output = `Attempt ${retryAttempt} failed: ${e.message}. Retrying...`;
        broadcast(run);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  // All retries exhausted or success
  if (lastError) {
    stepResult.status = 'failed';
    stepResult.error = lastError.message;
    stepResult.finishedAt = new Date().toISOString();
    stepResults[stepDef.id] = stepResult;
    broadcast(run);

    // ── on_fail: execute fallback step ──
    if (stepDef.on_fail) {
      const fallbackDef = def.steps.find(s => s.id === stepDef.on_fail);
      if (fallbackDef) {
        const fbResult = run.steps.find(s => s.id === fallbackDef.id);
        if (fbResult && fbResult.status === 'pending') {
          // Execute fallback inline (it gets the error context)
          fbResult.status = 'running';
          fbResult.startedAt = new Date().toISOString();
          const fbAgent = `wf-${run.runId}-${fallbackDef.id}`;
          fbResult.agentName = fbAgent;
          broadcast(run);
          try {
            const rawPrompt = await resolvePrompt(fallbackDef);
            const fbPrompt = interpolate(rawPrompt, interpCtx);
            await createHeadlessAgent(fbAgent, {
              model: fallbackDef.agent?.model || 'claude-haiku-4.5',
              systemPrompt: fallbackDef.agent?.systemPrompt ||
                'You are a fallback agent. The previous step failed. Complete the task with a simpler approach.',
              source: 'workflow',
            });
            runAgents.push(fbAgent);
            const fbRes = await sendToHeadless(fbAgent, fbPrompt, { timeoutMs: (fallbackDef.timeout || 120) * 1000 });
            fbResult.output = fbRes.response || '';
            fbResult.tokens = fbRes.outputTokens;
            fbResult.iteration = 1;
            fbResult.iterations = [{ attempt: 1, output: fbResult.output, tokens: fbRes.outputTokens }];
            if (fallbackDef.outputs) fbResult.outputs = parseStepOutputs(fbResult.output);
            fbResult.status = 'complete';
            fbResult.finishedAt = new Date().toISOString();
            stepResults[fallbackDef.id] = fbResult;
          } catch (fbErr: any) {
            fbResult.status = 'failed';
            fbResult.error = fbErr.message;
            fbResult.finishedAt = new Date().toISOString();
            stepResults[fallbackDef.id] = fbResult;
          }
          broadcast(run);
        }
      }
    }

    if (!stepDef.continue_on_fail) throw lastError;
  }
}

// ─── Execute Workflow ───────────────────────────────────────────────

export async function executeWorkflow(
  workflowId: string,
  inputs: Record<string, string> = {}
): Promise<WorkflowRun> {
  const def = workflows.get(workflowId);
  if (!def) throw new Error(`Workflow "${workflowId}" not found`);

  const runId = `run-${++runCounter}-${Date.now().toString(36)}`;
  const stepResults: Record<string, StepResult> = {};
  const runAgents: string[] = []; // track workflow-created agents for cleanup
  const sharedSessions: Map<string, string> = new Map(); // session group name → agent name
  const targetedAgents: Set<string> = new Set(); // agents we borrowed — don't destroy

  const run: WorkflowRun = {
    runId,
    workflowId,
    workflowName: def.name,
    status: 'running',
    inputs,
    steps: def.steps.map(s => ({
      id: s.id, name: s.name || s.id, status: 'pending' as StepStatus,
      output: '', agentName: `wf-${runId}-${s.id}`,
      iteration: 0, iterations: [],
    })),
    startedAt: new Date().toISOString(),
  };
  runs.set(runId, run);
  broadcast(run);
  pushEvent('workflow', `Run ${runId} started`, 'info', workflowId);

  const layers = topologicalOrder(def.steps);
  const execCtx: StepExecContext = { run, def, inputs, stepResults, runAgents, sharedSessions, targetedAgents };

  try {
    for (const layer of layers) {
      // Check for cancellation
      if (run.status === 'cancelled') break;

      // Check for pause — wait until resumed
      if (run.status as string === 'paused') {
        await new Promise<void>(resolve => { pauseResolvers.set(runId, resolve); });
        pauseResolvers.delete(runId);
        if ((run.status as string) === 'cancelled') break;
      }

      await Promise.all(layer.map(async (stepDef) => {
        if (run.status === 'cancelled') return;
        await executeStep(stepDef, execCtx);
      }));
    }

    run.status = 'complete';
    run.finishedAt = new Date().toISOString();
  } catch (e: any) {
    run.status = 'failed';
    run.error = e.message;
    run.finishedAt = new Date().toISOString();
    run.steps.forEach(s => { if (s.status === 'pending') s.status = 'skipped'; });
  } finally {
    // Keep agents alive for post-run interaction — schedule TTL cleanup
    const alive = new Set<string>();
    for (const name of runAgents) {
      if (targetedAgents.has(name)) continue;
      alive.add(name);
    }
    if (alive.size > 0) {
      persistentAgents.set(runId, alive);
      cleanupTimers.set(runId, setTimeout(() => cleanupRunAgents(runId), AGENT_TTL_MS));
    }
  }

  broadcast(run);
  pushEvent('workflow', `Run ${runId} ${run.status}`, 'info', workflowId);
  return run;
}

// ─── Rerun From Step ────────────────────────────────────────────────
//
// Re-execute a workflow from a specific step forward. All downstream
// dependents are reset and re-run. Upstream steps retain their results.
// Optionally sends feedback to the step's agent before re-execution.

export async function rerunFromStep(
  runId: string,
  stepId: string,
  feedback?: string,
): Promise<WorkflowRun> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run "${runId}" not found`);
  if (run.status !== 'complete' && run.status !== 'failed') {
    throw new Error(`Run "${runId}" is still ${run.status} — can only rerun a complete or failed run`);
  }

  const targetStep = run.steps.find(s => s.id === stepId);
  if (!targetStep) throw new Error(`Step "${stepId}" not found in run "${runId}"`);
  if (targetStep.status !== 'complete' && targetStep.status !== 'failed') {
    throw new Error(`Step "${stepId}" is ${targetStep.status} — can only rerun a complete or failed step`);
  }

  const def = workflows.get(run.workflowId);
  if (!def) throw new Error(`Workflow "${run.workflowId}" no longer exists`);

  // ── Find all downstream steps (transitive dependents of stepId) ──
  const resetSet = new Set<string>([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of def.steps) {
      if (resetSet.has(s.id)) continue;
      if (s.needs?.some(dep => resetSet.has(dep))) {
        resetSet.add(s.id);
        changed = true;
      }
    }
  }

  // ── Send feedback to the step's agent if requested ──
  if (feedback && targetStep.agentName) {
    try {
      const result = await sendToHeadless(targetStep.agentName, feedback, { timeoutMs: 120_000 });
      targetStep.output = result.response || '';
      targetStep.tokens = (targetStep.tokens || 0) + (result.outputTokens || 0);
      targetStep.iterations.push({
        attempt: targetStep.iterations.length + 1,
        output: targetStep.output,
        tokens: result.outputTokens,
      });
      // Update parsed outputs if applicable
      const stepDef = def.steps.find(s => s.id === stepId);
      if (stepDef?.outputs) {
        targetStep.outputs = parseStepOutputs(targetStep.output);
      }
    } catch {
      // Agent may be gone — that's fine, we'll create a fresh one during re-execution
    }
  }

  // ── Reset target + downstream steps to pending ──
  for (const step of run.steps) {
    if (resetSet.has(step.id)) {
      step.status = 'pending';
      step.output = '';
      step.error = undefined;
      step.startedAt = undefined;
      step.finishedAt = undefined;
      step.iteration = 0;
      step.iterations = [];
      step.tokens = undefined;
      step.retries = undefined;
      step.outputs = undefined;
    }
  }

  // ── Build stepResults from already-complete steps ──
  const stepResults: Record<string, StepResult> = {};
  for (const step of run.steps) {
    if (step.status === 'complete' || step.status === 'skipped') {
      stepResults[step.id] = step;
    }
  }

  // ── Set run back to running ──
  run.status = 'running';
  run.error = undefined;
  run.finishedAt = undefined;
  broadcast(run);
  pushEvent('workflow', `Rerun ${runId} from ${stepId}`, 'info', run.workflowId);

  // ── Re-execute from the target step forward ──
  const runAgents: string[] = [];
  const sharedSessions = new Map<string, string>();
  const targetedAgents = new Set<string>();
  const execCtx: StepExecContext = { run, def, inputs: run.inputs, stepResults, runAgents, sharedSessions, targetedAgents };

  const layers = topologicalOrder(def.steps);

  try {
    for (const layer of layers) {
      if ((run.status as string) === 'cancelled') break;

      // Only run steps that are pending (i.e. in the reset set)
      const pendingInLayer = layer.filter(s => resetSet.has(s.id));
      if (pendingInLayer.length === 0) continue;

      await Promise.all(pendingInLayer.map(async (stepDef) => {
        if ((run.status as string) === 'cancelled') return;
        await executeStep(stepDef, execCtx);
      }));
    }

    run.status = 'complete';
    run.finishedAt = new Date().toISOString();
  } catch (e: any) {
    run.status = 'failed';
    run.error = e.message;
    run.finishedAt = new Date().toISOString();
    run.steps.forEach(s => { if (s.status === 'pending') s.status = 'skipped'; });
  } finally {
    for (const name of runAgents) {
      if (targetedAgents.has(name)) continue;
      try { await destroyHeadlessAgent(name); } catch {}
    }
  }

  broadcast(run);
  pushEvent('workflow', `Rerun ${runId} ${run.status}`, 'info', run.workflowId);
  return run;
}

// ─── Gate Resolution (Human-in-the-Loop) ────────────────────────────

export function resolveGate(runId: string, stepId: string, approved: boolean, feedback?: string): boolean {
  const key = `${runId}:${stepId}`;
  const resolver = gateResolvers.get(key);
  if (!resolver) return false;
  resolver(approved, feedback);
  return true;
}

// ─── Run Management ─────────────────────────────────────────────────

export function getRuns(): WorkflowRun[] {
  return Array.from(runs.values()).sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

export function getRun(runId: string): WorkflowRun | undefined {
  return runs.get(runId);
}

export async function cancelRun(runId: string): Promise<boolean> {
  const run = runs.get(runId);
  if (!run || (run.status !== 'running' && run.status !== 'waiting' && run.status !== 'paused')) return false;
  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();
  run.steps.forEach(s => {
    if (s.status === 'pending') s.status = 'skipped';
    if (s.status === 'running' || s.status === 'reviewing' || s.status === 'waiting') {
      s.status = 'failed';
      s.error = 'Cancelled';
      if (s.agentName) destroyHeadlessAgent(s.agentName).catch(() => {});
    }
  });
  // Resolve any pending gates
  for (const [key, resolver] of gateResolvers) {
    if (key.startsWith(runId + ':')) {
      resolver(false, 'Run cancelled');
      gateResolvers.delete(key);
    }
  }
  // Resume if paused (so the execution loop exits)
  const pauseResolver = pauseResolvers.get(runId);
  if (pauseResolver) { pauseResolver(); pauseResolvers.delete(runId); }
  broadcast(run);
  return true;
}

// ─── Pause / Resume ─────────────────────────────────────────────────

export function pauseRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'paused';
  broadcast(run);
  pushEvent('workflow', `Run ${runId} paused`, 'info', run.workflowId);
  return true;
}

export function resumeRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'paused') return false;
  run.status = 'running';
  broadcast(run);
  const resolver = pauseResolvers.get(runId);
  if (resolver) { resolver(); pauseResolvers.delete(runId); }
  pushEvent('workflow', `Run ${runId} resumed`, 'info', run.workflowId);
  return true;
}

// ─── Agent Promotion ────────────────────────────────────────────────

export async function promoteStepAgent(
  runId: string,
  stepId: string,
  newName?: string,
): Promise<{ agentName: string; promoted: boolean }> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run "${runId}" not found`);
  const step = run.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found`);
  if (!step.agentName) throw new Error(`Step "${stepId}" has no agent`);

  const alive = persistentAgents.get(runId);
  if (!alive?.has(step.agentName)) {
    throw new Error(`Agent "${step.agentName}" is no longer alive`);
  }

  // Remove from workflow cleanup — agent now lives independently
  alive.delete(step.agentName);
  if (alive.size === 0) {
    persistentAgents.delete(runId);
    const timer = cleanupTimers.get(runId);
    if (timer) clearTimeout(timer);
    cleanupTimers.delete(runId);
  }

  // Rename if requested (the headless agent system tracks by name)
  const finalName = newName || step.agentName;
  pushEvent('workflow', `Agent ${step.agentName} promoted to permanent agent "${finalName}"`, 'info', run.workflowId);
  return { agentName: finalName, promoted: true };
}

// ─── Chat With Step Agent ───────────────────────────────────────────

export async function chatWithStepAgent(
  runId: string,
  stepId: string,
  message: string,
): Promise<{ response: string; tokens?: number }> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run "${runId}" not found`);

  const step = run.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in run "${runId}"`);
  if (!step.agentName) throw new Error(`Step "${stepId}" has no agent`);

  // Check if agent is still alive (in persistent set or in an active run)
  const alive = persistentAgents.get(runId);
  const isRunning = run.status === 'running' || run.status === 'paused' || run.status === 'waiting';
  if (!isRunning && (!alive || !alive.has(step.agentName))) {
    throw new Error(`Agent "${step.agentName}" is no longer alive — it was cleaned up after the TTL expired`);
  }

  // Reset TTL timer on interaction
  if (alive) {
    const timer = cleanupTimers.get(runId);
    if (timer) clearTimeout(timer);
    cleanupTimers.set(runId, setTimeout(() => cleanupRunAgents(runId), AGENT_TTL_MS));
  }

  const result = await sendToHeadless(step.agentName, message, { timeoutMs: 120_000 });
  const response = result.response || '';

  // Record in step iterations for audit trail
  step.iterations.push({
    attempt: step.iterations.length + 1,
    output: response,
    tokens: result.outputTokens,
  });
  step.tokens = (step.tokens || 0) + (result.outputTokens || 0);
  broadcast(run);

  return { response, tokens: result.outputTokens };
}

// ─── Rerun Single Step (No Cascade) ─────────────────────────────────

export async function rerunSingleStep(
  runId: string,
  stepId: string,
  feedback?: string,
): Promise<WorkflowRun> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run "${runId}" not found`);
  if (run.status !== 'complete' && run.status !== 'failed') {
    throw new Error(`Run "${runId}" is still ${run.status} — can only rerun a complete or failed run`);
  }

  const targetStep = run.steps.find(s => s.id === stepId);
  if (!targetStep) throw new Error(`Step "${stepId}" not found in run "${runId}"`);

  const def = workflows.get(run.workflowId);
  if (!def) throw new Error(`Workflow "${run.workflowId}" no longer exists`);
  const stepDef = def.steps.find(s => s.id === stepId)!;

  // Try to send feedback to existing agent first
  if (feedback && targetStep.agentName) {
    const alive = persistentAgents.get(runId);
    if (alive?.has(targetStep.agentName)) {
      try {
        const result = await sendToHeadless(targetStep.agentName, feedback, { timeoutMs: 120_000 });
        targetStep.output = result.response || '';
        targetStep.tokens = (targetStep.tokens || 0) + (result.outputTokens || 0);
        targetStep.iterations.push({
          attempt: targetStep.iterations.length + 1,
          output: targetStep.output,
          tokens: result.outputTokens,
        });
        if (stepDef.outputs) targetStep.outputs = parseStepOutputs(targetStep.output);
        broadcast(run);
        return run;
      } catch {
        // Agent gone — fall through to fresh re-execution
      }
    }
  }

  // Reset just this step
  targetStep.status = 'pending';
  targetStep.output = '';
  targetStep.error = undefined;
  targetStep.startedAt = undefined;
  targetStep.finishedAt = undefined;
  targetStep.iteration = 0;
  targetStep.iterations = [];
  targetStep.tokens = undefined;
  targetStep.retries = undefined;
  targetStep.outputs = undefined;

  // Build context from all other completed steps
  const stepResults: Record<string, StepResult> = {};
  for (const step of run.steps) {
    if (step.id !== stepId && (step.status === 'complete' || step.status === 'skipped')) {
      stepResults[step.id] = step;
    }
  }

  run.status = 'running';
  run.error = undefined;
  run.finishedAt = undefined;
  broadcast(run);

  const runAgents: string[] = [];
  const sharedSessions = new Map<string, string>();
  const targetedAgents = new Set<string>();
  const execCtx: StepExecContext = { run, def, inputs: run.inputs, stepResults, runAgents, sharedSessions, targetedAgents };

  try {
    await executeStep(stepDef, execCtx);
    run.status = 'complete';
    run.finishedAt = new Date().toISOString();
  } catch (e: any) {
    run.status = 'failed';
    run.error = e.message;
    run.finishedAt = new Date().toISOString();
  } finally {
    // Keep new agents alive too
    const alive = persistentAgents.get(runId) || new Set<string>();
    for (const name of runAgents) {
      if (!targetedAgents.has(name)) alive.add(name);
    }
    if (alive.size > 0) {
      persistentAgents.set(runId, alive);
      const timer = cleanupTimers.get(runId);
      if (timer) clearTimeout(timer);
      cleanupTimers.set(runId, setTimeout(() => cleanupRunAgents(runId), AGENT_TTL_MS));
    }
  }

  broadcast(run);
  pushEvent('workflow', `Single rerun ${stepId} in ${runId}: ${run.status}`, 'info', run.workflowId);
  return run;
}

// ─── Agent Lifecycle ────────────────────────────────────────────────

async function cleanupRunAgents(runId: string) {
  const alive = persistentAgents.get(runId);
  if (!alive) return;
  for (const name of alive) {
    try { await destroyHeadlessAgent(name); } catch {}
  }
  persistentAgents.delete(runId);
  cleanupTimers.delete(runId);
}

export function getAliveAgents(runId: string): string[] {
  return Array.from(persistentAgents.get(runId) || []);
}

export async function cleanupAgentsNow(runId: string): Promise<void> {
  const timer = cleanupTimers.get(runId);
  if (timer) clearTimeout(timer);
  await cleanupRunAgents(runId);
}

// ─── Real-time Updates ──────────────────────────────────────────────

function broadcast(run: WorkflowRun) {
  for (const fn of runListeners) { try { fn(run); } catch {} }
  persistRun(run).catch(() => {}); // fire-and-forget disk write
}

export function addRunListener(fn: RunListener) { runListeners.add(fn); }
export function removeRunListener(fn: RunListener) { runListeners.delete(fn); }

// ─── Cron Scheduler ─────────────────────────────────────────────────
//
// Simple cron-style scheduler. Checks every 60s which workflows have
// a `schedule.cron` field and runs them when the cron matches.
// Supports: "minute hour day month weekday" (standard 5-field cron).

function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [
    date.getMinutes(),     // 0-59
    date.getHours(),       // 0-23
    date.getDate(),        // 1-31
    date.getMonth() + 1,   // 1-12
    date.getDay(),         // 0-6 (Sun=0)
  ];
  for (let i = 0; i < 5; i++) {
    if (!cronFieldMatches(parts[i], fields[i])) return false;
  }
  return true;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  // Handle */N (every N)
  if (field.startsWith('*/')) {
    const n = parseInt(field.slice(2), 10);
    return n > 0 && value % n === 0;
  }
  // Handle comma-separated values
  const values = field.split(',');
  for (const v of values) {
    // Handle ranges (e.g., 1-5)
    if (v.includes('-')) {
      const [lo, hi] = v.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(v, 10) === value) return true;
    }
  }
  return false;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(() => {
    const now = new Date();
    for (const def of workflows.values()) {
      if (!def.schedule?.cron || def.schedule.enabled === false) continue;
      if (cronMatches(def.schedule.cron, now)) {
        pushEvent('workflow', `Cron triggered: ${def.id}`, 'info', def.id);
        executeWorkflow(def.id, {}).catch(e => {
          console.error(`Scheduled run of ${def.id} failed:`, e.message);
        });
      }
    }
  }, 60_000); // check every minute
}

export function stopScheduler(): void {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}

// ─── Webhook Tokens ─────────────────────────────────────────────────

const webhookTokens = new Map<string, string>(); // token → workflowId

export function getWebhookTokens(): Map<string, string> { return webhookTokens; }

export function generateWebhookToken(workflowId: string): string {
  // Remove old token if exists
  for (const [token, id] of webhookTokens) {
    if (id === workflowId) { webhookTokens.delete(token); break; }
  }
  const token = randomBytes(24).toString('hex');
  webhookTokens.set(token, workflowId);
  // Store on the workflow def
  const def = workflows.get(workflowId);
  if (def) {
    if (!def.webhook) def.webhook = { enabled: true };
    def.webhook.token = token;
    def.webhook.enabled = true;
  }
  return token;
}

export function resolveWebhookToken(token: string): string | undefined {
  return webhookTokens.get(token);
}

export function disableWebhook(workflowId: string): void {
  for (const [token, id] of webhookTokens) {
    if (id === workflowId) { webhookTokens.delete(token); break; }
  }
  const def = workflows.get(workflowId);
  if (def?.webhook) def.webhook.enabled = false;
}

// Restore webhook tokens from loaded workflow defs
function restoreWebhookTokens(): void {
  for (const def of workflows.values()) {
    if (def.webhook?.token && def.webhook.enabled !== false) {
      webhookTokens.set(def.webhook.token, def.id);
    }
  }
}
