import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getAllAgents, getAgent, getAgentMdContent, loadAgentTemplates } from '../services/agents.js';
import { capturePane, sendKeys, listPanes, provisionPane, type ProvisionConfig } from '../services/psmux.js';
import { recordRelay } from './relays.js';
import { pushEvent } from '../services/events.js';

const router = Router();
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

// Update psmux_layout in agent-sessions.json when an agent is assigned to a pane
function updatePaneMapping(agentName: string, paneTarget: string) {
  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    const layout = raw.psmux_layout || {};

    // Parse target: "session:window.pane"
    const [sessionName, wp] = paneTarget.split(':');
    if (!sessionName || !wp) return;

    // Remove old mapping for this agent from all sessions
    for (const [sess, panes] of Object.entries(layout as Record<string, any>)) {
      if (sess.startsWith('_')) continue;
      for (const [key, name] of Object.entries(panes as Record<string, string>)) {
        if (name === agentName) delete panes[key];
      }
    }

    // Add new mapping
    if (!layout[sessionName]) layout[sessionName] = {};
    layout[sessionName][wp] = agentName;
    raw.psmux_layout = layout;

    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch (e) {
    console.error('Failed to update pane mapping:', e);
  }
}

// Clear stoppedAt when an agent is resumed/started
function clearStoppedAt(agentName: string) {
  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    const agents = raw.agents || {};
    if (agents[agentName]) {
      delete agents[agentName].stoppedAt;
      agents[agentName].startedAt = new Date().toISOString();
      raw.agents = agents;
      writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
    }
  } catch { /* ignore */ }
}

// Build message envelope with return-address metadata
function wrapEnvelope(from: string, to: string, message: string): string {
  const sender = getAgent(from);
  const senderPane = sender?.pane?.target || '?';
  const senderSid = sender?.id?.slice(0, 8) || '?';
  const senderName = sender?.name || from;

  return [
    `[relay from=${senderName} pane=${senderPane} sid=${senderSid}]`,
    message,
    `[reply with: relay_message(to="${senderName}", message="...")]`,
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

// ── Agent CRUD ────────────────────────────────────────────────────

// List all agents
router.get('/', (_req, res) => {
  res.json(getAllAgents());
});

// Get single agent detail (by session ID or name)
router.get('/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const mdContent = agent.template ? getAgentMdContent(agent.template.name) : null;
  res.json({ ...agent, mdContent });
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

// Agent-to-agent relay: auto-resolves panes, wraps return address
router.post('/relay', (req, res) => {
  const { from, to, message } = req.body;
  if (!from || !to || !message) {
    return res.status(400).json({ error: 'from, to, and message required' });
  }

  const sender = getAgent(from);
  const receiver = getAgent(to);
  if (!receiver) return res.status(404).json({ error: `Agent "${to}" not found` });
  if (!receiver.pane) return res.status(400).json({ error: `Agent "${to}" has no active pane` });

  const envelope = wrapEnvelope(from, to, message);
  const target = receiver.pane.target;
  const ok = sendToPane(target, envelope, true);
  if (ok) pushEvent('relay', `Relay from ${sender?.name || from} → ${receiver.name}`, 'info', receiver.name);
  recordRelay(sender?.name || from, receiver.name, message);
  res.json({
    success: ok,
    from: sender?.name || from,
    to: receiver.name,
    target,
    senderPane: sender?.pane?.target || 'unknown',
    senderSession: sender?.id || 'unknown',
  });
});

// Mark agent as stopped in agent-sessions.json
function markStopped(agentName: string, sessionId?: string) {
  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    const agents = raw.agents || {};
    const key = Object.keys(agents).find(k => {
      const v = agents[k];
      return sessionId && (v.session || v.sessionId || v.session_id) === sessionId;
    }) || agentName;
    if (agents[key]) {
      agents[key].stoppedAt = new Date().toISOString();
      raw.agents = agents;
      writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
    }
  } catch { /* ignore */ }
}

// Remove psmux_layout entry for an agent (prevents stale mapping after pane renumber)
function removePaneMapping(agentName: string) {
  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    const layout = raw.psmux_layout || {};
    let changed = false;
    for (const [sess, panes] of Object.entries(layout as Record<string, any>)) {
      if (sess.startsWith('_')) continue;
      for (const [key, name] of Object.entries(panes as Record<string, string>)) {
        if (name === agentName) { delete panes[key]; changed = true; }
      }
    }
    if (changed) {
      raw.psmux_layout = layout;
      writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
    }
  } catch { /* ignore */ }
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

  const agentFlag = agent.template?.name || agent.name;
  const cmd = req.body.command || `copilot --agent=${agentFlag} --resume=${agent.sessionId}`;
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
    // Check if :id is a template name
    const templates = loadAgentTemplates();
    const template = templates.find(t => t.name === req.params.id);
    if (!template) return res.status(404).json({ error: 'Agent or template not found' });
    templateName = template.name;
  }

  let target: string;
  let how = 'explicit';

  if (req.body.target) {
    target = req.body.target;
  } else {
    try {
      const result = provisionPane(
        { defaultSession: req.body.session, maxPanesPerWindow: req.body.maxPanesPerWindow },
      );
      target = result.target;
      how = result.created;
      if (how !== 'reused') await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      return res.status(500).json({ error: e.message || 'Failed to provision pane' });
    }
  }

  const cmd = req.body.command || `copilot --agent=${templateName}`;
  const ok = sendToPane(target, cmd);
  if (ok) {
    updatePaneMapping(templateName, target);
    clearStoppedAt(templateName);
    pushEvent('agent_started', `Agent ${templateName} started in ${target} (${how})`, 'info', templateName);
  }
  res.json({ success: ok, target, command: cmd, provisioned: how });
});

// Update agent display name / description
router.put('/:id/settings', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, description } = req.body as { name?: string; description?: string };

  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };

    const agents = raw.agents || {};

    // Find by session ID or name key
    let key = Object.keys(agents).find(k => agents[k] === agent.sessionId);
    if (!key) key = agent.name;

    // If renaming, move the key
    if (name && name !== key) {
      const sid = agents[key];
      delete agents[key];
      agents[name] = sid;
      key = name;
    }

    // Store description in metadata section
    if (description !== undefined) {
      if (!raw.metadata) raw.metadata = {};
      raw.metadata[key] = { ...(raw.metadata[key] || {}), description };
    }

    raw.agents = agents;
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));

    // Re-read the agent to return updated data
    const updated = getAgent(req.params.id) || agent;
    res.json({ ...updated, name: key, description: raw.metadata?.[key]?.description });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to update settings' });
  }
});

// Delete agent from agent-sessions.json
router.delete('/:id/settings', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    const raw = existsSync(SESSION_MAP_FILE)
      ? JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'))
      : { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };

    const agents = raw.agents || {};
    const key = Object.keys(agents).find(k => agents[k] === agent.sessionId) || agent.name;
    delete agents[key];
    raw.agents = agents;

    // Clean up metadata
    if (raw.metadata?.[key]) delete raw.metadata[key];

    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to delete agent' });
  }
});

export default router;
