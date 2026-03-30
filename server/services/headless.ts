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
  reasoningEffort?: string;
  agentMode?: string;
  toolActivity: ToolActivityEntry[];
  /** User prompts indexed by message count (SDK doesn't persist these) */
  userPrompts: { prompt: string; timestamp: string }[];
}

export interface ToolActivityEntry {
  timestamp: string;
  tool: string;
  args?: any;
  result?: string;
  duration?: number;
}

export interface Attachment {
  type: 'file' | 'directory' | 'blob' | 'selection';
  path?: string;
  data?: string;
  mimeType?: string;
  displayName?: string;
  text?: string;
}

// Active headless sessions — keyed by agent name
const _headlessAgents = new Map<string, HeadlessAgent>();

// Event subscribers for streaming — keyed by agent name
type StreamListener = (event: any) => void;
const _streamListeners = new Map<string, Set<StreamListener>>();

export function addStreamListener(name: string, listener: StreamListener) {
  if (!_streamListeners.has(name)) _streamListeners.set(name, new Set());
  _streamListeners.get(name)!.add(listener);
}
export function removeStreamListener(name: string, listener: StreamListener) {
  _streamListeners.get(name)?.delete(listener);
}

// ── System Prompt Builder ────────────────────────────────────────

function buildSystemMessage(name: string, role?: string) {
  const identity = `You are "${name}", an AI agent in Copilot Town — a multi-agent collaboration environment.`;
  const instructions = [
    'You can see other agents via the get_agents tool and message them via relay_message.',
    'Share knowledge with share_note and read it with read_notes.',
    'Update your status with set_status so the dashboard shows your activity.',
    'Be concise and action-oriented. Collaborate proactively.',
  ].join('\n');
  const roleSection = role ? `\nYour role: ${role}` : '';

  return {
    mode: 'customize' as const,
    sections: {
      identity: { action: 'replace' as const, content: identity + roleSection },
    },
    content: `\n## Copilot Town Collaboration\n${instructions}`,
  };
}

// ── Hooks Builder ────────────────────────────────────────────────

function buildHooks(agent: HeadlessAgent) {
  return {
    onPreToolUse: async (input: any) => {
      pushEvent('tool_use', `${agent.name}: calling ${input.toolName}`, 'info', agent.name);
      return undefined; // don't modify
    },
    onPostToolUse: async (input: any) => {
      const entry: ToolActivityEntry = {
        timestamp: new Date().toISOString(),
        tool: input.toolName,
        args: input.toolArgs,
        result: typeof input.toolResult?.textResultForLlm === 'string'
          ? input.toolResult.textResultForLlm.slice(0, 200)
          : undefined,
      };
      agent.toolActivity.push(entry);
      // Keep last 50 entries
      if (agent.toolActivity.length > 50) agent.toolActivity.shift();

      // Broadcast to stream listeners
      const listeners = _streamListeners.get(agent.name);
      if (listeners?.size) {
        const payload = { type: 'tool_complete', tool: input.toolName, resultType: input.toolResult?.resultType };
        for (const fn of listeners) fn(payload);
      }
      return undefined;
    },
    onUserPromptSubmitted: async (input: any) => {
      pushEvent('user_prompt', `Prompt to ${agent.name}: ${input.prompt.slice(0, 80)}...`, 'info', agent.name);
      return undefined;
    },
    onErrorOccurred: async (input: any) => {
      pushEvent('error', `${agent.name} error: ${input.error}`, 'warn', agent.name);
      return undefined;
    },
  };
}

// ── Agent Lifecycle ──────────────────────────────────────────────

/**
 * Create a headless agent — an SDK session with no terminal pane.
 * Supports streaming, system prompt injection, hooks, and collaboration tools.
 */
export async function createHeadlessAgent(
  name: string,
  options?: { model?: string; systemPrompt?: string; role?: string; reasoningEffort?: string; streaming?: boolean }
): Promise<HeadlessAgent> {
  if (_headlessAgents.has(name)) {
    throw new Error(`Headless agent "${name}" already exists`);
  }

  const client = await getClient();
  const model = options?.model || 'claude-sonnet-4';

  // Build agent shell first for hook references
  const agent: HeadlessAgent = {
    name,
    sessionId: '', // filled after session creation
    model,
    session: null as any, // filled below
    status: 'idle',
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
    messageCount: 0,
    reasoningEffort: options?.reasoningEffort,
    toolActivity: [],
    userPrompts: [],
  };

  const sessionConfig: any = {
    model,
    streaming: options?.streaming !== false, // default ON
    onPermissionRequest: approveAll,
    systemMessage: buildSystemMessage(name, options?.role || options?.systemPrompt),
    hooks: buildHooks(agent),
  };
  if (options?.reasoningEffort) {
    sessionConfig.reasoningEffort = options.reasoningEffort;
  }

  const session = await client.createSession(sessionConfig);
  const sessionId = (session as any).sessionId || `headless-${Date.now()}`;

  agent.session = session;
  agent.sessionId = sessionId;

  // Wire streaming events to listeners
  wireStreamingEvents(session, name, agent);

  // Register collaboration tools on the session
  registerAgentTools(session, name);
  _headlessAgents.set(name, agent);
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

/** Wire SDK streaming events to broadcast listeners */
function wireStreamingEvents(session: CopilotSession, name: string, agent: HeadlessAgent) {
  const sess = session as any;
  const emit = (payload: any) => {
    const listeners = _streamListeners.get(name);
    if (listeners?.size) for (const fn of listeners) fn(payload);
  };

  sess.on('assistant.turn_start', () => emit({ type: 'turn_start' }));
  sess.on('assistant.message_delta', (e: any) => {
    emit({ type: 'message_delta', content: e?.data?.deltaContent || '' });
  });
  sess.on('assistant.streaming_delta', (e: any) => {
    emit({ type: 'streaming_delta', content: e?.data?.deltaContent || '' });
  });
  sess.on('assistant.reasoning', (e: any) => {
    emit({ type: 'reasoning', content: e?.data?.reasoningText || '', hasReasoning: true });
  });
  sess.on('assistant.reasoning_delta', (e: any) => {
    emit({ type: 'reasoning_delta', content: e?.data?.deltaContent || '' });
  });
  sess.on('assistant.usage', (e: any) => {
    emit({
      type: 'usage',
      model: e?.data?.model,
      inputTokens: e?.data?.inputTokens,
      outputTokens: e?.data?.outputTokens,
      cost: e?.data?.cost,
      duration: e?.data?.duration,
    });
  });
  sess.on('assistant.turn_end', () => {
    agent.status = 'idle';
    emit({ type: 'turn_end' });
  });
  sess.on('tool.execution_start', (e: any) => {
    emit({ type: 'tool_start', tool: e?.data?.toolName || e?.data?.name });
  });
  sess.on('assistant.intent', (e: any) => {
    emit({ type: 'intent', intent: e?.data?.intent || e?.data?.content });
  });
}

/**
 * Send a message to a headless agent and get its full response.
 * Supports file/blob/directory attachments.
 */
export async function sendToHeadless(
  name: string,
  message: string,
  options?: { timeoutMs?: number; attachments?: Attachment[] }
): Promise<HeadlessResponse> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  agent.status = 'running';
  agent.lastMessageAt = new Date().toISOString();
  agent.messageCount++;
  agent.userPrompts.push({ prompt: message, timestamp: new Date().toISOString() });

  try {
    const timeoutMs = options?.timeoutMs || 120_000;
    const sendOpts: any = { prompt: message };
    if (options?.attachments?.length) {
      sendOpts.attachments = options.attachments;
    }
    const result = await Promise.race([
      agent.session.sendAndWait(sendOpts),
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
  // SDK user.message events lack prompt text — inject from our stored prompts
  let promptIdx = 0;
  return raw.map((m: any) => {
    const base = { type: m.type, id: m.id, timestamp: m.timestamp, parentId: m.parentId };
    switch (m.type) {
      case 'user.message': {
        const stored = agent.userPrompts[promptIdx++];
        return { ...base, prompt: m.data?.prompt || stored?.prompt || '' };
      }
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

// ── Model Switching ──────────────────────────────────────────────

/**
 * Change model and/or reasoning effort on a running headless agent mid-session.
 */
export async function setHeadlessModel(
  name: string,
  model: string,
  options?: { reasoningEffort?: string }
): Promise<{ model: string; reasoningEffort?: string }> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  const setModelOpts: any = {};
  if (options?.reasoningEffort) setModelOpts.reasoningEffort = options.reasoningEffort;

  await (agent.session as any).setModel(model, setModelOpts);
  agent.model = model;
  if (options?.reasoningEffort) agent.reasoningEffort = options.reasoningEffort;

  pushEvent('model_change', `${name}: model → ${model}${options?.reasoningEffort ? ` (${options.reasoningEffort})` : ''}`, 'info', name);
  return { model, reasoningEffort: options?.reasoningEffort };
}

// ── Agent Mode Control ───────────────────────────────────────────

/**
 * Switch headless agent between interactive, plan, and autopilot modes.
 */
export async function setHeadlessMode(
  name: string,
  mode: 'interactive' | 'plan' | 'autopilot'
): Promise<{ mode: string }> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  const result = await (agent.session as any).rpc.mode.set({ mode });
  agent.agentMode = result?.mode || mode;

  pushEvent('mode_switch', `${name}: mode → ${mode}`, 'info', name);
  return { mode: agent.agentMode! };
}

/**
 * Get the current agent mode.
 */
export async function getHeadlessMode(name: string): Promise<{ mode: string }> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  const result = await (agent.session as any).rpc.mode.get();
  agent.agentMode = result?.mode;
  return { mode: result?.mode || 'unknown' };
}

/**
 * Get tool activity log for a headless agent.
 */
export function getToolActivity(name: string): ToolActivityEntry[] {
  const agent = _headlessAgents.get(name);
  if (!agent) return [];
  return agent.toolActivity;
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

  // Mark as stopped in agent-sessions.json (don't delete — keep for history)
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    if (raw.agents?.[name]) {
      raw.agents[name].stoppedAt = new Date().toISOString();
      raw.agents[name].type = 'headless';
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

  const agent: HeadlessAgent = {
    name,
    sessionId,
    model,
    session: null as any,
    status: 'idle',
    createdAt: new Date().toISOString(),
    lastMessageAt: null,
    messageCount: 0,
    toolActivity: [],
    userPrompts: [],
  };

  // Resume the existing session via SDK with hooks
  const session = await client.resumeSession(sessionId, {
    streaming: true,
    onPermissionRequest: approveAll,
    hooks: buildHooks(agent),
  } as any);

  agent.session = session;
  wireStreamingEvents(session, name, agent);
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
