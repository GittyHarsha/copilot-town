import { Router } from 'express';
import {
  loadWorkflows, getWorkflows, getWorkflow, saveWorkflow, deleteWorkflow,
  executeWorkflow, getRuns, getRun, cancelRun, resolveGate, rerunFromStep,
  pauseRun, resumeRun, chatWithStepAgent, rerunSingleStep, getAliveAgents, cleanupAgentsNow,
  promoteStepAgent, generateWebhookToken, resolveWebhookToken, disableWebhook,
  getStageFiles, getStageFile, saveStageFile, deleteStageFile,
  type WorkflowRun,
} from '../services/workflows.js';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';

const router = Router();
const WORKFLOWS_DIR = join(process.cwd(), 'data', 'workflows');

// List workflow definitions
router.get('/', (_req, res) => {
  res.json(getWorkflows());
});

// Reload from disk
router.post('/reload', async (_req, res) => {
  const defs = await loadWorkflows();
  res.json({ count: defs.length, workflows: defs });
});

// Serve YAML reference doc (must be before /:id)
router.get('/reference', async (_req, res) => {
  try {
    const content = await readFile(join(WORKFLOWS_DIR, 'WORKFLOW_REFERENCE.md'), 'utf-8');
    res.json({ content });
  } catch {
    res.status(404).json({ error: 'Reference doc not found' });
  }
});

// Get single workflow definition
router.get('/:id', async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) return res.status(404).json({ error: 'Workflow not found' });
  // Also return raw YAML
  try {
    const yamlPath = join(WORKFLOWS_DIR, `${req.params.id}.yaml`);
    const raw = await readFile(yamlPath, 'utf-8');
    res.json({ ...def, yaml: raw });
  } catch {
    res.json(def);
  }
});

// Create / update workflow (body: { yaml: string })
router.post('/', async (req, res) => {
  try {
    const { id, yaml } = req.body;
    if (!id || !yaml) return res.status(400).json({ error: 'id and yaml required' });
    const def = await saveWorkflow(id, yaml);
    res.json(def);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a workflow
router.delete('/:id', async (req, res) => {
  try {
    await deleteWorkflow(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

// Execute a workflow
router.post('/:id/run', async (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) return res.status(404).json({ error: 'Workflow not found' });

  const inputs = req.body.inputs || {};

  // Validate required inputs
  if (def.inputs) {
    for (const [key, spec] of Object.entries(def.inputs)) {
      if (spec.required && !inputs[key]) {
        return res.status(400).json({ error: `Missing required input: ${key}` });
      }
      if (!inputs[key] && spec.default) inputs[key] = spec.default;
    }
  }

  // Start async — respond immediately with runId
  const run = {
    runId: `run-${Date.now().toString(36)}`,
    workflowId: req.params.id,
    workflowName: def.name,
    status: 'pending',
    startedAt: new Date().toISOString(),
  };

  // Execute in background
  executeWorkflow(req.params.id, inputs)
    .catch(e => console.error(`Workflow run failed:`, e.message));

  res.json({ ok: true, message: 'Workflow started', workflowId: req.params.id });
});

// List runs
router.get('/runs/list', (_req, res) => {
  res.json(getRuns());
});

// Get run details
router.get('/runs/:runId', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// Cancel run
router.delete('/runs/:runId', async (req, res) => {
  const ok = await cancelRun(req.params.runId);
  if (!ok) return res.status(404).json({ error: 'Run not found or not running' });
  res.json({ ok: true });
});

// Approve/reject a gate step
router.post('/runs/:runId/steps/:stepId/gate', (req, res) => {
  const { approved, feedback } = req.body;
  const ok = resolveGate(req.params.runId, req.params.stepId, !!approved, feedback);
  if (!ok) return res.status(404).json({ error: 'No pending gate found' });
  res.json({ ok: true });
});

// Rerun a workflow from a specific step
router.post('/runs/:runId/steps/:stepId/rerun', async (req, res) => {
  try {
    const { feedback } = req.body || {};
    const run = await rerunFromStep(req.params.runId, req.params.stepId, feedback);
    res.json({ success: true, run });
  } catch (e: any) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Rerun a single step without cascading downstream
router.post('/runs/:runId/steps/:stepId/rerun-single', async (req, res) => {
  try {
    const { feedback } = req.body || {};
    const run = await rerunSingleStep(req.params.runId, req.params.stepId, feedback);
    res.json({ success: true, run });
  } catch (e: any) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Chat with a step's agent (post-completion interaction)
router.post('/runs/:runId/steps/:stepId/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const result = await chatWithStepAgent(req.params.runId, req.params.stepId, message);
    res.json(result);
  } catch (e: any) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Pause a running workflow
router.post('/runs/:runId/pause', (_req, res) => {
  const ok = pauseRun(_req.params.runId);
  if (!ok) return res.status(400).json({ error: 'Run not found or not running' });
  res.json({ ok: true });
});

// Resume a paused workflow
router.post('/runs/:runId/resume', (_req, res) => {
  const ok = resumeRun(_req.params.runId);
  if (!ok) return res.status(400).json({ error: 'Run not found or not paused' });
  res.json({ ok: true });
});

// Get alive agents for a run
router.get('/runs/:runId/agents', (req, res) => {
  res.json({ agents: getAliveAgents(req.params.runId) });
});

// Force cleanup agents for a run
router.delete('/runs/:runId/agents', async (req, res) => {
  await cleanupAgentsNow(req.params.runId);
  res.json({ ok: true });
});

// Promote a step's agent to a permanent town agent
router.post('/runs/:runId/steps/:stepId/promote', async (req, res) => {
  try {
    const { name } = req.body || {};
    const result = await promoteStepAgent(req.params.runId, req.params.stepId, name);
    res.json(result);
  } catch (e: any) {
    const status = e.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

// Download a step artifact
router.get('/runs/:runId/steps/:stepId/artifacts/:name', async (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const step = run.steps.find(s => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const artifact = step.artifacts?.find(a => a.name === req.params.name);
  if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
  try {
    const fileStat = await stat(artifact.path);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
    res.setHeader('Content-Length', fileStat.size);
    createReadStream(artifact.path).pipe(res);
  } catch {
    res.status(404).json({ error: 'Artifact file missing from disk' });
  }
});

// Run analytics — aggregate stats for a workflow
router.get('/:id/analytics', (_req, res) => {
  const allRuns = getRuns().filter(r => r.workflowId === _req.params.id);
  if (allRuns.length === 0) return res.json({ runs: 0 });
  const completed = allRuns.filter(r => r.status === 'complete');
  const failed = allRuns.filter(r => r.status === 'failed');
  const totalTokens = allRuns.reduce((sum, r) =>
    sum + r.steps.reduce((s, step) => s + (step.tokens || 0), 0), 0);
  const durations = allRuns
    .filter(r => r.finishedAt)
    .map(r => new Date(r.finishedAt!).getTime() - new Date(r.startedAt).getTime());
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  res.json({
    runs: allRuns.length,
    completed: completed.length,
    failed: failed.length,
    successRate: allRuns.length > 0 ? Math.round((completed.length / allRuns.length) * 100) : 0,
    totalTokens,
    avgDurationMs: Math.round(avgDuration),
    recentRuns: allRuns.slice(0, 10).map(r => ({
      runId: r.runId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
      tokens: r.steps.reduce((s, step) => s + (step.tokens || 0), 0),
    })),
  });
});

// ─── Webhook Trigger ────────────────────────────────────────────────

// Generate a webhook token for a workflow
router.post('/:id/webhook', (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) return res.status(404).json({ error: 'Workflow not found' });
  const token = generateWebhookToken(req.params.id);
  res.json({ token, url: `/api/workflows/webhook/${token}` });
});

// Disable webhook for a workflow
router.delete('/:id/webhook', (req, res) => {
  const def = getWorkflow(req.params.id);
  if (!def) return res.status(404).json({ error: 'Workflow not found' });
  disableWebhook(req.params.id);
  res.json({ ok: true });
});

// Trigger workflow via webhook
router.post('/webhook/:token', async (req, res) => {
  const workflowId = resolveWebhookToken(req.params.token);
  if (!workflowId) return res.status(404).json({ error: 'Invalid webhook token' });
  const def = getWorkflow(workflowId);
  if (!def) return res.status(404).json({ error: 'Workflow not found' });

  const inputs = req.body.inputs || {};
  executeWorkflow(workflowId, inputs)
    .catch(e => console.error(`Webhook run of ${workflowId} failed:`, e.message));
  res.json({ ok: true, workflowId, message: 'Workflow triggered via webhook' });
});

// ─── Stage Files ────────────────────────────────────────────────────

// List stage files
router.get('/stages/list', async (_req, res) => {
  res.json(await getStageFiles());
});

// Read a stage file
router.get('/stages/:name', async (req, res) => {
  try {
    const content = await getStageFile(req.params.name);
    res.json({ name: req.params.name, content });
  } catch {
    res.status(404).json({ error: 'Stage file not found' });
  }
});

// Create/update a stage file
router.post('/stages', async (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'name and content required' });
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    await saveStageFile(fileName, content);
    res.json({ ok: true, name: fileName });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a stage file
router.delete('/stages/:name', async (req, res) => {
  try {
    await deleteStageFile(req.params.name);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

export default router;
