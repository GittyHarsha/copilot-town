import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { createHeadlessAgent, sendToHeadless, destroyHeadlessAgent } from './headless.js';
import { pushEvent } from './events.js';

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
}

export interface StepDef {
  id: string;
  name?: string;
  needs?: string[];
  type?: 'step' | 'gate';  // gate = pause for human approval
  agent?: { model?: string; systemPrompt?: string };
  prompt: string;
  prompt_file?: string;     // reference a .md file in data/stages/ instead of inline prompt
  timeout?: number;
  // Iterative review: after step completes, a reviewer evaluates output.
  // If it fails criteria, feedback is sent to the SAME agent for revision.
  review?: {
    criteria: string;       // what "good" looks like
    max_iterations?: number; // default 3
  };
}

export interface Iteration {
  attempt: number;
  output: string;
  review?: { pass: boolean; feedback: string };
  tokens?: number;
}

export type StepStatus = 'pending' | 'running' | 'reviewing' | 'waiting' | 'complete' | 'failed' | 'skipped';

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
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled';
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
const workflows = new Map<string, WorkflowDef>();
const runs = new Map<string, WorkflowRun>();
const runListeners = new Set<RunListener>();
// Gate resolution: runId:stepId → resolve function
const gateResolvers = new Map<string, (approved: boolean, feedback?: string) => void>();
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
  return Array.from(workflows.values());
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

// ─── Variable Interpolation ─────────────────────────────────────────

function interpolate(template: string, ctx: { inputs: Record<string, string>; steps: Record<string, StepResult> }): string {
  return template.replace(/\$\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    if (parts[0] === 'inputs' && parts[1]) return ctx.inputs[parts[1]] || '';
    if (parts[0] === 'steps' && parts[1] && parts[2] === 'output') {
      return ctx.steps[parts[1]]?.output || '';
    }
    return '';
  });
}

// Resolve step prompt: load from file if prompt_file is set, otherwise use inline prompt
async function resolvePrompt(stepDef: StepDef): Promise<string> {
  if (stepDef.prompt_file) {
    try {
      const filePath = join(STAGES_DIR, stepDef.prompt_file);
      return await readFile(filePath, 'utf-8');
    } catch (e: any) {
      console.error(`Failed to load stage file "${stepDef.prompt_file}":`, e.message);
      // Fall back to inline prompt if file fails
      if (stepDef.prompt) return stepDef.prompt;
      throw new Error(`Stage file "${stepDef.prompt_file}" not found and no inline prompt`);
    }
  }
  return stepDef.prompt;
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

// ─── DAG Execution ──────────────────────────────────────────────────

function topologicalOrder(steps: StepDef[]): StepDef[][] {
  const remaining = new Map(steps.map(s => [s.id, s]));
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
      model,
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

// ─── Execute Workflow ───────────────────────────────────────────────

export async function executeWorkflow(
  workflowId: string,
  inputs: Record<string, string> = {}
): Promise<WorkflowRun> {
  const def = workflows.get(workflowId);
  if (!def) throw new Error(`Workflow "${workflowId}" not found`);

  const runId = `run-${++runCounter}-${Date.now().toString(36)}`;
  const stepResults: Record<string, StepResult> = {};
  const runAgents: string[] = []; // track all agents for cleanup

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
  pushEvent({ type: 'workflow', action: 'started', agent: workflowId, detail: `Run ${runId}` });

  const layers = topologicalOrder(def.steps);

  try {
    for (const layer of layers) {
      // Check for cancellation
      if (run.status === 'cancelled') break;

      await Promise.all(layer.map(async (stepDef) => {
        if (run.status === 'cancelled') return;

        const stepResult = run.steps.find(s => s.id === stepDef.id)!;
        const agentName = `wf-${runId}-${stepDef.id}`;
        stepResult.agentName = agentName;

        // ── Gate step: pause for human approval ──
        if (stepDef.type === 'gate') {
          stepResult.status = 'waiting';
          // Interpolate the gate message for display
          stepResult.output = interpolate(stepDef.prompt, { inputs, steps: stepResults });
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
            run.status = 'running'; // briefly before failing
            throw new Error(`Gate "${stepDef.id}" rejected`);
          }

          stepResult.status = 'complete';
          stepResult.finishedAt = new Date().toISOString();
          stepResults[stepDef.id] = stepResult;
          run.status = 'running';
          broadcast(run);
          return;
        }

        // ── Normal step: spawn agent, prompt, optionally review-loop ──
        stepResult.status = 'running';
        stepResult.startedAt = new Date().toISOString();
        broadcast(run);

        try {
          const rawPrompt = await resolvePrompt(stepDef);
          const prompt = interpolate(rawPrompt, { inputs, steps: stepResults });
          const model = stepDef.agent?.model || 'claude-sonnet-4';
          const timeout = (stepDef.timeout || 120) * 1000;

          // Create persistent agent for this step
          await createHeadlessAgent(agentName, {
            model,
            systemPrompt: stepDef.agent?.systemPrompt ||
              'You are a focused task agent. Complete the task concisely. Respond with your analysis/output directly.',
          });
          runAgents.push(agentName);

          // Send initial prompt
          let result = await sendToHeadless(agentName, prompt, { timeoutMs: timeout });
          let output = result.response || '';
          let totalTokens = result.outputTokens || 0;

          stepResult.iteration = 1;
          stepResult.iterations.push({
            attempt: 1, output, tokens: result.outputTokens,
          });
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

              // Record review result on the current iteration
              stepResult.iterations[stepResult.iterations.length - 1].review = review;
              broadcast(run);

              if (review.pass) break; // quality met
              if (attempt === maxIter) break; // max attempts, accept as-is

              // Send feedback to the SAME agent — it has full context
              stepResult.status = 'running';
              stepResult.iteration = attempt + 1;
              broadcast(run);

              const revisionPrompt =
                `Review feedback (attempt ${attempt}/${maxIter}):\n${review.feedback}\n\nPlease revise your previous output to address this feedback.`;
              result = await sendToHeadless(agentName, revisionPrompt, { timeoutMs: timeout });
              output = result.response || '';
              totalTokens += result.outputTokens || 0;

              stepResult.iterations.push({
                attempt: attempt + 1, output, tokens: result.outputTokens,
              });
              stepResult.output = output;
              stepResult.tokens = totalTokens;
            }
          }

          stepResult.status = 'complete';
          stepResult.finishedAt = new Date().toISOString();
          stepResults[stepDef.id] = stepResult;
          broadcast(run);
        } catch (e: any) {
          stepResult.status = 'failed';
          stepResult.error = e.message;
          stepResult.finishedAt = new Date().toISOString();
          stepResults[stepDef.id] = stepResult;
          broadcast(run);
          throw e;
        }
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
    // Clean up ALL agents at end of run
    for (const name of runAgents) {
      try { await destroyHeadlessAgent(name); } catch {}
    }
  }

  broadcast(run);
  pushEvent({ type: 'workflow', action: run.status, agent: workflowId, detail: `Run ${runId} ${run.status}` });
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
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) return false;
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
  broadcast(run);
  return true;
}

// ─── Real-time Updates ──────────────────────────────────────────────

function broadcast(run: WorkflowRun) {
  for (const fn of runListeners) { try { fn(run); } catch {} }
}

export function addRunListener(fn: RunListener) { runListeners.add(fn); }
export function removeRunListener(fn: RunListener) { runListeners.delete(fn); }
