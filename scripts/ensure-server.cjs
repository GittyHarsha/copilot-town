#!/usr/bin/env node
/**
 * Ensure the Copilot Town server is running.
 * Called as an MCP server entry — if the real server is already running,
 * this just exits cleanly. If not, it spawns the server as a detached process.
 * 
 * Also acts as a minimal MCP server that responds to initialize/list_tools.
 */
const { execSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.COPILOT_TOWN_PORT || '3848');
const PID_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.copilot', 'copilot-town.pid');
const ROOT = path.join(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'server', 'index.ts');
const LOG_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.copilot', 'copilot-town.log');

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

/** Silently install deps if node_modules is missing */
function ensureDeps() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) {
    try {
      execSync('npm install --silent --no-progress', {
        cwd: ROOT,
        stdio: 'ignore',
        timeout: 120000,
        windowsHide: true,
      });
    } catch {}
  }
  // Also client deps
  const clientNm = path.join(ROOT, 'client', 'node_modules');
  if (!fs.existsSync(clientNm)) {
    try {
      execSync('npm install --silent --no-progress', {
        cwd: path.join(ROOT, 'client'),
        stdio: 'ignore',
        timeout: 120000,
        windowsHide: true,
      });
    } catch {}
  }
}

async function ensureServer() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    return; // Server already running
  }

  // Install deps silently if needed
  ensureDeps();

  // Open a log file for server output (so we can debug without visible terminals)
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');

  // Spawn server as a background process — NO visible terminal window.
  // On Windows: detached:true creates a new console (visible flash!).
  //   Instead, skip detached — Windows processes survive parent exit by default.
  //   unref() lets this MCP process exit without waiting for the child.
  // On Unix: detached:true + setsid is needed so the child survives parent exit.
  const isWin = process.platform === 'win32';
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, SERVER_SCRIPT], {
    cwd: ROOT,
    detached: !isWin,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, COPILOT_TOWN_PORT: String(PORT) },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);

  // Save PID
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
  } catch {}
}

// Run as MCP server (stdin/stdout JSON-RPC)
// CRITICAL: Start MCP listener IMMEDIATELY so initialize doesn't timeout.
// Server startup happens in the background.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

// Fire and forget — don't block MCP handshake
ensureServer().catch(() => {});

rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        const resp = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'copilot-town', version: '0.1.0' }
          }
        };
        process.stdout.write(JSON.stringify(resp) + '\n');
      } else if (msg.method === 'tools/list') {
        const resp = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'copilot_town_open',
                description: 'Open the Copilot Town dashboard in your browser',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'copilot_town_status',
                description: 'Get status of all agents in Copilot Town',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'copilot_town_relay',
                description: 'Relay a message between agents',
                inputSchema: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', description: 'Source agent name' },
                    to: { type: 'string', description: 'Target agent name' },
                    message: { type: 'string', description: 'Message to relay' }
                  },
                  required: ['from', 'to', 'message']
                }
              },
              {
                name: 'copilot_town_list_templates',
                description: 'List available agent templates',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'copilot_town_register',
                description: 'Register this Copilot session as a named agent in Copilot Town so it appears in the dashboard. You MUST pass your own session_id — find it from your session-state folder path or COPILOT_SESSION_ID env var.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Display name for this agent (optional — defaults to session-XXXXXXXX)' },
                    session_id: { type: 'string', description: 'Your Copilot session ID (UUID). Required — look in your session-state path or COPILOT_SESSION_ID.' }
                  },
                  required: ['session_id']
                }
              }
            ]
          }
        };
        process.stdout.write(JSON.stringify(resp) + '\n');
      } else if (msg.method === 'tools/call') {
        const tool = msg.params?.name;
        if (tool === 'copilot_town_open') {
          const url = `http://localhost:${PORT}`;
          // Use the 'open' package — handles Windows without terminal flash
          try {
            const open = require('open');
            open(url).catch(() => {});
          } catch {
            // Fallback if open package not available
            try {
              if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }).unref();
              else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' }).unref();
              else spawn('xdg-open', [url], { stdio: 'ignore' }).unref();
            } catch {}
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: `Copilot Town opened at ${url}` }] }
          }) + '\n');
        } else if (tool === 'copilot_town_relay') {
          const { from, to, message } = msg.params?.arguments || {};
          const postData = JSON.stringify({ from, to, message });
          const http = require('http');
          const req = http.request({
            hostname: 'localhost', port: PORT, path: '/api/agents/relay',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: result.message || `Relayed message from ${from} to ${to}` }] }
                }) + '\n');
              } catch {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: data || 'Relay sent' }] }
                }) + '\n');
              }
            });
          });
          req.on('error', () => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: 'Hub server not running' }] }
            }) + '\n');
          });
          req.write(postData);
          req.end();
        } else if (tool === 'copilot_town_list_templates') {
          const http = require('http');
          http.get(`http://localhost:${PORT}/api/templates`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const templates = JSON.parse(data);
                const summary = templates.map(t => `${t.name}: ${t.description || 'No description'}`).join('\n');
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: summary || 'No templates found' }] }
                }) + '\n');
              } catch {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: 'Hub server not responding' }] }
                }) + '\n');
              }
            });
          }).on('error', () => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: 'Hub server not running' }] }
            }) + '\n');
          });
        } else if (tool === 'copilot_town_register') {
          const { name, session_id } = msg.params?.arguments || {};

          // session_id is required — passed explicitly by the calling agent
          let sessionId = session_id || process.env.COPILOT_SESSION_ID;

          if (!sessionId) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: 'Missing session_id parameter. Pass your Copilot session UUID so we can register the correct session.' }] }
            }) + '\n');
          } else {
            const HOME = process.env.USERPROFILE || process.env.HOME || '';
            const SESSION_FILE = path.join(HOME, '.copilot', 'agent-sessions.json');
            const agentName = (name && name.trim()) ? name.trim() : `session-${sessionId.slice(0, 8)}`;
            try {
              let data = { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
              if (fs.existsSync(SESSION_FILE)) {
                data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
              }
              if (!data.agents) data.agents = {};

              // If this session is already stored under a different key, move it
              const existingKey = Object.keys(data.agents).find(k => {
                const v = data.agents[k];
                return (v.session || v.sessionId || v.session_id) === sessionId;
              });
              if (existingKey && existingKey !== agentName) {
                const old = data.agents[existingKey];
                delete data.agents[existingKey];
                data.agents[agentName] = old;
              }

              const existing = data.agents[agentName] || {};
              data.agents[agentName] = {
                ...existing,
                session: sessionId,
                startedAt: existing.startedAt || new Date().toISOString(),
              };
              // Remove stoppedAt in case session was previously marked stopped
              delete data.agents[agentName].stoppedAt;

              fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: `✅ Registered as "${agentName}" in Copilot Town. Open the dashboard to see it.` }] }
              }) + '\n');
            } catch (e) {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: `Failed to register: ${e.message}` }] }
              }) + '\n');
            }
          }
        } else if (tool === 'copilot_town_status') {
          // Fetch from local API
          const http = require('http');
          http.get(`http://localhost:${PORT}/api/agents`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const agents = JSON.parse(data);
                const summary = agents.map(a => `${a.name}: ${a.status}`).join('\n');
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: summary || 'No agents found' }] }
                }) + '\n');
              } catch {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: msg.id,
                  result: { content: [{ type: 'text', text: 'Hub server not responding' }] }
                }) + '\n');
              }
            });
          }).on('error', () => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: 'Hub server not running' }] }
            }) + '\n');
          });
        }
      } else if (msg.method === 'notifications/initialized') {
        // No response needed
      } else if (msg.id) {
        // Unknown method
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: 'Method not found' }
        }) + '\n');
      }
    } catch {}
  });
