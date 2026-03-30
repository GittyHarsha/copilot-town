import { useState, useCallback, useMemo } from 'react';
import type { AgentData } from '../lib/api';
import { AgentCardMemo as AgentCard } from '../components/AgentCard';
import StatsBar from '../components/StatsBar';
import RelayPanel from '../components/RelayPanel';
import CreateSessionDialog from '../components/CreateSessionDialog';

const STATUS_ORDER: Record<string, number> = {
  running: 0, idle: 1, stopped: 2, stopping: 3, starting: 4,
};

// Dynamic grouping by template source or activity status
function agentGroupKey(agent: AgentData): string {
  if (agent.template?.source) {
    return agent.template.source === 'user' ? 'User Agents' : 'Project Agents';
  }
  return (agent.status === 'running' || agent.status === 'idle') ? 'Active' : 'Stopped';
}

const PINS_KEY = 'copilot-town-pins';

function loadPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function savePins(pins: Set<string>) {
  localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
}

type GroupMode = 'flat' | 'by status' | 'by source';

interface Props {
  agents: AgentData[];
  setAgents: React.Dispatch<React.SetStateAction<AgentData[]>>;
  connected: boolean;
  onRefresh: () => void;
  onViewHistory?: (name: string) => void;
}

export default function Dashboard({ agents, onRefresh, onViewHistory }: Props) {
  const [pins, setPins] = useState<Set<string>>(loadPins);
  const [groupMode, setGroupMode] = useState<GroupMode>('flat');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  const togglePin = useCallback((id: string) => {
    setPins(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePins(next);
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((group: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const sortAgents = useCallback(
    (list: AgentData[]) =>
      [...list].sort((a, b) => {
        const pa = pins.has(a.id) ? 0 : 1;
        const pb = pins.has(b.id) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const sa = STATUS_ORDER[a.status] ?? 9;
        const sb = STATUS_ORDER[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      }),
    [pins]
  );

  const groups = useMemo(() => {
    if (groupMode === 'flat') return [{ name: '', agents: sortAgents(agents) }];

    const buckets = new Map<string, AgentData[]>();
    for (const agent of agents) {
      let key: string;
      if (groupMode === 'by status') {
        key = agent.status.charAt(0).toUpperCase() + agent.status.slice(1);
      } else {
        key = agentGroupKey(agent);
      }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(agent);
    }

    const order = groupMode === 'by source'
      ? ['User Agents', 'Project Agents', 'Active', 'Stopped']
      : Object.keys(STATUS_ORDER).map(s => s.charAt(0).toUpperCase() + s.slice(1));

    const result: { name: string; agents: AgentData[] }[] = [];
    for (const key of order) {
      if (buckets.has(key)) result.push({ name: key, agents: sortAgents(buckets.get(key)!) });
    }
    for (const [key, val] of buckets) {
      if (!result.find(r => r.name === key)) result.push({ name: key, agents: sortAgents(val) });
    }
    return result;
  }, [agents, groupMode, sortAgents]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className="text-2xl mb-3 opacity-30">⊘</span>
        <p className="text-xs text-fg-2">No agents found. Check your agent definitions.</p>
      </div>
    );
  }

  const modes: GroupMode[] = ['flat', 'by status', 'by source'];

  return (
    <div className="space-y-4">
      <StatsBar agents={agents} />

      {/* Group toggle */}
      <div className="flex items-center gap-3">
        <div className="flex items-center bg-bg-1 border border-border rounded-xl overflow-hidden"
          style={{ boxShadow: 'var(--card-shadow)' }}>
          {modes.map(m => (
            <button
              key={m}
              className={`text-[11px] font-medium px-4 py-2 transition-all duration-150 ${
                groupMode === m ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg-1 hover:bg-bg-2'
              }`}
              onClick={() => setGroupMode(m)}
            >
              {m === 'flat' ? '☰ Flat' : m === 'by status' ? '● Status' : '▤ Source'}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ New</button>
        {pins.size > 0 && (
          <span className="text-[10px] text-fg-2 font-medium">⭐ {pins.size} pinned</span>
        )}
      </div>

      <CreateSessionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onLaunched={() => { setCreateOpen(false); setTimeout(() => onRefresh(), 1500); onRefresh(); }}
      />

      {/* Agent list */}
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.name || '__flat'}>
            {group.name && (
              <button
                className="flex items-center gap-2 w-full text-left mb-2 group"
                onClick={() => toggleCollapse(group.name)}
              >
                <span className="text-[10px] text-fg-2/50 transition-transform duration-200"
                  style={{ transform: collapsed.has(group.name) ? undefined : 'rotate(90deg)' }}>▸</span>
                <span className="text-[11px] font-semibold text-fg-2 uppercase tracking-wider">{group.name}</span>
                <span className="text-[10px] text-fg-2/40 tabular-nums">{group.agents.length}</span>
                <span className="flex-1 border-b border-border/30" />
              </button>
            )}
            {!collapsed.has(group.name) && (
              <div className="space-y-2">
                {group.agents.map(agent => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onRefresh={onRefresh}
                    onViewHistory={onViewHistory}
                    pinned={pins.has(agent.id)}
                    onTogglePin={() => togglePin(agent.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <RelayPanel agents={agents} />
    </div>
  );
}
