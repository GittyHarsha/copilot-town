import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';

// Singleton CopilotClient — started lazily, kept alive for server lifetime
let _client: CopilotClient | null = null;
let _starting = false;
let _startPromise: Promise<CopilotClient> | null = null;

export async function getClient(): Promise<CopilotClient> {
  if (_client) return _client;
  if (_startPromise) return _startPromise;

  _startPromise = (async () => {
    const client = new CopilotClient();
    await client.start();
    _client = client;
    _starting = false;
    return client;
  })();
  return _startPromise;
}

export async function stopClient(): Promise<void> {
  if (_client) {
    try { await _client.stop(); } catch {}
    _client = null;
    _startPromise = null;
  }
}

// ── Sessions ─────────────────────────────────────────────────────

export interface CopilotSessionInfo {
  sessionId: string;
  startTime: string;
  modifiedTime: string;
  summary: string;
  isRemote: boolean;
  context: {
    cwd: string;
    gitRoot: string;
    repository: string;
    branch: string;
  };
}

let _sessionsCache: CopilotSessionInfo[] = [];
let _sessionsCacheTime = 0;
const SESSIONS_TTL = 10_000; // 10s cache

// Map for O(1) lookup by sessionId
let _sessionsMap: Map<string, CopilotSessionInfo> = new Map();

export async function listCopilotSessions(): Promise<CopilotSessionInfo[]> {
  const now = Date.now();
  if (now - _sessionsCacheTime < SESSIONS_TTL && _sessionsCache.length > 0) {
    return _sessionsCache;
  }
  try {
    const client = await getClient();
    const sessions = await client.listSessions();
    _sessionsCache = sessions.map(s => ({
      sessionId: s.sessionId,
      startTime: s.startTime instanceof Date ? s.startTime.toISOString() : String(s.startTime),
      modifiedTime: s.modifiedTime instanceof Date ? s.modifiedTime.toISOString() : String(s.modifiedTime),
      summary: s.summary || '',
      isRemote: s.isRemote || false,
      context: s.context as any || { cwd: '', gitRoot: '', repository: '', branch: '' },
    }));
    _sessionsCacheTime = now;
    _sessionsMap = new Map(_sessionsCache.map(s => [s.sessionId, s]));
    return _sessionsCache;
  } catch (e) {
    console.error('copilot-sdk listSessions error:', e);
    return _sessionsCache; // return stale cache on error
  }
}

export function getCopilotSession(sessionId: string): CopilotSessionInfo | undefined {
  return _sessionsMap.get(sessionId);
}

export async function isValidSession(sessionId: string): Promise<boolean> {
  await listCopilotSessions(); // ensure cache is warm
  return _sessionsMap.has(sessionId);
}

// ── Models ───────────────────────────────────────────────────────

export interface CopilotModel {
  id: string;
  name: string;
  capabilities?: any;
  policy?: { state: string };
  billing?: { is_premium: boolean; multiplier: number };
}

let _modelsCache: CopilotModel[] = [];
let _modelsCacheTime = 0;
const MODELS_TTL = 300_000; // 5 min cache (models rarely change)

export async function listCopilotModels(): Promise<CopilotModel[]> {
  const now = Date.now();
  if (now - _modelsCacheTime < MODELS_TTL && _modelsCache.length > 0) {
    return _modelsCache;
  }
  try {
    const client = await getClient();
    const raw = await client.listModels();
    _modelsCache = raw.map((m: any) => ({
      id: m.id || m.modelId || '',
      name: m.name || m.displayName || m.id || '',
      capabilities: m.capabilities,
      policy: m.policy,
      billing: m.billing,
    }));
    _modelsCacheTime = now;
    return _modelsCache;
  } catch (e) {
    console.error('copilot-sdk listModels error:', e);
    return _modelsCache;
  }
}

// ── Session Messaging ────────────────────────────────────────────

export interface SessionMessage {
  id: string;
  type: string;          // 'user.message' | 'assistant.message' | 'tool.call' | etc.
  timestamp: string;
  parentId?: string;
  data: any;
}

/**
 * Send a message to an existing session and wait for the response.
 * Uses resumeSession + sendAndWait — the session must already exist.
 * Returns the assistant's response text, or throws on error.
 */
export async function sendToSession(
  sessionId: string,
  message: string,
  options?: { timeoutMs?: number }
): Promise<{ response: string; messageId?: string }> {
  const client = await getClient();
  const session = await client.resumeSession(sessionId, {
    onPermissionRequest: approveAll,
  });

  try {
    const timeoutMs = options?.timeoutMs || 120_000;
    const result = await Promise.race([
      session.sendAndWait({ prompt: message }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sendToSession timed out')), timeoutMs)
      ),
    ]);

    const response = (result as any)?.data?.content || '';
    const messageId = (result as any)?.data?.messageId || (result as any)?.id || '';
    return { response, messageId };
  } finally {
    try { await session.disconnect(); } catch {}
  }
}

/**
 * Get conversation history for a session.
 * Returns structured messages (id, type, timestamp, data).
 * Results are cached for 30s to avoid repeated SDK round-trips.
 */
const _msgCache = new Map<string, { data: SessionMessage[]; ts: number }>();
const MSG_CACHE_TTL = 30_000;

export async function getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  const cached = _msgCache.get(sessionId);
  if (cached && Date.now() - cached.ts < MSG_CACHE_TTL) return cached.data;

  const client = await getClient();
  const session = await client.resumeSession(sessionId, {
    onPermissionRequest: approveAll,
  });

  try {
    const raw = await session.getMessages();
    if (!Array.isArray(raw)) return [];
    const messages = raw.map((m: any) => ({
      id: m.id || '',
      type: m.type || 'unknown',
      timestamp: m.timestamp || '',
      parentId: m.parentId,
      data: m.data || {},
    }));
    _msgCache.set(sessionId, { data: messages, ts: Date.now() });
    return messages;
  } finally {
    try { await session.disconnect(); } catch {}
  }
}

/**
 * Delete a session permanently.
 */
export async function deleteCopilotSession(sessionId: string): Promise<boolean> {
  try {
    const client = await getClient();
    await client.deleteSession(sessionId);
    // Invalidate session cache
    _sessionsMap.delete(sessionId);
    _sessionsCache = _sessionsCache.filter(s => s.sessionId !== sessionId);
    return true;
  } catch (e) {
    console.error('copilot-sdk deleteSession error:', e);
    return false;
  }
}

/**
 * Get auth status — who's logged in.
 */
export async function getAuthStatus(): Promise<{ login: string; isAuthenticated: boolean } | null> {
  try {
    const client = await getClient();
    const status = await client.getAuthStatus();
    return { login: status.login || '', isAuthenticated: status.isAuthenticated || false };
  } catch {
    return null;
  }
}

// Re-export for headless agent use
export type { CopilotSession };
