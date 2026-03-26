import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const TOWNS_FILE = join(HOME, '.copilot', 'copilot-town-towns.json');
const SESSION_MAP_FILE = join(HOME, '.copilot', 'agent-sessions.json');

export interface Town {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  agents: string[]; // agent names
  parent?: string;  // parent town ID for hierarchy
  level: 'town' | 'city' | 'state' | 'country';
  psmuxSession?: string; // linked psmux session name
  createdAt: string;
}

interface TownsData {
  towns: Town[];
}

const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba'];

// Bootstrap towns from existing psmux_layout in agent-sessions.json
function bootstrapFromPsmux(): Town[] {
  try {
    if (!existsSync(SESSION_MAP_FILE)) return [];
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf-8'));
    const layout = raw.psmux_layout;
    if (!layout) return [];

    const towns: Town[] = [];
    let colorIdx = 0;

    for (const [sessName, panes] of Object.entries(layout as Record<string, any>)) {
      if (sessName.startsWith('_')) continue;

      const agents: string[] = [];
      for (const [_paneKey, agentName] of Object.entries(panes as Record<string, string>)) {
        if (typeof agentName === 'string' && !agentName.startsWith('_')) {
          agents.push(agentName);
        }
      }

      towns.push({
        id: `psmux-${sessName}`,
        name: sessName,
        description: `Auto-created from psmux session "${sessName}" (${agents.length} agents)`,
        color: COLORS[colorIdx++ % COLORS.length],
        icon: '⬡',
        agents,
        level: 'town',
        psmuxSession: sessName,
        createdAt: new Date().toISOString(),
      });
    }

    return towns;
  } catch { return []; }
}

function loadTowns(): TownsData {
  try {
    if (existsSync(TOWNS_FILE)) {
      const data = JSON.parse(readFileSync(TOWNS_FILE, 'utf-8')) as TownsData;
      if (data.towns && data.towns.length > 0) return data;
    }
  } catch { /* ignore */ }

  // No towns file or empty — bootstrap from psmux layout
  const bootstrapped = bootstrapFromPsmux();
  if (bootstrapped.length > 0) {
    const data = { towns: bootstrapped };
    saveTowns(data);
    return data;
  }

  return { towns: [] };
}

function saveTowns(data: TownsData): void {
  writeFileSync(TOWNS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAllTowns(): Town[] {
  return loadTowns().towns;
}

export function getTown(id: string): Town | undefined {
  return loadTowns().towns.find(t => t.id === id);
}

export function createTown(input: Omit<Town, 'id' | 'createdAt'>): Town {
  const data = loadTowns();
  const town: Town = {
    ...input,
    id: genId(),
    createdAt: new Date().toISOString(),
  };
  data.towns.push(town);
  saveTowns(data);
  return town;
}

export function updateTown(id: string, updates: Partial<Omit<Town, 'id' | 'createdAt'>>): Town | null {
  const data = loadTowns();
  const idx = data.towns.findIndex(t => t.id === id);
  if (idx === -1) return null;
  data.towns[idx] = { ...data.towns[idx], ...updates };
  saveTowns(data);
  return data.towns[idx];
}

export function deleteTown(id: string): boolean {
  const data = loadTowns();
  const idx = data.towns.findIndex(t => t.id === id);
  if (idx === -1) return false;
  data.towns.splice(idx, 1);
  // Remove parent references
  for (const town of data.towns) {
    if (town.parent === id) town.parent = undefined;
  }
  saveTowns(data);
  return true;
}

export function addAgentToTown(townId: string, agentName: string): boolean {
  const data = loadTowns();
  const town = data.towns.find(t => t.id === townId);
  if (!town) return false;
  // Remove from any other town at same level first
  for (const t of data.towns) {
    t.agents = t.agents.filter(a => a !== agentName);
  }
  if (!town.agents.includes(agentName)) {
    town.agents.push(agentName);
  }
  saveTowns(data);
  return true;
}

export function removeAgentFromTown(townId: string, agentName: string): boolean {
  const data = loadTowns();
  const town = data.towns.find(t => t.id === townId);
  if (!town) return false;
  town.agents = town.agents.filter(a => a !== agentName);
  saveTowns(data);
  return true;
}

// Re-sync: merge psmux layout into existing towns (add new sessions, update agents)
export function syncFromPsmux(): Town[] {
  const data = loadTowns();
  const fresh = bootstrapFromPsmux();

  for (const freshTown of fresh) {
    const existing = data.towns.find(t => t.psmuxSession === freshTown.psmuxSession);
    if (existing) {
      // Merge agents — add any new ones from layout
      for (const agent of freshTown.agents) {
        if (!existing.agents.includes(agent)) existing.agents.push(agent);
      }
    } else {
      // New psmux session — add as town
      data.towns.push(freshTown);
    }
  }

  saveTowns(data);
  return data.towns;
}
