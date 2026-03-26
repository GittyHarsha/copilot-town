import { Router } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';

const router = Router();
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_STORE_PATH = join(HOME, '.copilot', 'session-store.db');

function getDb(): Database.Database | null {
  if (!existsSync(SESSION_STORE_PATH)) return null;
  try {
    return new Database(SESSION_STORE_PATH, { readonly: true });
  } catch {
    return null;
  }
}

// GET /api/conversations — list all sessions
router.get('/', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Session store not available' });

  try {
    const q = req.query.q as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    if (q && q.trim()) {
      // FTS search on search_index table
      const rows = db.prepare(
        `SELECT DISTINCT s.id, s.summary, s.branch, s.created_at, s.updated_at
         FROM search_index si
         JOIN sessions s ON si.session_id = s.id
         WHERE search_index MATCH ?
         ORDER BY s.updated_at DESC
         LIMIT ?`
      ).all(q.trim(), limit);
      res.json(rows);
    } else {
      const rows = db.prepare(
        `SELECT id, summary, branch, created_at, updated_at
         FROM sessions
         ORDER BY updated_at DESC
         LIMIT ?`
      ).all(limit);
      res.json(rows);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/conversations/:sessionId — returns conversation turns
router.get('/:sessionId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Session store not available' });

  try {
    const rows = db.prepare(
      `SELECT turn_index, user_message, assistant_response, timestamp
       FROM turns
       WHERE session_id = ?
       ORDER BY turn_index`
    ).all(req.params.sessionId);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// GET /api/conversations/:sessionId/summary — session summary
router.get('/:sessionId/summary', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Session store not available' });

  try {
    const row = db.prepare(
      `SELECT id, summary, branch, created_at, updated_at
       FROM sessions
       WHERE id = ?`
    ).get(req.params.sessionId);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

export default router;
