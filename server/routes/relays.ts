import { Router } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const router = Router();

export interface RelayEntry {
  from: string;
  to: string;
  message: string;
  timestamp: string;
}

const DATA_DIR = join(process.cwd(), 'data');
const RELAY_FILE = join(DATA_DIR, 'relays.json');
const MAX_LOG = 500;

// Load persisted relays on startup
function loadRelays(): RelayEntry[] {
  try {
    return JSON.parse(readFileSync(RELAY_FILE, 'utf-8'));
  } catch { return []; }
}

function saveRelays() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RELAY_FILE, JSON.stringify(relayLog), 'utf-8');
  } catch (e) {
    console.error('Failed to persist relay log:', e);
  }
}

const relayLog: RelayEntry[] = loadRelays();

/** Record a relay in the log. Called from agents route. */
export function recordRelay(from: string, to: string, message: string) {
  relayLog.unshift({ from, to, message, timestamp: new Date().toISOString() });
  if (relayLog.length > MAX_LOG) relayLog.length = MAX_LOG;
  saveRelays();
}

// GET /api/relays?limit=50
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LOG);
  res.json(relayLog.slice(0, limit));
});

export default router;
