import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { URL, fileURLToPath } from 'url';
import { existsSync } from 'fs';
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
import { getAllAgents, loadAgentTemplates } from './services/agents.js';
import { listPanes, capturePane, sendKeys, sendEscape, getPaneDimensions, isMuxAvailable, getMuxBinary } from './services/psmux.js';
import { setBroadcaster, type ActivityEvent } from './services/events.js';
import { startHealthMonitor, getHealthStatus } from './services/healthMonitor.js';

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

app.get('/api/templates', (_req, res) => {
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

// Serve built frontend if available (single-server mode)
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (_req, res) => {
    if (!_req.path.startsWith('/api') && !_req.path.startsWith('/ws')) {
      res.sendFile(join(clientDist, 'index.html'));
    }
  });
  console.log(`📦 Serving built frontend from ${clientDist}`);
}

// HTTP + WebSocket server
const server = createServer(app);

// --- WebSocket 1: Agent status broadcast (/ws/status) ---
const wssStatus = new WebSocketServer({ noServer: true });
let lastStatus = '';

function broadcastStatus() {
  if (wssStatus.clients.size === 0) return;
  try {
    const agents = getAllAgents();
    const panes = listPanes();
    const payload = JSON.stringify({
      type: 'status',
      timestamp: new Date().toISOString(),
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        pane: a.pane ? a.pane.target : null,
      })),
      psmux: {
        totalPanes: panes.length,
        sessions: [...new Set(panes.map(p => p.sessionName))],
      },
    });
    if (payload !== lastStatus) {
      lastStatus = payload;
      for (const client of wssStatus.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    }
  } catch (err) {
    console.error('Status broadcast error:', err);
  }
}
setInterval(broadcastStatus, 2000);

// Wire event broadcaster to push events to all WS clients
setBroadcaster((event: ActivityEvent) => {
  const payload = JSON.stringify({ type: 'event', event });
  for (const client of wssStatus.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
});

wssStatus.on('connection', (ws) => {
  console.log('Status WS connected');
  try {
    const agents = getAllAgents();
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
  pollInterval = setInterval(pollPane, 200);

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
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`\n🏘️ Copilot Town API running on http://localhost:${PORT}`);
  console.log(`   Status WS:   ws://localhost:${PORT}/ws/status`);
  console.log(`   Terminal WS:  ws://localhost:${PORT}/ws/terminal?target=<pane>`);
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
});
