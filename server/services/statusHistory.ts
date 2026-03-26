import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Agent, AgentStatus } from './agents.js';

const DATA_DIR = join(
  process.env.COPILOT_TOWN_DATA_DIR || join(import.meta.dirname, '..', '..', 'data'),
);
const DB_PATH = join(DATA_DIR, 'status-history.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS status_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    old_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    pane_target TEXT,
    last_output_at TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sc_agent ON status_changes(agent);
  CREATE INDEX IF NOT EXISTS idx_sc_ts ON status_changes(timestamp);
  CREATE INDEX IF NOT EXISTS idx_hs_agent ON health_snapshots(agent);
`);

const insertChange = db.prepare(
  'INSERT INTO status_changes (agent, old_status, new_status, timestamp) VALUES (?, ?, ?, ?)'
);
const selectHistory = db.prepare(
  'SELECT * FROM status_changes WHERE agent = ? ORDER BY id DESC LIMIT ?'
);
const selectTimeline = db.prepare(
  'SELECT * FROM status_changes WHERE agent = ? AND timestamp >= ? ORDER BY id ASC'
);
const insertSnapshot = db.prepare(
  'INSERT INTO health_snapshots (agent, status, pane_target, last_output_at, timestamp) VALUES (?, ?, ?, ?, ?)'
);

export function recordStatusChange(agent: string, oldStatus: string, newStatus: string): void {
  insertChange.run(agent, oldStatus, newStatus, new Date().toISOString());
}

export function getStatusHistory(agent: string, limit = 100): any[] {
  return selectHistory.all(agent, limit);
}

export function getStatusTimeline(agent: string, since: string): any[] {
  return selectTimeline.all(agent, since);
}

export function recordHealthSnapshot(
  agent: string,
  status: string,
  paneTarget: string | null,
  lastOutputAt: string | null,
): void {
  insertSnapshot.run(agent, status, paneTarget, lastOutputAt, new Date().toISOString());
}

// --- Status change tracking (called from agents.ts) ---
const previousStatuses = new Map<string, AgentStatus>();

export function trackStatusChanges(agents: Agent[]): void {
  for (const agent of agents) {
    const prev = previousStatuses.get(agent.id);
    if (prev !== undefined && prev !== agent.status) {
      recordStatusChange(agent.id, prev, agent.status);
    }
    previousStatuses.set(agent.id, agent.status);
  }
}
