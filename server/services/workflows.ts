import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { createHeadlessAgent, sendToHeadless, destroyHeadlessAgent } from './headless.js';
import { pushEvent } from './events.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkflowDef {
  id: string;           // filename sans .yaml
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
  agent?: { model?: string; systemPrompt?: string };
  prompt: string;
  timeout?: number;     // seconds, default 120
}

export type StepStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

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
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  inputs: Record<string, string>;
  steps: StepResult[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

type RunListener = (run: WorkflowRun) => void;

// ─── State ───────────────────────────────────────────────────────────

const WORKFLOWS_DIR = join(process.cwd(), 'data', 'workflows');
const workflows = new Map<string, WorkflowDef>();
const runs = new Map<string, WorkflowRun>();
const runListeners = new Set<RunListener>();
let runCounter = 0;

// ─── Loading ─────────────────────────────────────────────────────────

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
        // Ensure every step has an id and needs is an array
        def.steps.forEach((s, i) => {
          if (!s.id) s.id = `step-${i}`;
          if (s.needs && !Array.isArray(s.needs)) s.needs = [s.needs];
        });
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
  def.steps?.forEach((s, i) => {
    if (!s.id) s.id = `step-${i}`;
    if (s.needs && !Array.isArray(s.needs)) s.needs = [s.needs];
  });
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

// ─── DAG Execution ──────────────────────────────────────────────────

function topologicalOrder(steps: StepDef[]): StepDef[][] {
  const remaining = new Map(steps.map(s => [s.id, s]));
  const completed = new Set<string>();
  const layers: StepDef[][] = [];

  while (remaining.size > 0) {
    const ready: StepDef[] = [];
    for (const [id, step] of remaining) {
      const deps = step.needs || [];
      if (deps.every(d => completed.has(d))) ready.push(step);
    }
    if (ready.length === 0) {
      // Circular dependency — fail remaining
      break;
    }
    layers.push(ready);
    for (const s of ready) { remaining.delete(s.id); completed.add(s.id); }
  }
  return layers;
}

export async function executeWorkflow(
  workflowId: string,
  inputs: Record<string, string> = {}
): Promise<WorkflowRun> {
  const def = workflows.get(workflowId);
  if (!def) throw new Error(`Workflow "${workflowId}" not found`);

  const runId = `run-${++runCounter}-${Date.now().toString(36)}`;
  const stepResults: Record<string, StepResult> = {};

  const run: WorkflowRun = {
    runId,
    workflowId,
    workflowName: def.name,
    status: 'running',
    inputs,
    steps: def.steps.map(s => ({
      id: s.id, name: s.name || s.id, status: 'pending' as StepStatus,
      output: '', agentName: `wf-${runId}-${s.id}`,
    })),
    startedAt: new Date().toISOString(),
  };
  runs.set(runId, run);
  broadcast(run);
  pushEvent({ type: 'workflow', action: 'started', agent: workflowId, detail: `Run ${runId} started` });

  const layers = topologicalOrder(def.steps);

  try {
    for (const layer of layers) {
      // Execute all steps in this layer in parallel
      await Promise.all(layer.map(async (stepDef) => {
        const stepResult = run.steps.find(s => s.id === stepDef.id)!;
        const agentName = `wf-${runId}-${stepDef.id}`;
        stepResult.agentName = agentName;
        stepResult.status = 'running';
        stepResult.startedAt = new Date().toISOString();
        broadcast(run);

        try {
          // Interpolate prompt with context
          const prompt = interpolate(stepDef.prompt, { inputs, steps: stepResults });

          // Spawn headless agent for this step
          const model = stepDef.agent?.model || 'claude-sonnet-4';
          await createHeadlessAgent(agentName, {
            model,
            systemPrompt: stepDef.agent?.systemPrompt || 'You are a focused task agent. Complete the task concisely. Do NOT use tools unless the task requires file operations. Respond with your analysis/output directly.',
          });

          // Send prompt and wait for response
          const timeout = (stepDef.timeout || 120) * 1000;
          const result = await sendToHeadless(agentName, prompt, { timeoutMs: timeout });

          stepResult.output = result.response || '';
          stepResult.tokens = result.outputTokens;
          stepResult.status = 'complete';
          stepResult.finishedAt = new Date().toISOString();
          stepResults[stepDef.id] = stepResult;
        } catch (e: any) {
          stepResult.status = 'failed';
          stepResult.error = e.message;
          stepResult.finishedAt = new Date().toISOString();
          stepResults[stepDef.id] = stepResult;
          throw e; // Propagate to fail the run
        } finally {
          // Clean up agent
          try { await destroyHeadlessAgent(agentName); } catch {}
          broadcast(run);
        }
      }));
    }

    run.status = 'complete';
    run.finishedAt = new Date().toISOString();
  } catch (e: any) {
    run.status = 'failed';
    run.error = e.message;
    run.finishedAt = new Date().toISOString();
    // Mark remaining pending steps as skipped
    run.steps.forEach(s => { if (s.status === 'pending') s.status = 'skipped'; });
  }

  broadcast(run);
  pushEvent({ type: 'workflow', action: run.status, agent: workflowId, detail: `Run ${runId} ${run.status}` });
  return run;
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
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();
  run.steps.forEach(s => {
    if (s.status === 'pending') s.status = 'skipped';
    if (s.status === 'running') {
      s.status = 'failed';
      s.error = 'Cancelled';
      // Try to destroy the agent
      if (s.agentName) destroyHeadlessAgent(s.agentName).catch(() => {});
    }
  });
  broadcast(run);
  return true;
}

// ─── Real-time Updates ──────────────────────────────────────────────

function broadcast(run: WorkflowRun) {
  for (const fn of runListeners) { try { fn(run); } catch {} }
}

export function addRunListener(fn: RunListener) { runListeners.add(fn); }
export function removeRunListener(fn: RunListener) { runListeners.delete(fn); }
