import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_STATE_DIR = join(HOME, '.copilot', 'session-state');
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

export interface SessionCheckpoint {
  number: number;
  title: string;
  filename: string;
}

export interface CopilotSession {
  id: string;
  path: string;
  lastModified: Date;
  hasPlan: boolean;
  planSnippet?: string;
  checkpoints: SessionCheckpoint[];
  agentName?: string;
  isOrphaned: boolean;
}

function getBoundSessionIds(): Set<string> {
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const ids = new Set<string>();
      // v2 format: { agents: { name: { session: "..." } } }
      const agentsBlock = raw.agents || raw;
      for (const [key, data] of Object.entries(agentsBlock as Record<string, any>)) {
        if (key.startsWith('_')) continue;
        const sid = (data as any).session || (data as any).sessionId || (data as any).session_id;
        if (sid) ids.add(sid);
      }
      return ids;
    }
  } catch { /* ignore */ }
  return new Set();
}

function getAgentNameForSession(sessionId: string): string | undefined {
  try {
    if (existsSync(SESSION_MAP_FILE)) {
      const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const agentsBlock = raw.agents || raw;
      for (const [name, data] of Object.entries(agentsBlock as Record<string, any>)) {
        if (name.startsWith('_')) continue;
        const sid = (data as any).session || (data as any).sessionId || (data as any).session_id;
        if (sid === sessionId) return name;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function loadCheckpoints(sessionDir: string): SessionCheckpoint[] {
  const ckptDir = join(sessionDir, 'checkpoints');
  if (!existsSync(ckptDir)) return [];

  try {
    return readdirSync(ckptDir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .map(f => {
        const match = f.match(/^(\d+)-(.+)\.md$/);
        return {
          number: match ? parseInt(match[1]) : 0,
          title: match ? match[2].replace(/-/g, ' ') : f,
          filename: f,
        };
      })
      .sort((a, b) => a.number - b.number);
  } catch {
    return [];
  }
}

export function getAllSessions(): CopilotSession[] {
  if (!existsSync(SESSION_STATE_DIR)) return [];

  const boundIds = getBoundSessionIds();
  const sessions: CopilotSession[] = [];

  for (const dir of readdirSync(SESSION_STATE_DIR)) {
    const sessionDir = join(SESSION_STATE_DIR, dir);
    try {
      const stat = statSync(sessionDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const planPath = join(sessionDir, 'plan.md');
    const hasPlan = existsSync(planPath);
    let planSnippet: string | undefined;
    if (hasPlan) {
      try {
        const content = readFileSync(planPath, 'utf-8');
        // First 3 non-empty lines
        planSnippet = content.split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
      } catch { /* ignore */ }
    }

    sessions.push({
      id: dir,
      path: sessionDir,
      lastModified: statSync(sessionDir).mtime,
      hasPlan,
      planSnippet,
      checkpoints: loadCheckpoints(sessionDir),
      agentName: getAgentNameForSession(dir),
      isOrphaned: !boundIds.has(dir),
    });
  }

  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

export function getSession(id: string): CopilotSession | undefined {
  return getAllSessions().find(s => s.id === id);
}

export function getSessionPlan(id: string): string | null {
  const planPath = join(SESSION_STATE_DIR, id, 'plan.md');
  try {
    return existsSync(planPath) ? readFileSync(planPath, 'utf-8') : null;
  } catch {
    return null;
  }
}

export function getSessionCheckpointContent(id: string, filename: string): string | null {
  const ckptPath = join(SESSION_STATE_DIR, id, 'checkpoints', filename);
  try {
    return existsSync(ckptPath) ? readFileSync(ckptPath, 'utf-8') : null;
  } catch {
    return null;
  }
}

export function getOrphanedSessions(): CopilotSession[] {
  return getAllSessions().filter(s => s.isOrphaned);
}
