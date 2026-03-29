import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import matter from 'gray-matter';
import { listPanes, capturePane, capturePaneAsync, type PsmuxPane } from './psmux.js';
import { trackStatusChanges } from './statusHistory.js';
import { listCopilotSessions, getCopilotSession, type CopilotSessionInfo } from './copilot-sdk.js';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const USER_AGENTS_DIR = process.env.COPILOT_TOWN_USER_AGENTS_DIR || join(HOME, '.copilot', 'agents');
const PROJECT_DIR = process.env.COPILOT_TOWN_PROJECT_DIR || process.cwd();
const PROJECT_AGENTS_DIR = join(PROJECT_DIR, '.github', 'agents');
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');
const SESSION_STATE_DIR = join(HOME, '.copilot', 'session-state');

// ── Session status detection ─────────────────────────────────────
// Status is determined by:
//   1. Pane scanning (Phase 1): session found in an active pane → "running"
//   2. SDK session list: session exists in copilot-sdk → real session
//   3. stoppedAt flag: explicitly stopped by user → "stopped"
//   4. Otherwise: session exists but not in any pane → "idle"
// Lock files are NOT used — the shared CLI daemon PID creates lock
// files for every session it touches, making them unreliable.

export type AgentStatus = 'running' | 'idle' | 'stopped';

export interface AgentTemplate {
  name: string;
  description: string;
  model?: string;
  filePath: string;
  source: 'user' | 'project';
}

export interface Agent {
  id: string;              // copilotSessionId (UUID) — primary key
  name: string;            // display name
  template?: AgentTemplate;
  status: AgentStatus;
  pane?: PsmuxPane;
  sessionId: string;       // same as id, but explicit
  // Enriched from @github/copilot-sdk
  summary?: string;
  context?: { cwd: string; gitRoot: string; repository: string; branch: string };
  modifiedTime?: string;
  startTime?: string;
}

// ── Template loading ──────────────────────────────────────────────

function parseAgentFile(filePath: string, source: 'user' | 'project'): AgentTemplate | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const { data } = matter(content);
    return {
      name: data.name || basename(filePath, '.agent.md'),
      description: data.description || '',
      model: data.model,
      filePath,
      source,
    };
  } catch {
    return null;
  }
}

// Template loading handled below with caching

// ── Copilot detection ─────────────────────────────────────────────

const COPILOT_INDICATORS = [
  'shift+tab',
  'ctrl+s',
  'Type @ to mention',
  'ctrl+q',
  'Selected custom agent',
  'Environment loaded:',
  'copilot --agent=',
  '⎇',
  // Tool/action prompts (copilot is working but waiting for confirmation)
  'Do you want to use this tool?',
  "Yes, and don't ask again",
  '↑↓ to navigate',
  // Working indicators (spinners, progress)
  'Copilot is using',
];

function detectCopilotState(output: string): 'running' | 'idle' | null {
  if (!output) return null;
  const hasCopilot = COPILOT_INDICATORS.some(ind => output.includes(ind));
  if (!hasCopilot && !/claude[\s-]|gpt[\s-]|gemini[\s-]/i.test(output)) return null;

  // Idle = at prompt waiting for user input
  const hasPrompt = output.includes('Type @ to mention') || output.includes('shift+tab switch mode');
  if (hasPrompt) return 'idle';

  // Running = copilot is actively working (tool dialogs, generating, etc.)
  return 'running';
}

// ── Session ID & agent name extraction from pane output ───────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractSessionId(output: string): string | null {
  // Strategy 1: --resume=UUID in command line
  const resumeMatch = output.match(
    /--resume=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (resumeMatch) return resumeMatch[1];

  // Strategy 2: UUID in status-bar lines containing session hints
  const lines = output.split('\n').slice(-10);
  for (const line of lines) {
    if (/session:|Session:|sid=/i.test(line)) {
      const m = line.match(UUID_RE);
      if (m) return m[0];
    }
  }
  return null;
}

function extractAgentName(output: string): string | null {
  // Strategy 1: --agent=name
  const m1 = output.match(/--agent=(\S+)/);
  if (m1) return m1[1].replace(/['"]/g, '');

  // Strategy 2: "Selected custom agent: name"
  const m2 = output.match(/Selected custom agent:\s+(\S+)/);
  if (m2) return m2[1];

  // Strategy 3: Status bar — model followed by agent name at end of line
  const m3 = output.match(
    /(?:claude|gpt|gemini)-\S+\s+\([^)]+\)\s+(?:\(\d+x?\)\s+)?(\S+)\s*$/m,
  );
  if (m3) return m3[1];

  return null;
}

// ── Session map reading (backwards compatible) ────────────────────

interface SessionMapEntry {
  sessionId: string;
  agentName: string;
  displayName?: string;
  startedAt?: string;
  stoppedAt?: string;
  panePid?: number;
}

// ── Consolidated session file reader (single read, three views) ────
interface SessionFileData {
  sessionMap: Map<string, SessionMapEntry>;
  nameToSessionId: Map<string, string>;
  paneLayout: Map<string, string>;
  nameToPanePid: Map<string, number>;
}

let _sessionFileCache: SessionFileData | null = null;
let _sessionFileCacheTime = 0;
const SESSION_FILE_TTL = 3000; // 3s cache

// ── Cleanup stale data from agent-sessions.json ──────────────────

let _cleanupDone = false;

export function cleanSessionFile(force = false): void {
  if (_cleanupDone && !force) return;
  _cleanupDone = true;

  try {
    if (!existsSync(SESSION_MAP_FILE)) return;
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const agents = raw.agents || {};
    let changed = false;

    // 1. Remove agents with empty session IDs (spawn never completed)
    //    or with fake/non-existent session-state directories
    for (const [name, data] of Object.entries(agents as Record<string, any>)) {
      const sid = data.session || data.sessionId || data.session_id || '';
      if (!sid) {
        delete agents[name];
        if (raw.metadata?.[name]) delete raw.metadata[name];
        changed = true;
        continue;
      }
      // Check if session-state directory exists (filters out fake test IDs)
      const sessionDir = join(SESSION_STATE_DIR, sid);
      if (!existsSync(sessionDir)) {
        delete agents[name];
        if (raw.metadata?.[name]) delete raw.metadata[name];
        changed = true;
      }
    }

    // 2. Prune psmux_layout entries that reference agent names not in agents map
    const layout = raw.psmux_layout || {};
    const agentNames = new Set(Object.keys(agents));
    for (const [sessName, panes] of Object.entries(layout as Record<string, any>)) {
      if (sessName.startsWith('_')) continue;
      for (const [wp, aName] of Object.entries(panes as Record<string, string>)) {
        if (!agentNames.has(aName)) {
          delete panes[wp];
          changed = true;
        }
      }
      // Remove empty session entries
      if (Object.keys(panes).length === 0) {
        delete layout[sessName];
        changed = true;
      }
    }
    raw.psmux_layout = layout;

    if (changed) {
      writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
      _sessionFileCache = null; // invalidate cache
    }
  } catch (e) {
    console.error('cleanSessionFile error:', e);
  }
}

function loadSessionFile(): SessionFileData {
  const now = Date.now();
  if (_sessionFileCache && now - _sessionFileCacheTime < SESSION_FILE_TTL) {
    return _sessionFileCache;
  }

  const sessionMap = new Map<string, SessionMapEntry>();
  const nameToSessionId = new Map<string, string>();
  const paneLayout = new Map<string, string>();
  const nameToPanePid = new Map<string, number>();

  try {
    if (!existsSync(SESSION_MAP_FILE)) {
      _sessionFileCache = { sessionMap, nameToSessionId, paneLayout, nameToPanePid };
      _sessionFileCacheTime = now;
      return _sessionFileCache;
    }
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const agentsBlock = raw.agents || raw;

    for (const [name, data] of Object.entries(agentsBlock as Record<string, any>)) {
      if (name.startsWith('_')) continue;
      const sessionId = data.session || data.sessionId || data.session_id || '';
      if (sessionId) {
        sessionMap.set(sessionId, {
          sessionId,
          agentName: name,
          displayName: data.displayName || data.display_name,
          startedAt: data.startedAt,
          stoppedAt: data.stoppedAt,
          panePid: data.panePid,
        });
        nameToSessionId.set(name, sessionId);
        if (data.panePid) nameToPanePid.set(name, data.panePid);
      }
    }

    const layout = raw.psmux_layout || {};
    for (const [sessionName, panes] of Object.entries(layout as Record<string, any>)) {
      if (sessionName.startsWith('_')) continue;
      for (const [wp, agentName] of Object.entries(panes as Record<string, string>)) {
        paneLayout.set(`${sessionName}:${wp}`, agentName);
      }
    }
  } catch { /* ignore */ }

  _sessionFileCache = { sessionMap, nameToSessionId, paneLayout, nameToPanePid };
  _sessionFileCacheTime = now;
  return _sessionFileCache;
}

// ── Pane scanning cache ───────────────────────────────────────────

interface PaneScanResult {
  agentName: string | null;
  sessionId: string | null;
  state: 'running' | 'idle';
}

let _paneCache = new Map<string, PaneScanResult>();
let _paneCacheTime = 0;

// ── Template caching ──────────────────────────────────────────────
let _templateCache: AgentTemplate[] | null = null;
let _templateCacheTime = 0;
const TEMPLATE_CACHE_TTL = 30000; // 30s — templates rarely change

export function loadAgentTemplates(): AgentTemplate[] {
  const now = Date.now();
  if (_templateCache && now - _templateCacheTime < TEMPLATE_CACHE_TTL) {
    return _templateCache;
  }
  const templates: AgentTemplate[] = [];
  for (const [dir, source] of [[USER_AGENTS_DIR, 'user'], [PROJECT_AGENTS_DIR, 'project']] as const) {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.agent.md')) {
          const t = parseAgentFile(join(dir, file), source);
          if (t) templates.push(t);
        }
      }
    }
  }
  _templateCache = templates;
  _templateCacheTime = now;
  return templates;
}

export function invalidateAgentCache() {
  _paneCache = new Map();
  _paneCacheTime = 0;
  _sessionFileCache = null;
  _sessionFileCacheTime = 0;
  _templateCache = null;
  _templateCacheTime = 0;
}

function scanPanesSync(panes: PsmuxPane[]): Map<string, PaneScanResult> {
  const now = Date.now();
  if (now - _paneCacheTime < 15000 && _paneCache.size > 0) {
    return _paneCache;
  }

  const map = new Map<string, PaneScanResult>();
  for (const pane of panes) {
    try {
      const output = capturePane(pane.target, 20);
      if (!output) continue;

      const copilotState = detectCopilotState(output);
      if (!copilotState) continue;

      map.set(pane.target, {
        agentName: extractAgentName(output),
        sessionId: extractSessionId(output),
        state: copilotState,
      });
    } catch { /* capture failed */ }
  }

  _paneCache = map;
  _paneCacheTime = now;
  return map;
}

/** Parallel async version — captures all panes concurrently */
async function scanPanesAsync(panes: PsmuxPane[]): Promise<Map<string, PaneScanResult>> {
  const now = Date.now();
  if (now - _paneCacheTime < 15000 && _paneCache.size > 0) {
    return _paneCache;
  }

  const map = new Map<string, PaneScanResult>();
  const results = await Promise.all(
    panes.map(async pane => {
      try {
        const output = await capturePaneAsync(pane.target, 20);
        if (!output) return null;
        const copilotState = detectCopilotState(output);
        if (!copilotState) return null;
        return {
          target: pane.target,
          agentName: extractAgentName(output),
          sessionId: extractSessionId(output),
          state: copilotState,
        };
      } catch { return null; }
    })
  );

  for (const r of results) {
    if (r) map.set(r.target, { agentName: r.agentName, sessionId: r.sessionId, state: r.state });
  }

  _paneCache = map;
  _paneCacheTime = now;
  return map;
}

function syntheticId(target: string): string {
  let hash = 0;
  for (let i = 0; i < target.length; i++) {
    hash = ((hash << 5) - hash) + target.charCodeAt(i);
    hash |= 0;
  }
  return `pane-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ── Main discovery (session-first) ────────────────────────────────

/** Builds agent list from pane scan data + session file. Pure computation, no I/O. */
function buildAgentList(paneData: Map<string, PaneScanResult>): Agent[] {
  const templates = loadAgentTemplates();
  const templateMap = new Map<string, AgentTemplate>();
  for (const t of templates) templateMap.set(t.name, t);

  const { sessionMap, nameToSessionId, paneLayout, nameToPanePid } = loadSessionFile();
  const allPanes = listPanes();

  // Build PID → pane target lookup for reliable matching
  const pidToPane = new Map<number, PsmuxPane>();
  for (const pane of allPanes) {
    if (pane.pid) pidToPane.set(pane.pid, pane);
  }

  // Build set of actual pane targets for layout validation
  const livePaneTargets = new Set(allPanes.map(p => p.target));

  const agents: Agent[] = [];
  const seenSessionIds = new Set<string>();
  const seenPanes = new Set<string>();

  // Phase 1: Discover agents from live panes (copilot running)
  // Only match panes to registered agents when there's strong evidence:
  //   - Extracted session ID matches a registered agent
  //   - Pane PID matches a stored panePid for a registered agent
  // Unmatched copilot panes are NOT auto-promoted to agents.
  for (const pane of allPanes) {
    const info = paneData.get(pane.target);
    if (!info) continue;

    let { agentName, sessionId, state } = info;
    let matchedVia: string | null = null;

    // Strategy A (PRIMARY): Match by stored pane PID — most reliable
    for (const [name, pid] of nameToPanePid) {
      if (pid === pane.pid) {
        agentName = name;
        sessionId = nameToSessionId.get(name) || sessionId;
        matchedVia = 'pid';
        break;
      }
    }

    // Strategy B: Extracted session ID matches a registered session
    if (!matchedVia && sessionId && sessionMap.has(sessionId)) {
      matchedVia = 'session-id';
    }

    // Strategy C: Extracted agent name matches a registered agent
    if (!matchedVia && agentName && nameToSessionId.has(agentName)) {
      sessionId = nameToSessionId.get(agentName) || sessionId;
      matchedVia = 'agent-name';
    }

    // No strong match — skip this pane (don't create phantom agents)
    if (!matchedVia) continue;

    const id = sessionId || syntheticId(pane.target);
    const sessionEntry = sessionMap.get(id);
    const customName = sessionEntry?.displayName || sessionEntry?.agentName || null;
    const template = (customName || agentName) ? templateMap.get(customName || agentName!) : undefined;
    const name = customName || template?.name || agentName || id.slice(0, 8);

    agents.push({ id, name, template, status: state, pane, sessionId: id });
    seenSessionIds.add(id);
    seenPanes.add(pane.target);
  }

  // Phase 2: Known sessions from agent-sessions.json not in any pane
  // Try PID matching first, then fall back to lock file status
  for (const [sessionId, entry] of sessionMap) {
    if (seenSessionIds.has(sessionId)) continue;

    const template = templateMap.get(entry.agentName);
    const name = entry.displayName || template?.name || entry.agentName || sessionId.slice(0, 8);

    // Try to find pane by stored PID
    let matchedPane: PsmuxPane | undefined;
    if (entry.panePid) {
      matchedPane = pidToPane.get(entry.panePid);
      if (matchedPane && !seenPanes.has(matchedPane.target)) {
        // Found pane by PID — check if copilot is running in it
        const info = paneData.get(matchedPane.target);
        if (info) {
          agents.push({ id: sessionId, name, template, status: info.state, pane: matchedPane, sessionId });
          seenSessionIds.add(sessionId);
          seenPanes.add(matchedPane.target);
          continue;
        }
      }
    }

    // Validate: does this session exist in the SDK's session list?
    // Falls back to checking session-state directory on disk.
    const sdkSession = getCopilotSession(sessionId);
    const sessionDir = join(SESSION_STATE_DIR, sessionId);
    const isRealSession = !!sdkSession || existsSync(sessionDir);

    if (!isRealSession) {
      // Not in SDK and no session dir = phantom entry, skip it
      continue;
    }

    let status: AgentStatus;
    if (entry.stoppedAt) {
      // Check if SDK shows activity after the stoppedAt timestamp
      // (session-hook may have set stoppedAt on a different pane's exit)
      const stoppedTime = new Date(entry.stoppedAt).getTime();
      const sdkModified = sdkSession?.modifiedTime ? new Date(sdkSession.modifiedTime).getTime() : 0;
      status = sdkModified > stoppedTime ? 'idle' : 'stopped';
    } else {
      // Session exists but not in any pane → idle (can be resumed)
      status = 'idle';
    }

    agents.push({ id: sessionId, name, template, status, sessionId });
    seenSessionIds.add(sessionId);
  }

  trackStatusChanges(agents);
  return agents;
}

// Cached agent list — always returned immediately
let _agentListCache: Agent[] = [];
let _agentListCacheTime = 0;
let _refreshInProgress = false;

/** Returns cached agent list instantly. Never blocks on pane capture. */
export function getAllAgents(): Agent[] {
  // Clean stale data once on first call
  cleanSessionFile();
  // On very first call, do a sync scan to bootstrap
  if (_agentListCacheTime === 0) {
    const allPanes = listPanes();
    const paneData = scanPanesSync(allPanes);
    _agentListCache = buildAgentList(paneData);
    _agentListCacheTime = Date.now();
  }
  return _agentListCache;
}

/** Async refresh — captures all panes in parallel, then updates cache. */
export async function refreshAgents(): Promise<Agent[]> {
  if (_refreshInProgress) return _agentListCache;
  _refreshInProgress = true;
  try {
    // Warm SDK session cache FIRST — buildAgentList Phase 2 needs it
    try { await listCopilotSessions(); } catch {}

    const allPanes = listPanes();
    const paneData = await scanPanesAsync(allPanes);
    _agentListCache = buildAgentList(paneData);

    // Enrich agents with SDK metadata (summary, context, timestamps)
    // Cache is already warm so getCopilotSession() is instant
    for (const agent of _agentListCache) {
      const sdkSession = getCopilotSession(agent.id);
      if (sdkSession) {
        agent.summary = sdkSession.summary;
        agent.context = sdkSession.context;
        agent.modifiedTime = sdkSession.modifiedTime;
        agent.startTime = sdkSession.startTime;
      }
    }

    _agentListCacheTime = Date.now();
    return _agentListCache;
  } finally {
    _refreshInProgress = false;
  }
}

export function getAgent(idOrName: string): Agent | undefined {
  const agents = getAllAgents();
  return agents.find(a => a.id === idOrName)
    || agents.find(a => a.name === idOrName)
    || agents.find(a => a.id.startsWith(idOrName)); // partial session ID match
}

export function getAgentMdContent(templateName: string): string | null {
  const templates = loadAgentTemplates();
  const template = templates.find(t => t.name === templateName);
  if (!template) return null;
  try {
    return readFileSync(template.filePath, 'utf-8');
  } catch {
    return null;
  }
}
