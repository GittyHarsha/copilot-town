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

  // Spawn server as a detached background process.
  // detached:true on all platforms so the child survives parent exit.
  // windowsHide:true suppresses any console window flash on Windows.
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, SERVER_SCRIPT], {
    cwd: ROOT,
    detached: true,
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

// ── HTTP helpers for tool handlers ──────────────────────────────
const http = require('http');

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path: urlPath,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpPut(urlPath, body) {
  return new Promise((resolve, reject) => {
    const putData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path: urlPath,
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putData) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(putData);
    req.end();
  });
}

function reply(id, text) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text }] }
  }) + '\n');
}

function replyError(id, text) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text: `❌ ${text}` }] }
  }) + '\n');
}

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
                    name: { type: 'string', description: 'Agent name — a short, unique, human-readable name other agents use to communicate with you (e.g. "code-reviewer", "docs-writer")' },
                    session_id: { type: 'string', description: 'Your Copilot session ID (UUID). Required — look in your session-state path or COPILOT_SESSION_ID.' }
                  },
                  required: ['session_id', 'name']
                }
              },
              {
                name: 'copilot_town_whoami',
                description: 'Get your own agent identity — name, session ID, pane, status. Pass your session_id so the server can find you.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    session_id: { type: 'string', description: 'Your Copilot session ID (UUID).' }
                  },
                  required: ['session_id']
                }
              },
              {
                name: 'copilot_town_get_agent',
                description: 'Get details of a specific agent by name or ID — status, pane, template, metadata.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name or session ID' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_set_status',
                description: 'Set your current task/status text so other agents and the dashboard can see what you are working on.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Your agent name or ID' },
                    task: { type: 'string', description: 'What you are currently working on (short text)' }
                  },
                  required: ['agent', 'task']
                }
              },
              {
                name: 'copilot_town_broadcast',
                description: 'Send a message to ALL other agents at once.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', description: 'Your agent name' },
                    message: { type: 'string', description: 'Message to broadcast' }
                  },
                  required: ['from', 'message']
                }
              },
              {
                name: 'copilot_town_read_output',
                description: 'Read the last N lines of another agent\'s terminal output without messaging them.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name or ID to read from' },
                    lines: { type: 'number', description: 'Number of lines to read (default: 50)' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_set_meta',
                description: 'Update your own agent metadata — description, model, flags, template.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Your agent name or ID' },
                    description: { type: 'string', description: 'Agent description' },
                    model: { type: 'string', description: 'Model to use (e.g., claude-sonnet-4)' },
                    template: { type: 'string', description: 'Agent template name' },
                    flags: { type: 'array', items: { type: 'string' }, description: 'CLI flags (e.g., ["--yolo"])' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_spawn',
                description: 'Spawn a new agent in a new terminal pane. Creates a pane and starts a copilot session.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Name for the new agent' },
                    template: { type: 'string', description: 'Agent template to use (optional)' },
                    model: { type: 'string', description: 'Model to use (optional)' },
                    flags: { type: 'array', items: { type: 'string' }, description: 'CLI flags (optional)' },
                    session: { type: 'string', description: 'psmux session name (default: town)' },
                    headless: { type: 'boolean', description: 'If true, create a headless agent (SDK session, no terminal pane). Default: false' },
                    role: { type: 'string', description: 'Agent role description injected into system prompt (headless only)' },
                    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort level (headless only)' }
                  },
                  required: ['name']
                }
              },
              {
                name: 'copilot_town_stop_agent',
                description: 'Stop another agent by name or ID.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name or ID to stop' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_promote',
                description: 'Promote a headless agent to a terminal pane. Disconnects the SDK handle and opens the session in a new pane so you can see it running.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name to promote' },
                    session: { type: 'string', description: 'psmux session name (default: town)' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_demote',
                description: 'Demote a pane agent to headless mode. Stops the terminal process and takes over the session via SDK — the agent keeps its conversation but runs invisibly with full thinking/token visibility.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name to demote' }
                  },
                  required: ['agent']
                }
              },
              {
                name: 'copilot_town_set_model',
                description: 'Change the model and/or reasoning effort on a running headless agent mid-session. No need to restart.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name' },
                    model: { type: 'string', description: 'New model ID (e.g. claude-sonnet-4, gpt-4.1)' },
                    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort level (optional)' }
                  },
                  required: ['agent', 'model']
                }
              },
              {
                name: 'copilot_town_set_mode',
                description: 'Switch a headless agent between interactive, plan, and autopilot modes. Autopilot lets the agent work autonomously.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name' },
                    mode: { type: 'string', enum: ['interactive', 'plan', 'autopilot'], description: 'Agent mode' }
                  },
                  required: ['agent', 'mode']
                }
              },
              {
                name: 'copilot_town_share_note',
                description: 'Share a note with the team — a key-value pair that any agent can read. Use for sharing decisions, API interfaces, file locations, etc.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', description: 'Note key (e.g., "auth-api", "db-schema")' },
                    value: { type: 'string', description: 'Note content (text/markdown)' },
                    author: { type: 'string', description: 'Your agent name' }
                  },
                  required: ['key', 'value']
                }
              },
              {
                name: 'copilot_town_get_notes',
                description: 'Read shared notes from the team. Call with no key to get all notes, or with a key to get a specific one.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', description: 'Note key to read (optional — omit for all notes)' }
                  }
                }
              },
              {
                name: 'copilot_town_wake',
                description: 'Wake up a stopped agent and optionally send it an initial message. Resumes the agent\'s previous session in a new pane, then relays a message so it knows why it was woken.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    agent: { type: 'string', description: 'Agent name or ID to wake up' },
                    message: { type: 'string', description: 'Message to send after the agent starts (optional — tells it why it was woken)' },
                    from: { type: 'string', description: 'Your agent name (for the message attribution)' }
                  },
                  required: ['agent']
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
          httpPost('/api/agents/relay', { from, to, message })
            .then(result => {
              if (result.error) return replyError(msg.id, result.error);
              if (result.method === 'sdk' && result.response) {
                let text = `Relayed to ${result.to} (via SDK).\n\nResponse:\n${result.response}`;
                if (result.thinking) text += `\n\n<thinking>\n${result.thinking}\n</thinking>`;
                if (result.outputTokens) text += `\n\n[${result.outputTokens} tokens]`;
                reply(msg.id, text);
              } else {
                const wokeMsg = result.woke ? ' (auto-woke agent first)' : '';
                reply(msg.id, `Relayed message from ${result.from} to ${result.to}${wokeMsg}`);
              }
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));
        } else if (tool === 'copilot_town_list_templates') {
          httpGet('/api/templates')
            .then(templates => {
              const summary = Array.isArray(templates)
                ? templates.map(t => `${t.name}: ${t.description || 'No description'}`).join('\n')
                : 'No templates found';
              reply(msg.id, summary || 'No templates found');
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));
        } else if (tool === 'copilot_town_register') {
          const { name, session_id } = msg.params?.arguments || {};
          let sessionId = session_id || process.env.COPILOT_SESSION_ID;

          if (!sessionId) {
            reply(msg.id, 'Missing session_id parameter. Pass your Copilot session UUID so we can register the correct session.');
          } else if (!name || !name.trim()) {
            reply(msg.id, 'Missing name parameter. Provide a short, unique name so other agents can communicate with you (e.g. "code-reviewer", "docs-writer").');
          } else {
            const agentName = name.trim();
            httpPost('/api/agents/register', { name: agentName, session_id: sessionId, ppid: process.ppid })
              .then(data => {
                if (data.error) return replyError(msg.id, data.error);
                const paneMsg = data.pane ? ` (detected in pane ${data.pane})` : '';
                reply(msg.id, `✅ Registered as "${data.name}" in Copilot Town${paneMsg}. Open the dashboard to see it.`);
              })
              .catch(() => {
                // Fallback: write directly if server is down
                const HOME = process.env.USERPROFILE || process.env.HOME || '';
                const SESSION_FILE = path.join(HOME, '.copilot', 'agent-sessions.json');
                try {
                  let data = { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
                  if (fs.existsSync(SESSION_FILE)) {
                    data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
                  }
                  if (!data.agents) data.agents = {};
                  const existing = data.agents[agentName] || {};
                  data.agents[agentName] = {
                    ...existing,
                    session: sessionId,
                    startedAt: existing.startedAt || new Date().toISOString(),
                  };
                  delete data.agents[agentName].stoppedAt;
                  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
                  reply(msg.id, `✅ Registered as "${agentName}" (server offline, pane not auto-detected).`);
                } catch (e) {
                  replyError(msg.id, `Failed to register: ${e.message}`);
                }
              });
          }
        } else if (tool === 'copilot_town_status') {
          httpGet('/api/agents')
            .then(agents => {
              const summary = Array.isArray(agents)
                ? agents.map(a => `${a.name}: ${a.status}${a.task ? ` (${a.task})` : ''}`).join('\n')
                : 'No agents found';
              reply(msg.id, summary || 'No agents found');
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        // ── New tools ────────────────────────────────────────────

        } else if (tool === 'copilot_town_whoami') {
          const { session_id } = msg.params?.arguments || {};
          if (!session_id) return replyError(msg.id, 'session_id required');
          httpGet('/api/agents')
            .then(agents => {
              if (!Array.isArray(agents)) return replyError(msg.id, 'Hub server not responding');
              const me = agents.find(a => a.id === session_id || a.sessionId === session_id);
              if (!me) return reply(msg.id, `No agent found for session ${session_id}. You may need to register first.`);
              reply(msg.id, JSON.stringify({ name: me.name, id: me.id, status: me.status, pane: me.pane?.target || null, template: me.template?.name || null }, null, 2));
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_get_agent') {
          const { agent } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name or ID required');
          httpGet(`/api/agents/${encodeURIComponent(agent)}`)
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, JSON.stringify(data, null, 2));
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_set_status') {
          const { agent, task } = msg.params?.arguments || {};
          if (!agent || !task) return replyError(msg.id, 'agent and task required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/task`, { task })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `✅ Status set: "${task}"`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_broadcast') {
          const { from, message } = msg.params?.arguments || {};
          if (!from || !message) return replyError(msg.id, 'from and message required');
          httpPost('/api/agents/broadcast', { from, message })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `📢 Broadcast sent to ${data.delivered?.length || 0} agents: ${(data.delivered || []).join(', ') || 'none'}${data.failed?.length ? ` (failed: ${data.failed.join(', ')})` : ''}`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_read_output') {
          const { agent, lines } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name or ID required');
          const n = lines || 50;
          httpGet(`/api/agents/${encodeURIComponent(agent)}/output?lines=${n}`)
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, data.output || '(empty output)');
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_set_meta') {
          const { agent, description, model, template, flags } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name or ID required');
          const body = {};
          if (description !== undefined) body.description = description;
          if (model !== undefined) body.model = model;
          if (template !== undefined) body.template = template;
          if (flags !== undefined) body.flags = flags;
          httpPut(`/api/agents/${encodeURIComponent(agent)}/settings`, body)
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `✅ Metadata updated for ${agent}`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_spawn') {
          const { name, template, model, flags, session, headless, role, reasoningEffort } = msg.params?.arguments || {};
          if (!name) return replyError(msg.id, 'name required');
          httpPost('/api/agents/spawn', { name, template, model, flags, session, headless: !!headless, role, reasoningEffort })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              if (data.type === 'headless') {
                reply(msg.id, `✅ Created headless agent "${name}" (model: ${data.model || 'default'})\nSession: ${data.sessionId || 'unknown'}`);
              } else {
                reply(msg.id, `✅ Spawned "${name}" in pane ${data.pane}\nCommand: ${data.command}`);
              }
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_stop_agent') {
          const { agent } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name or ID required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/stop`, {})
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `✅ Stopped agent "${agent}"`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_promote') {
          const { agent, session } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/promote`, { session })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `⬆️ Promoted "${agent}" to pane ${data.pane}\nSession ${data.sessionId} now visible in terminal.`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_demote') {
          const { agent } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/demote`, {})
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `⬇️ Demoted "${agent}" to headless mode\nSession ${data.sessionId} running via SDK (model: ${data.model}). Use relay to communicate.`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_set_model') {
          const { agent, model, reasoningEffort } = msg.params?.arguments || {};
          if (!agent || !model) return replyError(msg.id, 'agent and model required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/model`, { model, reasoningEffort })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `🔄 Model changed for "${agent}": ${model}${reasoningEffort ? ` (effort: ${reasoningEffort})` : ''}`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_set_mode') {
          const { agent, mode } = msg.params?.arguments || {};
          if (!agent || !mode) return replyError(msg.id, 'agent and mode required');
          httpPost(`/api/agents/${encodeURIComponent(agent)}/mode`, { mode })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `🎛️ Agent "${agent}" mode set to: ${data.mode || mode}`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_share_note') {
          const { key, value, author } = msg.params?.arguments || {};
          if (!key || !value) return replyError(msg.id, 'key and value required');
          httpPost('/api/notes', { key, value, author })
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              reply(msg.id, `📝 Note "${key}" shared with the team`);
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));

        } else if (tool === 'copilot_town_wake') {
          const { agent, message, from } = msg.params?.arguments || {};
          if (!agent) return replyError(msg.id, 'agent name or ID required');
          if (message && from) {
            // Use relay which auto-wakes + polls for prompt readiness
            httpPost('/api/agents/relay', { from, to: agent, message })
              .then(data => {
                if (data.error) return replyError(msg.id, data.error);
                reply(msg.id, `⏰ Woke "${agent}" in pane ${data.target} and sent: "${message}"`);
              })
              .catch(() => replyError(msg.id, 'Hub server not running'));
          } else {
            // Just resume, no message
            httpPost(`/api/agents/${encodeURIComponent(agent)}/resume`, {})
              .then(data => {
                if (data.error) return replyError(msg.id, data.error);
                reply(msg.id, `⏰ Woke "${agent}" in pane ${data.target || 'unknown'}\nSession: ${data.sessionId || 'unknown'}\nCommand: ${data.command || 'copilot'}`);
              })
              .catch(() => replyError(msg.id, 'Hub server not running'));
          }

        } else if (tool === 'copilot_town_get_notes') {
          const { key } = msg.params?.arguments || {};
          const urlPath = key ? `/api/notes/${encodeURIComponent(key)}` : '/api/notes';
          httpGet(urlPath)
            .then(data => {
              if (data.error) return replyError(msg.id, data.error);
              if (key) {
                reply(msg.id, `📝 ${key}:\n${data.value}\n(by ${data.author}, ${data.updatedAt})`);
              } else {
                const entries = Object.entries(data);
                if (entries.length === 0) return reply(msg.id, 'No shared notes yet.');
                const summary = entries.map(([k, v]) => `• ${k}: ${v.value.slice(0, 100)}${v.value.length > 100 ? '...' : ''} (by ${v.author})`).join('\n');
                reply(msg.id, `📝 Shared notes (${entries.length}):\n${summary}`);
              }
            })
            .catch(() => replyError(msg.id, 'Hub server not running'));
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
