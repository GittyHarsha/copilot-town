import { Router } from 'express';
import { getStatusHistory, getStatusTimeline } from '../services/statusHistory.js';

const router = Router();

// GET /api/status-history/:agent — recent status changes
router.get('/:agent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const history = getStatusHistory(req.params.agent, limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status history' });
  }
});

// GET /api/status-history/:agent/timeline?since=2024-01-01 — timeline data for charts
router.get('/:agent/timeline', (req, res) => {
  try {
    const since = (req.query.since as string) ||
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const timeline = getStatusTimeline(req.params.agent, since);
    res.json(timeline);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status timeline' });
  }
});

export default router;
