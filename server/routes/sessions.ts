import { Router } from 'express';
import { getAllSessions, getSession, getSessionPlan, getSessionCheckpointContent, getOrphanedSessions, registerSession } from '../services/sessions.js';

const router = Router();

// List all sessions
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const sessions = getAllSessions().slice(0, limit);
  res.json(sessions);
});

// Orphaned sessions
router.get('/orphaned', (_req, res) => {
  res.json(getOrphanedSessions());
});

// Enhanced session details — plan + all checkpoints in one call
router.get('/:id/details', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const plan = getSessionPlan(req.params.id);
  const checkpoints = session.checkpoints.map(cp => ({
    ...cp,
    content: getSessionCheckpointContent(req.params.id, cp.filename) || '',
  }));
  res.json({ session, plan, checkpoints });
});

// Get single session
router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Register a session as a named agent
router.post('/:id/register', (req, res) => {
  const { name } = req.body as { name?: string };
  const sessionId = req.params.id;
  const agentName = (name && name.trim()) ? name.trim() : `session-${sessionId.slice(0, 8)}`;
  try {
    registerSession(sessionId, agentName);
    res.json({ success: true, sessionId, name: agentName });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to register session' });
  }
});

// Get session plan
router.get('/:id/plan', (req, res) => {
  const plan = getSessionPlan(req.params.id);
  if (plan === null) return res.status(404).json({ error: 'No plan found' });
  res.json({ plan });
});

// Get checkpoint content
router.get('/:id/checkpoints/:filename', (req, res) => {
  const content = getSessionCheckpointContent(req.params.id, req.params.filename);
  if (content === null) return res.status(404).json({ error: 'Checkpoint not found' });
  res.json({ content });
});

export default router;
