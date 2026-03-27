import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import { listPanes, capturePane, type PsmuxPane } from './psmux.js';
import { trackStatusChanges } from './statusHistory.js';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const USER_AGENTS_DIR = process.env.COPILOT_TOWN_USER_AGENTS_DIR || join(HOME, '.copilot', 'agents');
const PROJECT_DIR = process.env.COPILOT_TOWN_PROJECT_DIR || process.cwd();
const PROJECT_AGENTS_DIR = join(PROJECT_DIR, '.github', 'agents');
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

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

export function loadAgentTemplates(): AgentTemplate[] {
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
  return templates;
}

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
];

function detectCopilotState(output: string): 'running' | 'idle' | null {
  if (!output) return null;
  const hasCopilot = COPILOT_INDICATORS.some(ind => output.includes(ind));
  if (!hasCopilot && !/claude-|gpt-|gemini-/i.test(output)) return null;
  const hasPrompt = output.includes('❯') || output.includes('shift+tab switch mode');
  return hasPrompt ? 'idle' : 'running';
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
}

function loadSessionMap(): Map<string, SessionMapEntry> {
  const map = new Map<string, SessionMapEntry>();
  try {
    if (!existsSync(SESSION_MAP_FILE)) return map;
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const agentsBlock = raw.agents || raw;

    for (const [name, data] of Object.entries(agentsBlock as Record<string, any>)) {
      if (name.startsWith('_')) continue;
      const sessionId = data.session || data.sessionId || data.session_id || '';
      if (sessionId) {
        map.set(sessionId, {
          sessionId,
          agentName: name,
          displayName: data.displayName || data.display_name,
          startedAt: data.startedAt,
          stoppedAt: data.stoppedAt,
        });
      }
    }
  } catch { /* ignore */ }
  return map;
}

function loadAgentNameToSessionId(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (!existsSync(SESSION_MAP_FILE)) return map;
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const agentsBlock = raw.agents || raw;

    for (const [name, data] of Object.entries(agentsBlock as Record<string, any>)) {
      if (name.startsWith('_')) continue;
      const sessionId = data.session || data.sessionId || data.session_id || '';
      if (sessionId) map.set(name, sessionId);
    }
  } catch { /* ignore */ }
  return map;
}

// ── Pane scanning cache ───────────────────────────────────────────

interface PaneScanResult {
  agentName: string | null;
  sessionId: string | null;
  state: 'running' | 'idle';
}

let _paneCache = new Map<string, PaneScanResult>();
let _paneCacheTime = 0;

function scanPanes(panes: PsmuxPane[]): Map<string, PaneScanResult> {
  const now = Date.now();
  if (now - _paneCacheTime < 8000 && _paneCache.size > 0) {
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

function syntheticId(target: string): string {
  let hash = 0;
  for (let i = 0; i < target.length; i++) {
    hash = ((hash << 5) - hash) + target.charCodeAt(i);
    hash |= 0;
  }
  return `pane-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ── Main discovery (session-first) ────────────────────────────────

export function getAllAgents(): Agent[] {
  const templates = loadAgentTemplates();
  const templateMap = new Map<string, AgentTemplate>();
  for (const t of templates) templateMap.set(t.name, t);

  const sessionMap = loadSessionMap();
  const nameToSessionId = loadAgentNameToSessionId();
  const allPanes = listPanes();
  const paneData = scanPanes(allPanes);

  const agents: Agent[] = [];
  const seenSessionIds = new Set<string>();

  // Phase 1: Discover agents from live panes (copilot running)
  for (const pane of allPanes) {
    const info = paneData.get(pane.target);
    if (!info) continue;

    let { agentName, sessionId, state } = info;

    // Resolve session ID from agent-sessions.json when not found in pane output
    if (!sessionId && agentName) {
      sessionId = nameToSessionId.get(agentName) || null;
    }

    // Last resort: try matching by agent name across all registered entries
    // (handles resume case where --resume=UUID not yet visible in pane output)
    if (!sessionId && agentName) {
      for (const [sid, entry] of sessionMap) {
        if (entry.agentName === agentName || entry.displayName === agentName) {
          sessionId = sid;
          break;
        }
      }
    }

    const id = sessionId || syntheticId(pane.target);

    // Custom name from agent-sessions.json always wins over --agent= extracted name
    const sessionEntry = sessionMap.get(id);
    const customName = sessionEntry?.displayName || sessionEntry?.agentName || null;
    const resolvedName = customName || agentName;
    const template = resolvedName ? templateMap.get(resolvedName) : undefined;
    const name = customName || template?.name || agentName || id.slice(0, 8);

    // Only include in agent list if registered (in session map) — skip anonymous pane-XXXX
    if (!sessionEntry) continue;

    agents.push({ id, name, template, status: state, pane, sessionId: id });
    seenSessionIds.add(id);
  }

  // Phase 2: Known sessions from agent-sessions.json not in any pane → stopped
  for (const [sessionId, entry] of sessionMap) {
    if (seenSessionIds.has(sessionId)) continue;

    const template = templateMap.get(entry.agentName);
    const name = entry.displayName || template?.name || entry.agentName || sessionId.slice(0, 8);
    // Show as idle (not stopped) if session was started but never explicitly stopped
    const status: AgentStatus = entry.stoppedAt ? 'stopped' : 'idle';

    agents.push({ id: sessionId, name, template, status, sessionId });
    seenSessionIds.add(sessionId);
  }

  trackStatusChanges(agents);
  return agents;
}

export function getAgent(idOrName: string): Agent | undefined {
  const agents = getAllAgents();
  return agents.find(a => a.id === idOrName) || agents.find(a => a.name === idOrName);
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
