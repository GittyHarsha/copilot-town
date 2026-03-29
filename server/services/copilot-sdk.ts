import { CopilotClient } from '@github/copilot-sdk';

// Singleton CopilotClient — started lazily, kept alive for server lifetime
let _client: CopilotClient | null = null;
let _starting = false;
let _startPromise: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
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
