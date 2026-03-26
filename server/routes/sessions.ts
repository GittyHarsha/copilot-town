import { Router } from 'express';
import { getAllSessions, getSession, getSessionPlan, getSessionCheckpointContent, getOrphanedSessions } from '../services/sessions.js';

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

// Get single session
router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
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
