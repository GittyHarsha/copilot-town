import { Router } from 'express';
import {
  listSessions, listPanes, capturePane, sendKeys, sendEscape, createSession,
  splitPane, selectLayout, newWindow,
  killPane, killWindow, killSession, killServer,
  renameSession, renameWindow,
  selectPane, resizePane, zoomPane, swapPane,
  breakPane, joinPane, respawnPane,
  selectWindow, rotateWindow, listWindows,
  displayMessage, setOption, showOptions, hasSession,
  provisionPane, type ProvisionConfig,
} from '../services/psmux.js';

const router = Router();

// ── Provision config (in-memory, persists for server lifetime) ──
let provisionConfig: Partial<ProvisionConfig> = {
  maxPanesPerWindow: 4,
  defaultSession: 'town',
  defaultLayout: 'even-horizontal',
};

router.get('/provision-config', (_req, res) => {
  res.json(provisionConfig);
});

router.put('/provision-config', (req, res) => {
  const { maxPanesPerWindow, defaultSession, defaultLayout } = req.body;
  if (maxPanesPerWindow !== undefined) provisionConfig.maxPanesPerWindow = parseInt(maxPanesPerWindow) || 4;
  if (defaultSession) provisionConfig.defaultSession = defaultSession;
  if (defaultLayout) provisionConfig.defaultLayout = defaultLayout;
  res.json(provisionConfig);
});

// Provision a pane on demand (for manual testing / external tools)
router.post('/provision', (_req, res) => {
  try {
    const result = provisionPane(provisionConfig);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── List / Read ──

// List psmux sessions
router.get('/sessions', (_req, res) => {
  res.json(listSessions());
});

// Check if session exists
router.get('/sessions/:name/exists', (req, res) => {
  res.json({ exists: hasSession(req.params.name) });
});

// List panes (optionally filtered by session)
router.get('/panes', (req, res) => {
  const session = req.query.session as string | undefined;
  res.json(listPanes(session));
});

// List windows (optionally filtered by session)
router.get('/windows', (req, res) => {
  const session = req.query.session as string | undefined;
  res.json(listWindows(session));
});

// Capture pane output
router.get('/capture/:target', (req, res) => {
  const lines = parseInt(req.query.lines as string) || 50;
  const output = capturePane(req.params.target, lines);
  res.json({ target: req.params.target, output });
});

// Show global options
router.get('/options', (_req, res) => {
  res.json({ options: showOptions() });
});

// ── Create ──

// Send keys to a pane
router.post('/send-keys', (req, res) => {
  const { target, keys } = req.body;
  if (!target || !keys) return res.status(400).json({ error: 'target and keys required' });
  const success = sendKeys(target, keys);
  res.json({ success, target });
});

// Send escape key to a pane
router.post('/send-escape', (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: 'target required' });
  const success = sendEscape(target);
  res.json({ success, target });
});

// Create psmux session
router.post('/sessions', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const success = createSession(name);
  res.json({ success, name });
});

// Create new window in existing session
router.post('/windows', (req, res) => {
  const { session, name } = req.body;
  if (!session) return res.status(400).json({ error: 'session required' });
  const success = newWindow(session, name);
  res.json({ success, session });
});

// Split pane in session
router.post('/split', (req, res) => {
  const { session, vertical } = req.body;
  if (!session) return res.status(400).json({ error: 'session required' });
  const success = splitPane(session, vertical !== false);
  res.json({ success, session });
});

// Change layout of panes in a window
router.post('/layout', (req, res) => {
  const { target, layout } = req.body;
  if (!target || !layout) return res.status(400).json({ error: 'target and layout required' });
  const allowed = ['even-horizontal', 'even-vertical', 'tiled', 'main-horizontal', 'main-vertical'];
  if (!allowed.includes(layout)) return res.status(400).json({ error: `layout must be one of: ${allowed.join(', ')}` });
  const success = selectLayout(target, layout);
  res.json({ success, target, layout });
});

// ── Pane actions ──

// Select / focus a pane
router.post('/panes/:target/select', (req, res) => {
  try {
    selectPane(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Resize a pane
router.post('/panes/:target/resize', (req, res) => {
  const { direction, amount } = req.body;
  if (!direction || !['U', 'D', 'L', 'R'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be U, D, L, or R' });
  }
  const n = parseInt(amount) || 5;
  try {
    resizePane(req.params.target, direction, n);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle pane zoom
router.post('/panes/:target/zoom', (req, res) => {
  try {
    zoomPane(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Swap pane position
router.post('/panes/:target/swap', (req, res) => {
  const { direction } = req.body;
  if (!direction || !['U', 'D'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be U or D' });
  }
  try {
    swapPane(req.params.target, direction);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Break pane into its own window
router.post('/panes/:target/break', (req, res) => {
  try {
    breakPane(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Join a pane into another window
router.post('/panes/join', (req, res) => {
  const { source, target } = req.body;
  if (!source || !target) return res.status(400).json({ error: 'source and target required' });
  try {
    joinPane(source, target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Respawn (restart) a pane's shell
router.post('/panes/:target/respawn', (req, res) => {
  try {
    respawnPane(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Window actions ──

// Select / focus a window
router.post('/windows/:target/select', (req, res) => {
  try {
    selectWindow(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Rotate panes in a window
router.post('/windows/:target/rotate', (req, res) => {
  try {
    rotateWindow(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Rename (PUT) ──

// Rename a session
router.put('/sessions/:name', (req, res) => {
  const { name: newName } = req.body;
  if (!newName) return res.status(400).json({ error: 'name required in body' });
  try {
    renameSession(req.params.name, newName);
    res.json({ ok: true, oldName: req.params.name, newName });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Rename a window
router.put('/windows/:target', (req, res) => {
  const { name: newName } = req.body;
  if (!newName) return res.status(400).json({ error: 'name required in body' });
  try {
    renameWindow(req.params.target, newName);
    res.json({ ok: true, target: req.params.target, newName });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Delete ──

// Kill a pane
router.delete('/panes/:target', (req, res) => {
  try {
    killPane(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kill a window
router.delete('/windows/:target', (req, res) => {
  try {
    killWindow(req.params.target);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kill a session
router.delete('/sessions/:name', (req, res) => {
  try {
    killSession(req.params.name);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kill the entire psmux server
router.delete('/server', (_req, res) => {
  try {
    killServer();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Config ──

// Display message (query pane/window/session info with format strings)
router.post('/display-message', (req, res) => {
  const { target, format } = req.body;
  try {
    const result = displayMessage(target, format);
    res.json({ result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Set a psmux option
router.post('/options', (req, res) => {
  const { key, value, global } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  try {
    setOption(key, value, global !== false);
    res.json({ ok: true, key, value });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
