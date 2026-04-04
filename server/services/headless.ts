import { getClient, type CopilotSession } from './copilot-sdk.js';
import { approveAll } from '@github/copilot-sdk';
import { getAllAgents } from './agents.js';
import { pushEvent } from './events.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');
const _thisDir = fileURLToPath(new URL('.', import.meta.url));
const MCP_COLLAB_SCRIPT = resolvePath(_thisDir, '..', 'mcp-collab.ts');
const PORT = process.env.PORT || '3848';

// ── Types ────────────────────────────────────────────────────────

export interface HeadlessAgent {
  name: string;
  sessionId: string;
  model: string;
  session: CopilotSession;
  status: 'running' | 'idle' | 'stopped';
  createdAt: string;
  lastMessageAt: string | null;
  lastSeen: string;
  messageCount: number;
  reasoningEffort?: string;
  agentMode?: string;
  source?: 'user' | 'workflow';
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

// Circuit breaker for auto-revival to prevent infinite retry loops
const _revivalAttempts = new Map<string, number>();
const MAX_REVIVAL_ATTEMPTS = 2;

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
export function broadcastToAgent(name: string, event: any) {
  const listeners = _streamListeners.get(name);
  if (listeners) listeners.forEach(fn => fn(event));
}

// ── System Prompt Builder ────────────────────────────────────────

function buildSystemMessage(name: string, role?: string) {
  // Gather live context so the agent knows exactly who's around
  const agents = getAllAgents();
  const others = agents
    .filter(a => a.name !== name)
    .map(a => {
      const status = a.status || 'unknown';
      const type = (a as any).type || 'pane';
      const task = (a as any).task || '';
      return `  - ${a.name} (${type}, ${status})${task ? ` — ${task}` : ''}`;
    });

  // Gather shared notes
  let notesSummary = '';
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const notes = raw.notes || {};
    const noteEntries = Object.entries(notes).slice(0, 10);
    if (noteEntries.length > 0) {
      notesSummary = '\n\n## Shared Notes\n' + noteEntries
        .map(([k, v]: any) => `  - **${k}**: ${v.value.slice(0, 200)} (by ${v.author})`)
        .join('\n');
    }
  } catch {}

  const identity = `You are "${name}", an AI agent in Copilot Town — a multi-agent collaboration environment.`;
  const roleSection = role ? `\n\n**Your role:** ${role}` : '';

  const teamSection = others.length > 0
    ? `\n\n## Your Team (${others.length} agents)\n${others.join('\n')}`
    : '\n\n## Your Team\nNo other agents are online yet.';

  const instructions = `
## How to Collaborate

### ⚠️ CRITICAL RULE
**NEVER create scripts, files, or WebSocket code to communicate with other agents.**
**ALWAYS use the relay_message tool directly.** It handles everything — connection, delivery, and response.

### Tools for Collaboration
- **relay_message(to, message)** — Send a message to another agent and get their response. This is the ONLY way to talk to other agents.
- **get_agents()** — See who's online right now (name, status, task).
- **share_note(key, value)** — Post information for the whole team.
- **read_notes(key?)** — Read what others have shared. Omit key for all notes.
- **set_status(task)** — Update your status on the dashboard.

### Communication Tips
- Address agents by name: relay_message(to="researcher", message="What did you find about X?")
- Be specific in messages — the recipient has no context about your conversation.
- When asked to coordinate, proactively reach out rather than waiting.
- Share results via notes so the whole team benefits.
- Do NOT use bash, edit, or create tools to build relay scripts — just call relay_message.`;

  return {
    mode: 'customize' as const,
    sections: {
      identity: { action: 'replace' as const, content: identity + roleSection },
    },
    content: teamSection + notesSummary + '\n' + instructions,
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
  options?: { model?: string; systemPrompt?: string; role?: string; reasoningEffort?: string; streaming?: boolean; source?: 'user' | 'workflow' }
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
    lastSeen: new Date().toISOString(),
    messageCount: 0,
    reasoningEffort: options?.reasoningEffort,
    source: options?.source || 'user',
    toolActivity: [],
    userPrompts: [],
  };

  const sessionConfig: any = {
    model,
    streaming: options?.streaming !== false, // default ON
    onPermissionRequest: approveAll,
    systemMessage: buildSystemMessage(name, options?.role || options?.systemPrompt),
    hooks: buildHooks(agent),
    mcpServers: buildMcpServers(name),
  };
  if (options?.reasoningEffort) {
    sessionConfig.reasoningEffort = options.reasoningEffort;
  }

  const t0 = Date.now();
  const session = await client.createSession(sessionConfig);
  const sessionId = (session as any).sessionId || `headless-${Date.now()}`;
  console.log(`⚡ createSession for "${name}" took ${Date.now() - t0}ms (model: ${model})`);

  agent.session = session;
  agent.sessionId = sessionId;

  // Wire streaming events to listeners
  wireStreamingEvents(session, name, agent);

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
    agent.lastSeen = new Date().toISOString();
  };

  sess.on('assistant.turn_start', () => {
    emit({ type: 'turn_start' });
  });
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
  // assistant.message fires with complete response data before turn_end
  sess.on('assistant.message', (e: any) => {
    const data = e?.data || {};
    emit({
      type: 'response',
      content: data.content || '',
      thinking: data.reasoningText || undefined,
      outputTokens: data.outputTokens,
      messageId: data.messageId,
    });
  });
  sess.on('assistant.turn_end', () => {
    agent.status = 'idle';
    emit({ type: 'turn_end' });
  });
  sess.on('tool.execution_start', (e: any) => {
    const d = e?.data || {};
    emit({
      type: 'tool_start',
      toolCallId: d.toolCallId,
      tool: d.toolName || d.name,
      description: d.description,
      input: d.arguments ?? d.input ?? d.parameters ?? d.args,
    });
  });
  sess.on('tool.execution_complete', (e: any) => {
    const d = e?.data || {};
    // SDK result is { content, detailedContent, contents } — extract the best text
    let output: string | undefined;
    if (d.result) {
      if (typeof d.result === 'string') {
        output = d.result;
      } else {
        output = d.result.detailedContent || d.result.content || JSON.stringify(d.result);
      }
    } else if (d.output) {
      output = typeof d.output === 'string' ? d.output : JSON.stringify(d.output);
    }
    emit({
      type: 'tool_complete',
      toolCallId: d.toolCallId,
      tool: d.toolName || d.name,
      output,
      error: d.error,
      success: d.success,
    });
  });
  sess.on('assistant.intent', (e: any) => {
    emit({ type: 'intent', intent: e?.data?.intent || e?.data?.content });
  });
  // Subagent events
  sess.on('subagent.started', (e: any) => {
    emit({ type: 'subagent_start', name: e?.data?.name || e?.data?.agentName, description: e?.data?.description });
  });
  sess.on('subagent.completed', (e: any) => {
    emit({ type: 'subagent_complete', name: e?.data?.name || e?.data?.agentName });
  });
  // Session mode changes
  sess.on('session.mode_changed', (e: any) => {
    emit({ type: 'mode_changed', mode: e?.data?.mode });
  });

  // Permission request forwarding
  sess.on('permission.request', (e: any) => {
    const d = e?.data || e || {};
    emit({
      type: 'permission_request',
      requestId: d.requestId || d.id,
      tool: d.toolName || d.tool || d.name,
      args: d.arguments || d.args,
    });
  });

  // Error event forwarding
  sess.on('agent.error', (e: any) => {
    const d = e?.data || e || {};
    emit({ type: 'error', message: d.message || d.error || 'Agent error' });
  });

  sess.on('tool.error', (e: any) => {
    const d = e?.data || e || {};
    emit({
      type: 'tool_error',
      tool: d.toolName || d.tool || d.name,
      toolCallId: d.toolCallId,
      error: d.message || d.error || 'Tool execution failed',
    });
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
  let agent = _headlessAgents.get(name);
  if (!agent) {
    // Try auto-revive from session file
    agent = await getOrReviveHeadless(name);
    if (!agent) throw new Error(`Headless agent "${name}" not found`);
  }

  agent.status = 'running';
  agent.lastMessageAt = new Date().toISOString();
  agent.lastSeen = agent.lastMessageAt;
  agent.messageCount++;
  agent.userPrompts.push({ prompt: message, timestamp: new Date().toISOString() });
  persistUserPrompts(name, agent.userPrompts);

  // Broadcast user message to WS listeners so dashboard shows the incoming prompt
  // Extract sender from the [Message from X] envelope if present
  const senderMatch = message.match(/^\[Message from (.+?)\]\n/);
  const fromName = senderMatch?.[1] || 'relay';
  broadcastToAgent(name, { type: 'user_message', prompt: message, from: fromName });

  const doSend = async (a: HeadlessAgent): Promise<HeadlessResponse> => {
    const timeoutMs = options?.timeoutMs || 120_000;
    const sendOpts: any = { prompt: message };
    if (options?.attachments?.length) {
      sendOpts.attachments = options.attachments;
    }
    const t0 = Date.now();
    const result = await Promise.race([
      a.session.sendAndWait(sendOpts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Headless agent timed out')), timeoutMs)
      ),
    ]);
    console.log(`⚡ sendAndWait to "${name}" took ${Date.now() - t0}ms`);


    const data = (result as any)?.data || {};
    a.status = 'idle';
    return {
      response: data.content || '',
      messageId: data.messageId,
      thinking: data.reasoningText || undefined,
      outputTokens: data.outputTokens || undefined,
      toolRequests: data.toolRequests?.length ? data.toolRequests : undefined,
      interactionId: data.interactionId || undefined,
    };
  };

  try {
    const result = await doSend(agent);
    _revivalAttempts.delete(name);  // reset on success
    return result;
  } catch (e: any) {
    const msg = e?.message || '';
    // Session expired/not found — recreate with a fresh session
    if (msg.includes('Session not found') || msg.includes('session_expired') || msg.includes('invalid_session')) {
      const attempts = (_revivalAttempts.get(name) || 0) + 1;
      _revivalAttempts.set(name, attempts);
      if (attempts > MAX_REVIVAL_ATTEMPTS) {
        _revivalAttempts.delete(name);
        throw new Error(`Agent "${name}" failed after ${MAX_REVIVAL_ATTEMPTS} revival attempts`);
      }
      console.log(`Session for "${name}" expired, creating fresh session (attempt ${attempts}/${MAX_REVIVAL_ATTEMPTS})...`);
      pushEvent('auto_revive', `Session expired for "${name}", creating fresh session`, 'warn', name);
      try {
        _headlessAgents.delete(name);
        const fresh = await createHeadlessAgent(name, { model: agent.model, source: agent.source });
        // Preserve history metadata
        fresh.messageCount = agent.messageCount;
        fresh.userPrompts = agent.userPrompts;
        return await doSend(fresh);
      } catch (retryErr) {
        agent.status = 'idle';
        throw retryErr;
      }
    }
    agent.status = 'idle';
    throw e;
  }
}

/**
 * Enqueue a prompt — queued while agent is busy, sent when idle.
 * Uses SDK's send() with no wait — the response comes via streaming events.
 */
export async function enqueueToHeadless(name: string, message: string): Promise<string> {
  let agent = _headlessAgents.get(name);
  if (!agent) {
    agent = await getOrReviveHeadless(name);
    if (!agent) throw new Error(`Headless agent "${name}" not found`);
  }

  agent.userPrompts.push({ prompt: message, timestamp: new Date().toISOString() });
  persistUserPrompts(name, agent.userPrompts);

  const messageId = await agent.session.send({ prompt: message } as any);
  agent.messageCount++;
  pushEvent('enqueue', `Enqueued prompt to "${name}"`, 'info', name);
  return messageId;
}

/**
 * Steer — send an immediate message that interrupts the current response.
 * The agent processes this right away, even if busy.
 */
export async function steerHeadless(name: string, message: string): Promise<string> {
  let agent = _headlessAgents.get(name);
  if (!agent) {
    agent = await getOrReviveHeadless(name);
    if (!agent) throw new Error(`Headless agent "${name}" not found`);
  }

  agent.userPrompts.push({ prompt: message, timestamp: new Date().toISOString() });
  persistUserPrompts(name, agent.userPrompts);

  // send() without waiting — fires immediately and steers the conversation
  const messageId = await agent.session.send({ prompt: message } as any);
  agent.status = 'running';
  agent.lastMessageAt = new Date().toISOString();
  agent.lastSeen = agent.lastMessageAt;
  agent.messageCount++;
  pushEvent('steer', `Steered "${name}" with new prompt`, 'info', name);
  return messageId;
}

/**
 * Abort — cancel whatever the agent is currently doing.
 */
export async function abortHeadless(name: string): Promise<void> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  await agent.session.abort();
  agent.status = 'idle';
  pushEvent('abort', `Aborted agent "${name}"`, 'warn', name);
}

/**
 * Compact — trigger manual context compaction.
 */
export async function compactHeadless(name: string): Promise<void> {
  const agent = _headlessAgents.get(name);
  if (!agent) throw new Error(`Headless agent "${name}" not found`);

  await (agent.session as any).rpc.compaction.compact();
  pushEvent('compact', `Compacted context for "${name}"`, 'info', name);
}

/**
 * Get structured conversation history for a headless agent.
 */
export async function getHeadlessMessages(name: string) {
  let agent = _headlessAgents.get(name);
  if (!agent) {
    // Try auto-revive from session file
    agent = await getOrReviveHeadless(name);
    if (!agent) throw new Error(`Headless agent "${name}" not found`);
  }

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
 * Move to pane: detach SDK handle so the session can be resumed in a terminal pane.
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

  pushEvent('mode_switch', `Agent "${name}" moved to pane`, 'info', name);
  return { sessionId, model };
}

/**
 * Move to headless: take over an existing copilot session into headless mode via SDK.
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
    lastSeen: new Date().toISOString(),
    messageCount: 0,
    toolActivity: [],
    userPrompts: loadUserPrompts(name),
  };
  agent.messageCount = agent.userPrompts.length;
  const session = await client.resumeSession(sessionId, {
    streaming: true,
    onPermissionRequest: approveAll,
    hooks: buildHooks(agent),
    mcpServers: buildMcpServers(name),
  } as any);

  agent.session = session;
  wireStreamingEvents(session, name, agent);
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

  pushEvent('mode_switch', `Agent "${name}" moved to headless`, 'info', name);
  return agent;
}

// ── Queries ──────────────────────────────────────────────────────

export function getHeadlessAgent(name: string): HeadlessAgent | undefined {
  return _headlessAgents.get(name);
}

/**
 * Get or auto-revive a headless agent. If the agent isn't in the in-memory map
 * but exists in agent-sessions.json with type: 'headless', auto-attach it.
 */
export async function getOrReviveHeadless(name: string): Promise<HeadlessAgent | undefined> {
  const existing = _headlessAgents.get(name);
  if (existing) return existing;

  // Check agent-sessions.json for a stopped headless entry
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const agents = raw.agents || {};

    // Search by name (key) or by displayName
    let sessionId: string | null = null;
    if (agents[name]?.session && agents[name]?.type === 'headless') {
      sessionId = agents[name].session;
    } else {
      for (const [, data] of Object.entries(agents as Record<string, any>)) {
        if (data.displayName === name && data.type === 'headless' && data.session) {
          sessionId = data.session;
          break;
        }
      }
    }

    if (sessionId) {
      console.log(`Auto-reviving headless agent "${name}" from session ${sessionId.slice(0, 8)}...`);
      pushEvent('auto_revive', `Auto-reviving headless agent "${name}"`, 'info', name);
      try {
        return await attachHeadless(name, sessionId);
      } catch (attachErr: any) {
        const msg = attachErr?.message || '';
        if (msg.includes('Session not found') || msg.includes('session_expired') || msg.includes('invalid_session')) {
          console.log(`Session expired for "${name}", creating fresh session instead`);
          pushEvent('auto_revive', `Session expired for "${name}", creating fresh`, 'warn', name);
          return await createHeadlessAgent(name);
        }
        throw attachErr;
      }
    }
  } catch (e) {
    console.error(`Failed to auto-revive headless agent "${name}":`, e);
  }

  return undefined;
}

export function listHeadlessAgents(): HeadlessAgent[] {
  return Array.from(_headlessAgents.values());
}

export function isHeadless(name: string): boolean {
  return _headlessAgents.has(name);
}

/** Update agent heartbeat timestamp. Called by MCP tools and message sends. */
export function heartbeatAgent(name: string): void {
  const agent = _headlessAgents.get(name);
  if (agent) agent.lastSeen = new Date().toISOString();
}

/** Check if an agent is stale (no heartbeat in 15s). */
export function isAgentStale(name: string): boolean {
  const agent = _headlessAgents.get(name);
  if (!agent) return true;
  return Date.now() - new Date(agent.lastSeen).getTime() > 15_000;
}

// ── Collaboration MCP Server Config ──────────────────────────────

/**
 * Build the mcpServers config to inject into session creation/resume.
 * This spawns a stdio MCP server process per agent that exposes
 * get_agents, relay_message, share_note, read_notes, set_status tools.
 */
function buildMcpServers(agentName: string): Record<string, any> {
  return {
    'copilot-town': {
      type: 'local',
      command: 'npx',
      args: ['tsx', MCP_COLLAB_SCRIPT],
      env: { AGENT_NAME: agentName, COPILOT_TOWN_PORT: PORT },
      tools: ['*'],
    },
  };
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

/** Persist user prompts to agent-sessions.json so they survive server restarts */
export function persistUserPrompts(name: string, prompts: { prompt: string; timestamp: string }[]) {
  try {
    if (!existsSync(SESSION_MAP_FILE)) return;
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    if (raw.agents?.[name]) {
      raw.agents[name].prompts = prompts;
      writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
    }
  } catch {}
}

/** Load persisted user prompts from agent-sessions.json */
function loadUserPrompts(name: string): { prompt: string; timestamp: string }[] {
  try {
    if (!existsSync(SESSION_MAP_FILE)) return [];
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    return raw.agents?.[name]?.prompts || [];
  } catch { return []; }
}

// ── Cleanup ──────────────────────────────────────────────────────

export async function destroyAllHeadless(): Promise<void> {
  for (const [name] of _headlessAgents) {
    await destroyHeadlessAgent(name);
  }
}
