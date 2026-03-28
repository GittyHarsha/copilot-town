import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const router = Router();

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_FILE = join(HOME, '.copilot', 'agent-sessions.json');

function readSessionFile(): any {
  try {
    if (!existsSync(SESSION_FILE)) return { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {}, notes: {} };
    return JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {}, notes: {} };
  }
}

function writeSessionFile(data: any) {
  const dir = join(HOME, '.copilot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

// POST /api/notes — share a note (key-value)
router.post('/', (req, res) => {
  const { key, value, author } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'key and value required' });

  const data = readSessionFile();
  if (!data.notes) data.notes = {};
  data.notes[key] = {
    value,
    author: author || 'unknown',
    updatedAt: new Date().toISOString(),
  };
  writeSessionFile(data);
  res.json({ ok: true, key });
});

// GET /api/notes — get all notes or a specific one
router.get('/', (_req, res) => {
  const data = readSessionFile();
  res.json(data.notes || {});
});

router.get('/:key', (req, res) => {
  const data = readSessionFile();
  const note = (data.notes || {})[req.params.key];
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

// DELETE /api/notes/:key
router.delete('/:key', (req, res) => {
  const data = readSessionFile();
  if (!data.notes) return res.json({ ok: true });
  delete data.notes[req.params.key];
  writeSessionFile(data);
  res.json({ ok: true });
});

export default router;
