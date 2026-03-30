import { Router } from 'express';
import {
  loadWorkflows, getWorkflows, getWorkflow, saveWorkflow,
  executeWorkflow, getRuns, getRun, cancelRun, resolveGate,
} from '../services/workflows.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

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

export default router;
