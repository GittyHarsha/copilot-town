import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { watch, existsSync } from 'fs';
import { URL, fileURLToPath } from 'url';
import { join, dirname } from 'path';
import agentRoutes from './routes/agents.js';
import psmuxRoutes from './routes/psmux.js';
import sessionRoutes from './routes/sessions.js';
import hierarchyRoutes from './routes/hierarchy.js';
import conversationRoutes from './routes/conversations.js';
import relayRoutes from './routes/relays.js';
import eventRoutes from './routes/events.js';
import statusHistoryRoutes from './routes/statusHistory.js';
import configRoutes from './routes/config.js';
import notesRoutes from './routes/notes.js';
import workflowRoutes from './routes/workflows.js';
import toolRoutes from './routes/tools.js';
import { getAllAgents, refreshAgents, loadAgentTemplates, invalidateAgentCache } from './services/agents.js';
import { listPanes, capturePane, sendKeys, sendEscape, getPaneDimensions, isMuxAvailable, getMuxBinary, renameWindow } from './services/psmux.js';
import { invalidateSessionCache } from './services/sessions.js';
import { setBroadcaster, type ActivityEvent } from './services/events.js';
import { startHealthMonitor, getHealthStatus } from './services/healthMonitor.js';
import { getAllAgentTasks } from './routes/agents.js';
import { listCopilotModels, listCopilotSessions, stopClient } from './services/copilot-sdk.js';
import { loadWorkflows, loadRuns, addRunListener, startScheduler } from './services/workflows.js';

const app = express();
const PORT = 3848;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/agents', agentRoutes);
app.use('/api/psmux', psmuxRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/towns', hierarchyRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/relays', relayRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/status-history', statusHistoryRoutes);
app.use('/api/config', configRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/tools', toolRoutes);

app.get('/api/templates',(_req, res) => {
  res.json(loadAgentTemplates());
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: PORT,
    agents: getHealthStatus(),
    mux: {
      available: isMuxAvailable(),
      binary: getMuxBinary(),
    },
  });
});

// Dynamic models from @github/copilot-sdk
app.get('/api/models', async (_req, res) => {
  try {
    const models = await listCopilotModels();
    res.json(models);
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to fetch models' });
  }
});

// SDK sessions — full list with metadata
app.get('/api/copilot-sessions', async (req, res) => {
  try {
    const sessions = await listCopilotSessions();
    const limit = parseInt(req.query.limit as string) || 50;
    // Return most recently modified first, limited
    const sorted = [...sessions].sort((a, b) =>
      new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime()
    );
    res.json(sorted.slice(0, limit));
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to fetch sessions' });
  }
});

// Serve built frontend if available (single-server mode)
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    maxAge: '1h',              // Cache static assets (they have content hashes)
    immutable: true,           // Vite-hashed files never change
  }));
  // SPA fallback — serve index.html for non-API, non-asset routes only
  app.get('*', (_req, res) => {
    if (_req.path.startsWith('/api') || _req.path.startsWith('/ws') || _req.path.startsWith('/assets')) {
      return res.status(404).end();
    }
    res.setHeader('Cache-Control', 'no-cache'); // index.html should never be cached
    res.sendFile(join(clientDist, 'index.html'));
  });
  console.log(`📦 Serving built frontend from ${clientDist}`);
}

// HTTP + WebSocket server
const server = createServer(app);

// --- WebSocket 1: Agent status broadcast (/ws/status) ---
const wssStatus = new WebSocketServer({ noServer: true });
let lastStatus = '';
let cachedAgents: ReturnType<typeof getAllAgents> = [];
let cachedPanes: ReturnType<typeof listPanes> = [];

async function buildAndBroadcast() {
  if (wssStatus.clients.size === 0) return;
  try {
    cachedAgents = await refreshAgents();
    // listPanes result is cached in psmux.ts — cheap to call again
    cachedPanes = listPanes();
    const tasks = getAllAgentTasks();
    const payload = JSON.stringify({
      type: 'status',
      timestamp: new Date().toISOString(),
      agents: cachedAgents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        pane: a.pane ? a.pane.target : null,
        task: tasks[a.id] || null,
      })),
      psmux: {
        totalPanes: cachedPanes.length,
        sessions: [...new Set(cachedPanes.map(p => p.sessionName))],
      },
    });
    if (payload === lastStatus) return; // nothing changed
    lastStatus = payload;
    for (const client of wssStatus.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }

    // Auto-title psmux windows to match agent names
    syncPaneTitles(cachedAgents);
  } catch (err) {
    console.error('Status broadcast error:', err);
  }
}

// Track which windows we've already titled to avoid repeated calls
const titledWindows = new Map<string, string>(); // windowTarget → agentName

function syncPaneTitles(agents: typeof cachedAgents) {
  for (const agent of agents) {
    if (!agent.pane?.target || agent.status === 'stopped') continue;
    const windowTarget = agent.pane.target.replace(/\.\d+$/, ''); // "town:0.1" → "town:0"
    if (titledWindows.get(windowTarget) === agent.name) continue; // already set
    try {
      renameWindow(windowTarget, agent.name);
      titledWindows.set(windowTarget, agent.name);
    } catch {}
  }
}

// ── File watchers: push immediately on change ──────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');
const SESSION_STATE_DIR = join(HOME, '.copilot', 'session-state');

// Debounce helper — coalesce rapid file-change events
function debounce(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

const onAgentFileChange = debounce(() => {
  invalidateAgentCache();
  buildAndBroadcast();
}, 200);

const onSessionDirChange = debounce(() => {
  invalidateSessionCache();
  // No WS broadcast needed — sessions are fetched via REST, not WS
}, 300);

// Watch agent-sessions.json for registrations/stops
if (existsSync(SESSION_MAP_FILE)) {
  watch(SESSION_MAP_FILE, onAgentFileChange);
} else {
  // Watch parent dir until the file is created
  watch(join(HOME, '.copilot'), (_evt, fname) => {
    if (fname === 'agent-sessions.json') {
      onAgentFileChange();
      // Re-attach direct watcher once it exists
      try { watch(SESSION_MAP_FILE, onAgentFileChange); } catch { /* ignore */ }
    }
  });
}

// Watch session-state dir for new sessions
if (existsSync(SESSION_STATE_DIR)) {
  watch(SESSION_STATE_DIR, onSessionDirChange);
}

// Psmux pane status still needs polling — there are no file events for terminal state.
// 5s is plenty; WS only pushes when payload actually changes.
setInterval(buildAndBroadcast, 5000);

// Wire event broadcaster to push events to all WS clients
setBroadcaster((event: ActivityEvent) => {
  const payload = JSON.stringify({ type: 'event', event });
  for (const client of wssStatus.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
});

wssStatus.on('connection', async (ws) => {
  console.log('Status WS connected');
  try {
    const agents = await refreshAgents();
    ws.send(JSON.stringify({
      type: 'status',
      timestamp: new Date().toISOString(),
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        pane: a.pane ? a.pane.target : null,
      })),
    }));
  } catch { /* ignore */ }
});

// --- WebSocket 2: Terminal bridge (/ws/terminal?target=session:w.p) ---
const wssTerminal = new WebSocketServer({ noServer: true });

wssTerminal.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const target = url.searchParams.get('target');

  if (!target) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing ?target= param' }));
    ws.close();
    return;
  }

  // Verify the pane exists
  const panes = listPanes();
  const pane = panes.find(p => p.target === target);
  if (!pane) {
    ws.send(JSON.stringify({ type: 'error', message: `Pane "${target}" not found` }));
    ws.close();
    return;
  }

  console.log(`Terminal WS connected to pane ${target}`);

  // Track the client's xterm size so we can trim capture output
  let clientCols = pane.width;
  let clientRows = pane.height;

  // Send pane dimensions for initial reference
  const dims = getPaneDimensions(target!);
  if (dims) {
    ws.send(JSON.stringify({ type: 'dimensions', cols: dims.width, rows: dims.height }));
  }

  let lastContent = '';
  let pollInterval: ReturnType<typeof setInterval>;

  // Capture and trim to client viewport
  function pollPane() {
    try {
      const raw = capturePane(target!, 500, false);
      // Split into lines, trim each to client width, take last N rows
      const lines = raw.split('\n');
      const trimmed = lines
        .map(l => l.substring(0, clientCols))
        .slice(-clientRows);
      const content = trimmed.join('\r\n');
      if (content !== lastContent) {
        ws.send(JSON.stringify({ type: 'output', content }));
        lastContent = content;
      }
    } catch { /* pane may have died */ }
  }

  // Initial full capture
  pollPane();
  pollInterval = setInterval(pollPane, 1000);

  // Receive keystrokes from xterm
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'resize') {
        // Client xterm fitted to a new size — update our trim dimensions
        if (msg.cols > 0 && msg.rows > 0) {
          clientCols = msg.cols;
          clientRows = msg.rows;
          lastContent = ''; // force refresh
        }
      } else if (msg.type === 'input') {
        sendKeys(target!, msg.data, false);
      } else if (msg.type === 'key') {
        switch (msg.key) {
          case 'Enter': sendKeys(target!, '', true); break;
          case 'Escape': sendEscape(target!); break;
          case 'Tab': sendKeys(target!, 'Tab', false); break;
          case 'Up': sendKeys(target!, 'Up', false); break;
          case 'Down': sendKeys(target!, 'Down', false); break;
          case 'Left': sendKeys(target!, 'Left', false); break;
          case 'Right': sendKeys(target!, 'Right', false); break;
          case 'Backspace': sendKeys(target!, 'BSpace', false); break;
          case 'C-c': sendKeys(target!, 'C-c', false); break;
          case 'C-d': sendKeys(target!, 'C-d', false); break;
          case 'C-z': sendKeys(target!, 'C-z', false); break;
          case 'C-l': sendKeys(target!, 'C-l', false); break;
          default: sendKeys(target!, msg.key, false); break;
        }
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    console.log(`Terminal WS disconnected from ${target}`);
    clearInterval(pollInterval);
  });
  ws.on('error', () => clearInterval(pollInterval));
});

// ── Headless Agent Streaming WebSocket ────────────────────────────
// ws://localhost:3848/ws/headless?agent=<name>
// Client sends: { prompt: "..." } | { action: 'enqueue'|'steer'|'abort'|'compact', prompt?: "..." }
// Server streams: { type: 'turn_start'|'message_delta'|'reasoning'|'usage'|'response'|'error', ... }

const wssHeadless = new WebSocketServer({ noServer: true });
const agentSendLocks = new Map<string, Promise<void>>();

wssHeadless.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const agentName = url.searchParams.get('agent');

  if (!agentName) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing ?agent= param' }));
    ws.close();
    return;
  }

  // Validate agent name: alphanumeric, hyphens, underscores, 1-80 chars
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agentName)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid agent name: only a-z, 0-9, hyphens, underscores allowed (max 80 chars)' }));
    ws.close();
    return;
  }

  console.log(`Headless WS connected to agent "${agentName}"`);

  // Register as a stream listener for live token-by-token output
  const { addStreamListener, removeStreamListener, getHeadlessAgent, getOrReviveHeadless,
          enqueueToHeadless, steerHeadless, abortHeadless, compactHeadless, persistUserPrompts,
          setHeadlessMode, broadcastToAgent } = await import('./services/headless.js');
  const streamHandler = (event: any) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  addStreamListener(agentName, streamHandler);

  // Send current agent status so the client can sync its loading state
  // If the agent isn't in memory, try auto-reviving from persisted sessions
  let currentAgent = getHeadlessAgent(agentName);
  if (!currentAgent) {
    try {
      currentAgent = await getOrReviveHeadless(agentName) || undefined;
    } catch { /* ignore – agent may not exist */ }
  }
  if (currentAgent) {
    ws.send(JSON.stringify({
      type: 'status_sync',
      agentStatus: currentAgent.status,
    }));
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const action = msg.action || 'send';

      // ── Abort ──
      if (action === 'abort') {
        try {
          await abortHeadless(agentName);
          ws.send(JSON.stringify({ type: 'aborted' }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        return;
      }

      // ── Compact ──
      if (action === 'compact') {
        try {
          await compactHeadless(agentName);
          ws.send(JSON.stringify({ type: 'compacted' }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        return;
      }

      // ── Set mode ──
      if (action === 'set_mode') {
        try {
          const result = await setHeadlessMode(agentName, msg.mode);
          ws.send(JSON.stringify({ type: 'mode_changed', mode: result.mode }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        return;
      }

      // ── Permission response ──
      if (action === 'permission_response') {
        try {
          let agent = getHeadlessAgent(agentName);
          if (agent?.session) {
            // TODO: verify exact SDK method name — may be respondPermission, answerPermission, etc.
            await (agent.session as any).respondPermission(msg.requestId, msg.approved);
          }
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: `Permission response failed: ${e.message}` }));
        }
        return;
      }

      if (!msg.prompt || typeof msg.prompt !== 'string') {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing or invalid prompt field (must be a non-empty string)' }));
        return;
      }

      // Limit prompt length (100KB should be more than enough)
      if (msg.prompt.length > 100_000) {
        ws.send(JSON.stringify({ type: 'error', message: `Prompt too long (${msg.prompt.length} chars, max 100000)` }));
        return;
      }

      // Validate attachments if present
      if (msg.attachments != null) {
        if (!Array.isArray(msg.attachments)) {
          ws.send(JSON.stringify({ type: 'error', message: 'attachments must be an array' }));
          return;
        }
        for (const att of msg.attachments) {
          if (!att || typeof att.type !== 'string' || typeof att.value !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Each attachment must have { type: string, value: string }' }));
            return;
          }
        }
      }

      let agent = getHeadlessAgent(agentName);
      if (!agent) {
        // Agent not in memory — revive it silently (MiniChat provides its own wake feedback)
        agent = await getOrReviveHeadless(agentName);
        if (!agent) {
          ws.send(JSON.stringify({ type: 'error', message: `Agent "${agentName}" not found or could not be revived` }));
          return;
        }
      }

      // ── Enqueue — queue while busy ──
      if (action === 'enqueue') {
        try {
          const messageId = await enqueueToHeadless(agentName, msg.prompt);
          ws.send(JSON.stringify({ type: 'enqueued', messageId }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        return;
      }

      // ── Steer — interrupt with new prompt ──
      if (action === 'steer') {
        try {
          const messageId = await steerHeadless(agentName, msg.prompt);
          ws.send(JSON.stringify({ type: 'steered', messageId }));
        } catch (e: any) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
        return;
      }

      // ── Normal send — default ──
      // Acquire per-agent send lock to prevent concurrent sendAndWait corruption
      while (agentSendLocks.has(agentName)) {
        await agentSendLocks.get(agentName);
      }
      let releaseLock: () => void;
      agentSendLocks.set(agentName, new Promise(r => releaseLock = r));

      try {
        agent.status = 'running';
        broadcastToAgent(agentName, { type: 'status_changed', status: 'running' });
        // Broadcast user message to all WS listeners (other dashboard tabs see it)
        broadcastToAgent(agentName, { type: 'user_message', prompt: msg.prompt, from: msg.from || 'dashboard', senderId: msg.clientId });
        agent.lastMessageAt = new Date().toISOString();
        agent.messageCount++;
        agent.userPrompts.push({ prompt: msg.prompt, timestamp: new Date().toISOString() });
        persistUserPrompts(agentName, agent.userPrompts);

        // Client can request a custom timeout (30s–600s), default 600s
        const timeoutMs = Math.max(30_000, Math.min(600_000,
          typeof msg.timeout === 'number' ? msg.timeout * 1000 : 600_000));

        try {
          const sendOpts: any = { prompt: msg.prompt };
          if (msg.attachments?.length) sendOpts.attachments = msg.attachments;

          await agent.session.sendAndWait(sendOpts, timeoutMs);
          agent.status = 'idle';
          broadcastToAgent(agentName, { type: 'status_changed', status: 'idle' });
        } catch (e: any) {
          const errMsg = e.message || '';
          // Auto-revive: if session expired, create a fresh one and retry
          if (errMsg.includes('Session not found') || errMsg.includes('session_expired')) {
            ws.send(JSON.stringify({ type: 'system', message: '⏳ Session expired — creating fresh session…' }));
            try {
              const { createHeadlessAgent: createAgent } = await import('./services/headless.js');
              agent = await createAgent(agentName);
              if (agent) {
                ws.send(JSON.stringify({ type: 'system', message: '✓ New session ready' }));
                const sendOpts2: any = { prompt: msg.prompt };
                await agent.session.sendAndWait(sendOpts2, timeoutMs);
                agent.status = 'idle';
                broadcastToAgent(agentName, { type: 'status_changed', status: 'idle' });
              } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Failed to create fresh session' }));
              }
            } catch (retryErr: any) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: retryErr.message }));
              }
            }
          } else {
            agent.status = 'idle';
            broadcastToAgent(agentName, { type: 'status_changed', status: 'idle' });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: e.message }));
            }
          }
        }
      } finally {
        agentSendLocks.delete(agentName);
        releaseLock!();
      }
    } catch (e: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Parse error: ${e.message}` }));
      }
    }
  });

  ws.on('error', (err) => {
    removeStreamListener(agentName, streamHandler);
    console.error(`Headless WS error for "${agentName}":`, err.message);
  });

  ws.on('close', () => {
    removeStreamListener(agentName, streamHandler);
    console.log(`Headless WS disconnected from "${agentName}"`);
  });
});

// Route upgrade requests to the correct WebSocket server
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '', `http://localhost:${PORT}`).pathname;

  if (pathname === '/ws/status') {
    wssStatus.handleUpgrade(req, socket, head, (ws) => {
      wssStatus.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/terminal') {
    wssTerminal.handleUpgrade(req, socket, head, (ws) => {
      wssTerminal.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/headless') {
    wssHeadless.handleUpgrade(req, socket, head, (ws) => {
      wssHeadless.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n🏘️ Copilot Town API running on http://localhost:${PORT}`);
  console.log(`   Status WS:    ws://localhost:${PORT}/ws/status`);
  console.log(`   Terminal WS:  ws://localhost:${PORT}/ws/terminal?target=<pane>`);
  console.log(`   Headless WS:  ws://localhost:${PORT}/ws/headless?agent=<name>`);
  console.log(`   Frontend:     http://localhost:${PORT}\n`);

  if (isMuxAvailable()) {
    console.log(`   ✅ Terminal multiplexer: ${getMuxBinary()}`);
  } else {
    console.log(`   ⚠️  No terminal multiplexer found (psmux/tmux).`);
    console.log(`      Pane management, terminal grid, and agent discovery are disabled.`);
    console.log(`      Install: winget install marlocarlo.psmux`);
  }
  console.log('');
  startHealthMonitor();
  loadWorkflows().then(defs => {
    console.log(`   📋 ${defs.length} workflow(s) loaded`);
    startScheduler();
    console.log(`   ⏰ Workflow scheduler started`);
  });
  loadRuns().then(() => console.log(`   📦 Workflow runs loaded from disk`));

  // Broadcast workflow run updates to WS clients
  addRunListener((run) => {
    const msg = JSON.stringify({ type: 'workflow_run', run });
    wssStatus.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  });
});

// Graceful shutdown — stop SDK client
process.on('SIGINT', async () => {
  try { const { destroyAllHeadless } = await import('./services/headless.js'); await destroyAllHeadless(); } catch {}
  await stopClient();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { const { destroyAllHeadless } = await import('./services/headless.js'); await destroyAllHeadless(); } catch {}
  await stopClient();
  process.exit(0);
});
