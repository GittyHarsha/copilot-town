import { Router } from 'express';
import { getRecentEvents } from '../services/events.js';

const router = Router();

router.get('/', (_req, res) => {
  try {
    const limit = parseInt(_req.query.limit as string) || 200;
    res.json(getRecentEvents(limit));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

export default router;
