import { getClient, type CopilotSession } from './copilot-sdk.js';
import { approveAll, defineTool } from '@github/copilot-sdk';
import { getAllAgents } from './agents.js';
import { pushEvent } from './events.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

// ── Types ────────────────────────────────────────────────────────

export interface HeadlessAgent {
  name: string;
  sessionId: string;
  model: string;
  session: CopilotSession;
  status: 'running' | 'idle' | 'stopped';
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

// Active headless sessions — keyed by agent name
const _headlessAgents = new Map<string, HeadlessAgent>();

// ── Agent Lifecycle ──────────────────────────────────────────────

/**
 * Create a headless agent — an SDK session with no terminal pane.
 * Registers collaboration tools so the agent can interact with the town.
 */
export async function createHeadlessAgent(
  name: string,
  options?: { model?: string; systemPrompt?: string }
): Promise<HeadlessAgent> {
  if (_headlessAgents.has(name)) {
    throw new Error(`Headless agent "${name}" already exists`);
  }

  const client = await getClient();
  const model = options?.model || 'claude-sonnet-4';

  const session = await client.createSession({
    model,
    onPermissionRequest: approveAll,
  });

  // Session ID is a direct property
  const sessionId = (session as any).sessionId || `headless-${Date.now()}`;

  const agent: HeadlessAgent = {
    name,
    sessionId,
    model,
    session,
    status: 'idle',
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
    messageCount: 0,
  };

  // Register collaboration tools on the session
  registerAgentTools(session, name);

  _headlessAgents.set(name, agent);

  // Register in agent-sessions.json
  registerHeadlessInSessionFile(name, sessionId);

  pushEvent('spawn', `Headless agent "${name}" created (model: ${model})`, 'info', name);
  return agent;
}

/** Rich response from a headless agent interaction */
export interface HeadlessResponse {
  response: string;
  messageId?: string;
  thinking?: string;
  outputTokens?: number;
  toolRequests?: any[];
  interactionId?: string;
}

/**
 * Send a message to a headless agent and get its full response.
 * Returns content, thinking/reasoning, token count, and tool requests.
 */
export async function sendToHeadless(
  name: string,
  message: string,
  options?: { timeoutMs?: number }
): Promise<HeadlessResponse> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  agent.status = 'running';
  agent.lastMessageAt = new Date().toISOString();
  agent.messageCount++;

  try {
    const timeoutMs = options?.timeoutMs || 120_000;
    const result = await Promise.race([
      agent.session.sendAndWait({ prompt: message }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Headless agent timed out')), timeoutMs)
      ),
    ]);

    const data = (result as any)?.data || {};
    agent.status = 'idle';
    return {
      response: data.content || '',
      messageId: data.messageId,
      thinking: data.reasoningText || undefined,
      outputTokens: data.outputTokens || undefined,
      toolRequests: data.toolRequests?.length ? data.toolRequests : undefined,
      interactionId: data.interactionId || undefined,
    };
  } catch (e) {
    agent.status = 'idle';
    throw e;
  }
}

/**
 * Get structured conversation history for a headless agent.
 */
export async function getHeadlessMessages(name: string): Promise<any[]> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  const raw = await agent.session.getMessages();
  // Parse into structured format
  return raw.map((m: any) => {
    const base = { type: m.type, id: m.id, timestamp: m.timestamp, parentId: m.parentId };
    switch (m.type) {
      case 'user.message':
        return { ...base, prompt: m.data?.prompt };
      case 'assistant.message':
        return {
          ...base,
          content: m.data?.content,
          thinking: m.data?.reasoningText || undefined,
          outputTokens: m.data?.outputTokens,
          toolRequests: m.data?.toolRequests?.length ? m.data.toolRequests : undefined,
        };
      case 'tool.call':
        return { ...base, toolName: m.data?.name, args: m.data?.arguments };
      case 'tool.result':
        return { ...base, toolName: m.data?.name, result: m.data?.result };
      default:
        return base;
    }
  });
}

/**
 * Destroy a headless agent — disconnect session and remove from tracking.
 */
export async function destroyHeadlessAgent(name: string): Promise<boolean> {
  const agent = _headlessAgents.get(name);
  if (!agent) return false;

  try { await agent.session.disconnect(); } catch {}
  try { await agent.session.destroy(); } catch {}
  _headlessAgents.delete(name);

  // Remove from agent-sessions.json (headless agents are ephemeral)
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    if (raw.agents?.[name]) {
      delete raw.agents[name];
    }
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch {}

  pushEvent('agent_stopped', `Headless agent "${name}" destroyed`, 'info', name);
  return true;
}

/**
 * Promote: detach SDK handle so the session can be resumed in a terminal pane.
 * Returns the session ID for `copilot --resume=<id>`.
 * The headless agent is removed from the in-memory map but the session stays alive.
 */
export async function detachHeadless(name: string): Promise<{ sessionId: string; model: string }> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  const { sessionId, model } = agent;

  // Disconnect SDK handle — session persists server-side
  try { await agent.session.disconnect(); } catch {}
  _headlessAgents.delete(name);

  // Update agent-sessions.json: remove headless type, keep the session registered
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    if (raw.agents?.[name]) {
      delete raw.agents[name].type;  // no longer headless
    }
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch {}

  pushEvent('mode_switch', `Agent "${name}" promoted: headless → pane`, 'info', name);
  return { sessionId, model };
}

/**
 * Demote: take over an existing copilot session into headless mode via SDK.
 * The caller must ensure the terminal copilot process is stopped first.
 */
export async function attachHeadless(
  name: string,
  sessionId: string,
  options?: { model?: string }
): Promise<HeadlessAgent> {
  if (_headlessAgents.has(name)) {
    throw new Error(`Headless agent "${name}" already exists`);
  }

  const client = await getClient();
  const model = options?.model || 'claude-sonnet-4';

  // Resume the existing session via SDK
  const session = await client.resumeSession(sessionId, {
    onPermissionRequest: approveAll,
  });

  const agent: HeadlessAgent = {
    name,
    sessionId,
    model,
    session,
    status: 'idle',
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
    messageCount: 0,
  };

  registerAgentTools(session, name);
  _headlessAgents.set(name, agent);

  // Update agent-sessions.json: mark as headless
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    if (!raw.agents) raw.agents = {};
    if (!raw.agents[name]) {
      raw.agents[name] = { session: sessionId, displayName: name, startedAt: new Date().toISOString() };
    }
    raw.agents[name].type = 'headless';
    delete raw.agents[name].stoppedAt;
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch {}

  pushEvent('mode_switch', `Agent "${name}" demoted: pane → headless`, 'info', name);
  return agent;
}

// ── Queries ──────────────────────────────────────────────────────

export function getHeadlessAgent(name: string): HeadlessAgent | undefined {
  return _headlessAgents.get(name);
}

export function listHeadlessAgents(): HeadlessAgent[] {
  return Array.from(_headlessAgents.values());
}

export function isHeadless(name: string): boolean {
  return _headlessAgents.has(name);
}

// ── Collaboration Tools ──────────────────────────────────────────

/**
 * Register tools on a headless agent session so it can interact with the town.
 */
function registerAgentTools(session: CopilotSession, agentName: string) {
  session.registerTools([
    defineTool('get_agents', {
      description: 'Get the list of all agents in Copilot Town with their status.',
      parameters: {},
      handler: async () => {
        const agents = getAllAgents();
        return agents.map(a => ({
          name: a.name,
          status: a.status,
          type: (a as any).type || 'pane',
          sessionId: a.sessionId?.slice(0, 8),
        }));
      },
    }),
    defineTool('relay_message', {
      description: 'Send a message to another agent in Copilot Town.',
      parameters: {
        to: { type: 'string', description: 'Target agent name' },
        message: { type: 'string', description: 'Message to send' },
      },
      handler: async (params: any) => {
        const http = await import('http');
        return new Promise<string>((resolve) => {
          const body = JSON.stringify({ from: agentName, to: params.to, message: params.message });
          const req = http.request({
            hostname: '127.0.0.1', port: 3848,
            path: '/api/agents/relay', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.response) resolve(`Response from ${params.to}: ${result.response}`);
                else resolve(`Message delivered to ${params.to}`);
              } catch { resolve(`Relay sent to ${params.to}`); }
            });
          });
          req.on('error', () => resolve(`Failed to relay to ${params.to}`));
          req.write(body);
          req.end();
        });
      },
    }),
    defineTool('share_note', {
      description: 'Share a note with the team — a key-value pair any agent can read.',
      parameters: {
        key: { type: 'string', description: 'Note key' },
        value: { type: 'string', description: 'Note content' },
      },
      handler: async (params: any) => {
        try {
          const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
          if (!raw.notes) raw.notes = {};
          raw.notes[params.key] = {
            value: params.value,
            author: agentName,
            updatedAt: new Date().toISOString(),
          };
          writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
          return `Note "${params.key}" shared`;
        } catch (e: any) {
          return `Failed to share note: ${e.message}`;
        }
      },
    }),
    defineTool('read_notes', {
      description: 'Read shared notes from the team.',
      parameters: {
        key: { type: 'string', description: 'Note key (optional — omit for all notes)' },
      },
      handler: async (params: any) => {
        try {
          const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
          const notes = raw.notes || {};
          if (params.key) {
            const note = notes[params.key];
            return note ? `${params.key}: ${note.value} (by ${note.author})` : 'Note not found';
          }
          return Object.entries(notes)
            .map(([k, v]: any) => `${k}: ${v.value.slice(0, 100)} (by ${v.author})`)
            .join('\n') || 'No notes';
        } catch {
          return 'Failed to read notes';
        }
      },
    }),
    defineTool('set_status', {
      description: 'Set your current task/status text for the dashboard.',
      parameters: {
        task: { type: 'string', description: 'What you are currently working on' },
      },
      handler: async (params: any) => {
        pushEvent('task', `${agentName}: ${params.task}`, 'info', agentName);
        return `Status set: "${params.task}"`;
      },
    }),
  ]);
}

// ── Persistence Helper ───────────────────────────────────────────

function registerHeadlessInSessionFile(name: string, sessionId: string) {
  try {
    const dir = join(HOME, '.copilot');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let raw: any = { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
    if (existsSync(SESSION_MAP_FILE)) {
      raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    }
    if (!raw.agents) raw.agents = {};
    raw.agents[name] = {
      session: sessionId,
      displayName: name,
      startedAt: new Date().toISOString(),
      type: 'headless',
    };
    delete raw.agents[name].stoppedAt;
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
  } catch {}
}

// ── Cleanup ──────────────────────────────────────────────────────

export async function destroyAllHeadless(): Promise<void> {
  for (const [name] of _headlessAgents) {
    await destroyHeadlessAgent(name);
  }
}
