import { Router } from 'express';

const router = Router();

export interface RelayEntry {
  from: string;
  to: string;
  message: string;
  timestamp: string;
}

// In-memory relay log (newest first)
const relayLog: RelayEntry[] = [];
const MAX_LOG = 200;

/** Record a relay in the log. Called from agents route. */
export function recordRelay(from: string, to: string, message: string) {
  relayLog.unshift({ from, to, message, timestamp: new Date().toISOString() });
  if (relayLog.length > MAX_LOG) relayLog.length = MAX_LOG;
}

// GET /api/relays?limit=50
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LOG);
  res.json(relayLog.slice(0, limit));
});

export default router;
