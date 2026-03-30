import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { getAllAgents, getAgent, getAgentMdContent, loadAgentTemplates, cleanSessionFile, refreshAgents } from '../services/agents.js';
import { capturePane, sendKeys, listPanes, provisionPane, renameWindow, type ProvisionConfig } from '../services/psmux.js';
import { recordRelay } from './relays.js';
import { pushEvent } from '../services/events.js';

const router = Router();
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

// Serialize read-modify-write to agent-sessions.json within this process
function withSessionFile(fn: (data: any) => void): void {
  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    fn(raw);
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch (e) {
    console.error('agent-sessions.json write error:', e);
  }
}

function withSessionFileReturn<T>(fn: (data: any) => T): T {
  const raw = existsSync(SESSION_MAP_FILE)
    ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
    : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
  const result = fn(raw);
  writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  return result;
}

// Update psmux_layout in agent-sessions.json when an agent is assigned to a pane
function updatePaneMapping(agentName: string, paneTarget: string) {
  withSessionFile(raw => {
    const layout = raw.psmux_layout || {};
    const [sessionName, wp] = paneTarget.split(':');
    if (!sessionName || !wp) return;

    for (const [sess, panes] of Object.entries(layout as Record<string, any>)) {
      if (sess.startsWith('_')) continue;
      for (const [key, name] of Object.entries(panes as Record<string, string>)) {
        if (name === agentName) delete panes[key];
      }
    }

    if (!layout[sessionName]) layout[sessionName] = {};
    layout[sessionName][wp] = agentName;
    raw.psmux_layout = layout;
  });

  // Set the psmux window title to the agent name for easy identification
  try {
    const windowTarget = paneTarget.replace(/\.\d+$/, ''); // "town:0.1" → "town:0"
    renameWindow(windowTarget, agentName);
  } catch {}
}

// Clear stoppedAt when an agent is resumed/started
function clearStoppedAt(agentName: string) {
  withSessionFile(raw => {
    const agents = raw.agents || {};
    if (agents[agentName]) {
      delete agents[agentName].stoppedAt;
      agents[agentName].startedAt = new Date().toISOString();
      raw.agents = agents;
    }
  });
}

// Build message envelope with return-address metadata
function wrapEnvelope(from: string, to: string, message: string): string {
  const sender = getAgent(from);
  const senderName = sender?.name || from;

  return [
    `[relay from=${senderName}]`,
    message,
    `[reply with: relay(from=YOUR_NAME, to="${senderName}", message="...")]`,
  ].join('\n');
}

// Send text to a pane. Fire-and-forget.
// copilotEnqueue=true: type text → C-q (enqueue) → Enter (submit).
// copilotEnqueue=false: type text + Enter (for shell prompts).
function sendToPane(target: string, text: string, copilotEnqueue = false): boolean {
  if (copilotEnqueue) {
    sendKeys(target, text, false);
    sendKeys(target, 'C-q', false);
    sendKeys(target, '', true);
    return true;
  } else {
    return sendKeys(target, text, true);
  }
}

// Helper: check if a pane is truly free (shell prompt, no copilot running)
function isPaneFree(pane: { command: string; target: string }): boolean {
  const SHELL_CMDS = ['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'sh'];
  if (!SHELL_CMDS.some(s => pane.command.toLowerCase().includes(s))) return false;
  try {
    const out = capturePane(pane.target, 10);
    if (!out) return true;
    if (/shift\+tab switch mode/.test(out)) return false;
    if (/ctrl\+q enqueue/.test(out)) return false;
    if (/ctrl\+s run command/.test(out)) return false;
    if (/Type @ to mention files/.test(out)) return false;
    if (/esc clear input/.test(out)) return false;
  } catch {}
  return true;
}

// ── Templates endpoint (must be before /:id routes) ───────────────

router.get('/templates', (_req, res) => {
  res.json(loadAgentTemplates());
});

// ── Register (session-first, auto-detect pane via PID) ────────────

router.post('/register', (_req, res) => {
  const { name, session_id, ppid } = _req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required — other agents need a name to communicate with you' });

  const agentName = name.trim();

  // 1. Write to agent-sessions.json
  withSessionFile(raw => {
    if (!raw.agents) raw.agents = {};

    // Move if session exists under different name
    const existingKey = Object.keys(raw.agents).find(k => {
      const v = raw.agents[k];
      return (v.session || v.sessionId || v.session_id) === session_id;
    });
    if (existingKey && existingKey !== agentName) {
      const old = raw.agents[existingKey];
      delete raw.agents[existingKey];
      raw.agents[agentName] = old;
      if (raw.metadata?.[existingKey]) {
        if (!raw.metadata[agentName]) raw.metadata[agentName] = {};
        Object.assign(raw.metadata[agentName], raw.metadata[existingKey]);
        delete raw.metadata[existingKey];
      }
    }

    const existing = raw.agents[agentName] || {};
    raw.agents[agentName] = {
      ...existing,
      session: session_id,
      startedAt: existing.startedAt || new Date().toISOString(),
    };
    delete raw.agents[agentName].stoppedAt;
  });

  // 2. Auto-detect pane via PID ancestry
  //    MCP bridge sends ppid (= copilot CLI PID)
  //    Walk up: copilot CLI → shell → pane_pid
  let foundPane: string | null = null;
  if (ppid) {
    try {
      const allPanes = listPanes();
      const panePids = new Map(allPanes.map(p => [String(p.pid), p.target]));

      // Check if copilot PID directly matches a pane PID
      if (panePids.has(String(ppid))) {
        foundPane = panePids.get(String(ppid))!;
      } else {
        // Walk up: get copilot's parent PID (should be the shell = pane_pid)
        try {
          const isWin = process.platform === 'win32';
          const cmd = isWin
            ? `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}').ParentProcessId"`
            : `ps -o ppid= -p ${ppid}`;
          const result = execSync(cmd, { timeout: 3000, encoding: 'utf-8', windowsHide: true }).trim();
          if (result && panePids.has(result)) {
            foundPane = panePids.get(result)!;
          }
        } catch {}
      }

      if (foundPane) {
        updatePaneMapping(agentName, foundPane);
        // Store pane PID for reliable matching (survives pane renumbering)
        const matchedPane = allPanes.find(p => p.target === foundPane);
        if (matchedPane) {
          withSessionFile(raw => {
            if (raw.agents?.[agentName]) {
              raw.agents[agentName].panePid = matchedPane.pid;
            }
          });
        }
      }
    } catch {}
  }

  res.json({
    ok: true,
    name: agentName,
    sessionId: session_id,
    pane: foundPane,
  });
});

// ── Agent CRUD ────────────────────────────────────────────────────

// List all agents
router.get('/', async (_req, res) => {
  const agents = await refreshAgents();
  const tasks = getAllAgentTasks();
  // Merge metadata + task into each agent
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const metadata = raw.metadata || {};
      const enriched = agents.map(a => {
        const meta = metadata[a.name] || {};
        return { ...a, ...meta, task: tasks[a.id] || null };
      });
      return res.json(enriched);
    }
  } catch {}
  res.json(agents.map(a => ({ ...a, task: tasks[a.id] || null })));
});

// Get single agent detail (by session ID or name)
router.get('/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const mdContent = agent.template ? getAgentMdContent(agent.template.name) : null;
  // Include persisted metadata (template, model, flags, envVars, description)
  let meta: any = {};
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      meta = raw.metadata?.[agent.name] || {};
    }
  } catch {}
  const task = getAgentTask(agent.id);
  res.json({ ...agent, ...meta, mdContent, meta, task });
});

// Get agent's pane output
router.get('/:id/output', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent?.pane) return res.status(404).json({ error: 'Agent has no active pane' });

  const lines = parseInt(req.query.lines as string) || 50;
  const output = capturePane(agent.pane.target, lines);
  res.json({ target: agent.pane.target, output });
});

// Send message to agent's pane
router.post('/:id/message', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent?.pane) return res.status(404).json({ error: 'Agent has no active pane' });

  const { message, from } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const target = agent.pane.target;
  const payload = from ? wrapEnvelope(from, agent.name, message) : message;
  const ok = sendToPane(target, payload, true);
  if (ok) pushEvent('message_sent', `Message sent to ${agent.name}`, 'info', agent.name);
  res.json({ success: ok, target, message });
});

// ── Reusable resume helper (used by relay auto-wake and resume endpoint) ────
async function resumeAgent(agent: ReturnType<typeof getAgent>): Promise<{ ok: boolean; target: string; command: string }> {
  if (!agent || !agent.sessionId) return { ok: false, target: '', command: '' };

  // Always create a fresh pane — never reuse, to avoid sending keys to wrong pane
  const provisionCfg: Partial<ProvisionConfig> = {};
  const result = provisionPane(provisionCfg);
  const target = result.target;
  await new Promise(r => setTimeout(r, 500));

  let meta: any = {};
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      meta = raw.metadata?.[agent.name] || {};
    }
  } catch {}

  const agentFlag = meta.template || agent.template?.name;
  const parts = ['copilot'];
  if (agentFlag) parts.push(`--agent=${agentFlag}`);
  parts.push(`--resume=${agent.sessionId}`);
  const model = meta.model;
  if (model) parts.push(`--model=${model}`);
  const flags = meta.flags || [];
  for (const f of flags) parts.push(f.startsWith('--') ? f : `--${f}`);
  const cmd = parts.join(' ');

  const ok = sendToPane(target, cmd);
  if (ok) {
    updatePaneMapping(agent.name, target);
    clearStoppedAt(agent.name);
    // Store pane PID for reliable matching
    const panes = listPanes();
    const matchedPane = panes.find(p => p.target === target);
    if (matchedPane) {
      withSessionFile(raw => {
        if (raw.agents?.[agent.name]) {
          raw.agents[agent.name].panePid = matchedPane.pid;
        }
      });
    }
  }
  return { ok, target, command: cmd };
}

// Agent-to-agent relay: auto-resolves panes, wraps return address
// If target agent is stopped/idle with no pane, auto-wakes it first
router.post('/relay', async (req, res) => {
  const { from, to, message } = req.body;
  if (!from || !to || !message) {
    return res.status(400).json({ error: 'from, to, and message required' });
  }

  const sender = getAgent(from);
  let receiver = getAgent(to);
  if (!receiver) return res.status(404).json({ error: `Agent "${to}" not found` });

  let woke = false;
  let wakeTarget: string | null = null;

  // Auto-wake: if receiver has no pane but has a session ID, resume it
  if (!receiver.pane && receiver.sessionId) {
    const resumed = await resumeAgent(receiver);
    if (!resumed.ok) return res.status(500).json({ error: `Failed to wake agent "${to}"` });
    woke = true;
    wakeTarget = resumed.target;
    pushEvent('agent_resumed', `Auto-woke ${receiver.name} for relay from ${sender?.name || from}`, 'info', receiver.name);
    // Poll until copilot prompt is ready (up to 30s)
    const readyTarget = wakeTarget;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const output = capturePane(readyTarget, 5);
        // Copilot shows this line when ready for input
        if (output.includes('switch mode') || output.includes('for shortcuts') || output.includes('for commands')) break;
      } catch {}
    }
  }

  const target = wakeTarget || receiver.pane?.target;
  if (!target) return res.status(400).json({ error: `Agent "${to}" has no active pane` });

  const envelope = wrapEnvelope(from, to, message);
  const ok = sendToPane(target, envelope, true);
  if (ok) pushEvent('relay', `Relay from ${sender?.name || from} → ${receiver.name}${woke ? ' (auto-woke)' : ''}`, 'info', receiver.name);
  recordRelay(sender?.name || from, receiver.name, message);
  res.json({
    success: ok,
    from: sender?.name || from,
    to: receiver.name,
    target,
    woke,
    senderPane: sender?.pane?.target || 'unknown',
    senderSession: sender?.id || 'unknown',
  });
});

// Mark agent as stopped in agent-sessions.json
function markStopped(agentName: string, sessionId?: string) {
  withSessionFile(raw => {
    const agents = raw.agents || {};
    const key = Object.keys(agents).find(k => {
      const v = agents[k];
      return sessionId && (v.session || v.sessionId || v.session_id) === sessionId;
    }) || agentName;
    if (agents[key]) {
      agents[key].stoppedAt = new Date().toISOString();
      raw.agents = agents;
    }
  });
}

// Remove psmux_layout entry for an agent (prevents stale mapping after pane renumber)
function removePaneMapping(agentName: string) {
  withSessionFile(raw => {
    const layout = raw.psmux_layout || {};
    for (const [sess, panes] of Object.entries(layout as Record<string, any>)) {
      if (sess.startsWith('_')) continue;
      for (const [key, name] of Object.entries(panes as Record<string, string>)) {
        if (name === agentName) delete panes[key];
      }
    }
    raw.psmux_layout = layout;
  });
}

// Stop agent
router.post('/:id/stop', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // No pane — just mark as stopped
  if (!agent.pane) {
    markStopped(agent.name, agent.sessionId);
    removePaneMapping(agent.name);
    pushEvent('agent_stopped', `Agent ${agent.name} marked as stopped`, 'info', agent.name);
    return res.json({ success: true, method: 'marked' });
  }

  const target = agent.pane.target;
  removePaneMapping(agent.name);
  markStopped(agent.name, agent.sessionId);
  sendKeys(target, 'C-c', false);
  setTimeout(() => { sendKeys(target, '/exit'); }, 300);
  setTimeout(() => {
    sendKeys(target, 'exit');
    pushEvent('agent_stopped', `Agent ${agent.name} stopped`, 'info', agent.name);
    res.json({ success: true, target, method: 'psmux' });
  }, 800);
});

// Resume agent by session ID — auto-provisions pane if no target given
router.post('/:id/resume', async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!agent.sessionId) return res.status(400).json({ error: 'No session ID to resume' });

  const allPanes = listPanes();
  let target: string;
  let how: string = 'explicit';

  try {
    if (req.body.target) {
      const pane = allPanes.find(p => p.target === req.body.target);
      if (!pane) return res.status(400).json({ error: `Pane "${req.body.target}" does not exist.` });
      if (!isPaneFree(pane)) {
        return res.status(400).json({ error: `Pane "${req.body.target}" is occupied.` });
      }
      target = req.body.target;
    } else {
      const provisionCfg: Partial<ProvisionConfig> = {};
      if (req.body.session) provisionCfg.defaultSession = req.body.session;
      if (req.body.maxPanesPerWindow) provisionCfg.maxPanesPerWindow = parseInt(req.body.maxPanesPerWindow);

      const result = provisionPane(provisionCfg, isPaneFree);
      target = result.target;
      how = result.created;

      if (how !== 'reused') {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'Failed to provision pane' });
  }

  // Build command from persisted metadata + request overrides
  let meta: any = {};
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      meta = raw.metadata?.[agent.name] || {};
    }
  } catch {}

  const agentFlag = meta.template || agent.template?.name;
  let cmd = req.body.command;
  if (!cmd) {
    const parts = ['copilot'];
    if (agentFlag) parts.push(`--agent=${agentFlag}`);
    parts.push(`--resume=${agent.sessionId}`);
    const model = req.body.model || meta.model;
    if (model) parts.push(`--model=${model}`);
    const flags = req.body.flags || meta.flags || [];
    for (const f of flags) parts.push(f.startsWith('--') ? f : `--${f}`);
    cmd = parts.join(' ');
  }
  const ok = sendToPane(target, cmd);
  if (ok) {
    updatePaneMapping(agent.name, target);
    clearStoppedAt(agent.name);
    pushEvent('agent_resumed', `Agent ${agent.name} resumed in ${target} (${how})`, 'info', agent.name);
  }
  res.json({ success: ok, target, command: cmd, sessionId: agent.sessionId, provisioned: how });
});

// Start agent session — from existing agent or template name
router.post('/:id/start', async (req, res) => {
  // Try to find existing agent first, then fall back to template name
  let agent = getAgent(req.params.id);
  let templateName: string;

  if (agent) {
    templateName = agent.template?.name || agent.name;
  } else {
    // Check if :id is a template name, otherwise use as plain agent name
    const templates = loadAgentTemplates();
    const template = templates.find(t => t.name === req.params.id);
    templateName = template?.name || req.params.id;
  }

  let target: string;
  let how = 'explicit';

  if (req.body.target) {
    target = req.body.target;
  } else {
    try {
      const result = provisionPane(
        { defaultSession: req.body.session, maxPanesPerWindow: req.body.maxPanesPerWindow },
        isPaneFree,
      );
      target = result.target;
      how = result.created;
      if (how !== 'reused') await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      return res.status(500).json({ error: e.message || 'Failed to provision pane' });
    }
  }

  // Build command from persisted metadata + request overrides
  let meta: any = {};
  try {
    if (existsSync(SESSION_MAP_FILE) && agent) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      meta = raw.metadata?.[agent.name] || {};
    }
  } catch {}

  let cmd = req.body.command;
  if (!cmd) {
    const parts = ['copilot'];
    const agentTemplate = meta.template || (loadAgentTemplates().some(t => t.name === templateName) ? templateName : null);
    if (agentTemplate) parts.push(`--agent=${agentTemplate}`);
    const model = req.body.model || meta.model;
    if (model) parts.push(`--model=${model}`);
    const flags = req.body.flags || meta.flags || [];
    for (const f of flags) parts.push(f.startsWith('--') ? f : `--${f}`);
    cmd = parts.join(' ');
  }
  const ok = sendToPane(target, cmd);
  if (ok) {
    updatePaneMapping(templateName, target);
    clearStoppedAt(templateName);
    pushEvent('agent_started', `Agent ${templateName} started in ${target} (${how})`, 'info', templateName);
  }
  res.json({ success: ok, target, command: cmd, provisioned: how });
});

// Update agent settings (name, description, template, model, flags, envVars)
router.put('/:id/settings', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, description, template, model, flags, envVars } = req.body as {
    name?: string; description?: string; template?: string;
    model?: string; flags?: string[]; envVars?: Record<string, string>;
  };

  try {
    const result = withSessionFileReturn(raw => {
      const agents = raw.agents || {};

      let key = Object.keys(agents).find(k => {
        const v = agents[k];
        return (v.session || v.sessionId || v.session_id) === agent.sessionId;
      });
      if (!key) key = agent.name;

      if (name && name !== key) {
        const entry = agents[key];
        delete agents[key];
        // Also move metadata
        if (raw.metadata?.[key]) {
          if (!raw.metadata[name]) raw.metadata[name] = {};
          Object.assign(raw.metadata[name], raw.metadata[key]);
          delete raw.metadata[key];
        }
        agents[name] = entry;
        key = name;
      }

      if (!raw.metadata) raw.metadata = {};
      if (!raw.metadata[key]) raw.metadata[key] = {};
      const meta = raw.metadata[key];

      if (description !== undefined) meta.description = description;
      if (template !== undefined) meta.template = template;
      if (model !== undefined) meta.model = model;
      if (flags !== undefined) meta.flags = flags;
      if (envVars !== undefined) meta.envVars = envVars;

      raw.agents = agents;
      return { key, meta };
    });

    const updated = getAgent(req.params.id) || agent;
    res.json({ ...updated, name: result.key, ...result.meta });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to update settings' });
  }
});

// Delete agent from agent-sessions.json
router.delete('/:id/settings', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    withSessionFile(raw => {
      const agents = raw.agents || {};
      const key = Object.keys(agents).find(k => {
        const v = agents[k];
        return (v.session || v.sessionId || v.session_id) === agent.sessionId;
      }) || agent.name;
      delete agents[key];
      raw.agents = agents;
      if (raw.metadata?.[key]) delete raw.metadata[key];
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to delete agent' });
  }
});

// ── Task status (in-memory) ─────────────────────────────────────
// Lightweight "what am I working on" — stored in memory, shown on dashboard
const agentTasks = new Map<string, { task: string; updatedAt: string }>();

router.post('/:id/task', (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'task string required' });
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  agentTasks.set(agent.id, { task, updatedAt: new Date().toISOString() });
  pushEvent('task', `${agent.name}: ${task}`, 'info', agent.name);
  res.json({ ok: true, agent: agent.name, task });
});

router.get('/:id/task', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const entry = agentTasks.get(agent.id);
  res.json(entry || { task: null });
});

export function getAgentTask(idOrName: string): string | null {
  return agentTasks.get(idOrName)?.task || null;
}

export function getAllAgentTasks(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, entry] of agentTasks) result[id] = entry.task;
  return result;
}

// ── Broadcast (relay to ALL agents) ─────────────────────────────
router.post('/broadcast', (req, res) => {
  const { from, message } = req.body;
  if (!from || !message) return res.status(400).json({ error: 'from and message required' });

  const sender = getAgent(from);
  if (!sender) return res.status(404).json({ error: `Sender "${from}" not found` });

  const agents = getAllAgents().filter(a => a.name !== sender.name && a.pane);
  const delivered: string[] = [];
  const failed: string[] = [];

  for (const agent of agents) {
    try {
      const formatted = `[broadcast from ${sender.name}]: ${message}`;
      sendKeys(agent.pane!.target, formatted, true);
      recordRelay(sender.name, agent.name, message);
      delivered.push(agent.name);
    } catch {
      failed.push(agent.name);
    }
  }

  pushEvent('broadcast', `${sender.name} → ${delivered.length} agents: ${message.slice(0, 100)}`, 'info', sender.name);
  res.json({ ok: true, delivered, failed, total: agents.length });
});

// ── Spawn (create new agent in a new pane) ──────────────────────
router.post('/spawn', async (req, res) => {
  const { name, template, model, flags, session: sessionName } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Provision a pane
  const psmuxSession = sessionName || 'town';
  const config: Partial<ProvisionConfig> = { defaultSession: psmuxSession };

  try {
    const pane = provisionPane(config, isPaneFree);
    if (!pane?.target) return res.status(500).json({ error: 'Failed to provision pane' });

    // Build copilot command
    const parts = ['copilot'];
    if (template) parts.push(`--agent=${template}`);
    if (model) parts.push(`--model=${model}`);
    if (flags && Array.isArray(flags)) {
      for (const f of flags) parts.push(f);
    }
    const cmd = parts.join(' ');

    // Small delay for pane to initialize
    await new Promise(r => setTimeout(r, 500));
    sendKeys(pane.target, cmd, true);

    // Register in agent-sessions.json
    withSessionFile(raw => {
      if (!raw.agents) raw.agents = {};
      raw.agents[name] = {
        session: '',   // will be filled by session hook or register tool
        displayName: name,
        startedAt: new Date().toISOString(),
      };
      // Store metadata (model, flags)
      if (model || (flags && flags.length)) {
        if (!raw.metadata) raw.metadata = {};
        raw.metadata[name] = {
          ...(raw.metadata[name] || {}),
          ...(model ? { model } : {}),
          ...(flags && flags.length ? { flags } : {}),
          ...(template ? { template } : {}),
        };
      }
      // Track pane layout
      if (!raw.psmux_layout) raw.psmux_layout = {};
      const [sn, wp] = pane.target.split(':');
      if (!raw.psmux_layout[sn]) raw.psmux_layout[sn] = {};
      raw.psmux_layout[sn][wp] = name;
    });

    // Title the psmux window to the agent name
    try {
      const windowTarget = pane.target.replace(/\.\d+$/, '');
      renameWindow(windowTarget, name);
    } catch {}

    pushEvent('spawn', `Spawned ${name} in ${pane.target} with: ${cmd}`, 'info', name);
    res.json({ ok: true, name, pane: pane.target, command: cmd });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to spawn agent' });
  }
});

// ── Prune stale entries from agent-sessions.json ─────────────────
router.post('/prune', (_req, res) => {
  try {
    // Read before
    const beforeRaw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { agents: {} };
    const beforeCount = Object.keys(beforeRaw.agents || {}).length;

    // Force re-cleanup
    cleanSessionFile(true);

    const afterRaw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { agents: {} };
    const afterCount = Object.keys(afterRaw.agents || {}).length;
    const removed = beforeCount - afterCount;

    res.json({ ok: true, before: beforeCount, after: afterCount, removed });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
