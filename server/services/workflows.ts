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
  outputs?: Record<string, any>;  // parsed structured data from agent output
  retries?: number;               // retry attempts made
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
        const ctx = { inputs, steps: stepResults };

        // ── Conditional: evaluate if expression ──
        if (stepDef.if) {
          const shouldRun = evaluateCondition(stepDef.if, ctx);
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
          stepResult.output = interpolate(stepDef.prompt, ctx);
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
            const prompt = interpolate(rawPrompt, ctx);
            const model = stepDef.agent?.model || 'claude-sonnet-4';
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
                const fbAgent = `wf-${runId}-${fallbackDef.id}`;
                fbResult.agentName = fbAgent;
                broadcast(run);
                try {
                  const rawPrompt = await resolvePrompt(fallbackDef);
                  const fbPrompt = interpolate(rawPrompt, ctx);
                  await createHeadlessAgent(fbAgent, {
                    model: fallbackDef.agent?.model || 'claude-sonnet-4',
                    systemPrompt: fallbackDef.agent?.systemPrompt ||
                      'You are a fallback agent. The previous step failed. Complete the task with a simpler approach.',
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
    // Clean up workflow-created agents (skip targeted external agents)
    for (const name of runAgents) {
      if (targetedAgents.has(name)) continue;
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
