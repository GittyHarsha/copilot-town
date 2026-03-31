import { useState, useCallback, useMemo, useEffect } from 'react';
import type { AgentData } from '../lib/api';
import { api } from '../lib/api';
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

function isWorkflowAgent(agent: AgentData): boolean {
  return agent.source === 'workflow' || agent.name.startsWith('wf-');
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
  onOpenChat?: (agentName: string) => void;
}

export default function Dashboard({ agents, onRefresh, onViewHistory, onOpenChat }: Props) {
  const [pins, setPins] = useState<Set<string>>(loadPins);
  const [groupMode, setGroupMode] = useState<GroupMode>('flat');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['__workflow']));
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Batch selection state
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((id: string) => setSelectedAgents(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }), []);
  const clearSelection = useCallback(() => setSelectedAgents(new Set()), []);
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

  const filtered = useMemo(() => {
    if (!search) return agents;
    const q = search.toLowerCase();
    return agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.model || '').toLowerCase().includes(q) ||
      (a.task || '').toLowerCase().includes(q)
    );
  }, [agents, search]);

  // Separate workflow agents from user agents
  const userAgents = useMemo(() => filtered.filter(a => !isWorkflowAgent(a)), [filtered]);
  const workflowAgents = useMemo(() => filtered.filter(a => isWorkflowAgent(a)), [filtered]);

  const groups = useMemo(() => {
    if (groupMode === 'flat') return [{ name: '', agents: sortAgents(userAgents) }];

    const buckets = new Map<string, AgentData[]>();
    for (const agent of userAgents) {
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
  }, [userAgents, groupMode, sortAgents]);

  const selectAll = useCallback(() => {
    setSelectedAgents(new Set(filtered.map(a => a.id)));
  }, [filtered]);

  const handleBatchStop = useCallback(async () => {
    const targets = agents.filter(a => selectedAgents.has(a.id) && a.status !== 'stopped');
    if (!targets.length) return;
    await Promise.allSettled(targets.map(a => api.stopAgent(a.id)));
    clearSelection();
    onRefresh();
  }, [agents, selectedAgents, clearSelection, onRefresh]);

  const handleBatchRestart = useCallback(async () => {
    const targets = agents.filter(a => selectedAgents.has(a.id) && a.status === 'stopped');
    if (!targets.length) return;
    await Promise.allSettled(targets.map(a => api.resumeAgent(a.id)));
    clearSelection();
    onRefresh();
  }, [agents, selectedAgents, clearSelection, onRefresh]);

  if (userAgents.length === 0 && workflowAgents.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--color-fg-2)', textAlign: 'center', gap: '0.75rem' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🏘️</div>
        <div style={{ fontSize: '1.1rem', color: 'var(--color-fg-1)', fontWeight: 500 }}>No agents running</div>
        <div style={{ fontSize: '0.85rem', maxWidth: 400, lineHeight: 1.5 }}>Spawn an agent from the command palette (Ctrl+K) or use psmux to start agent panes.</div>
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
        <input
          type="text"
          placeholder="Search agents…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-bg-1 border border-border rounded-lg px-3 py-1.5 text-[12px] text-fg w-48 focus:outline-none focus:border-border-1 placeholder:text-fg-2/40"
        />
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ New</button>
        {pins.size > 0 && (
          <span className="text-[10px] text-fg-2 font-medium">⭐ {pins.size} pinned</span>
        )}
      </div>

      <CreateSessionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onLaunched={() => { setCreateOpen(false); setTimeout(() => onRefresh(), 1500); }}
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
                    onOpenChat={onOpenChat}
                    pinned={pins.has(agent.id)}
                    onTogglePin={() => togglePin(agent.id)}
                    selected={selectedAgents.has(agent.id)}
                    onSelect={() => toggleSelect(agent.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {search && userAgents.length === 0 && workflowAgents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="text-xl mb-2 opacity-30">🔍</span>
            <p className="text-xs text-fg-2">No agents match "{search}"</p>
          </div>
        )}
      </div>

      {/* Workflow agents — separate collapsible section */}
      {workflowAgents.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/30">
          <button
            className="flex items-center gap-2 w-full text-left mb-2"
            onClick={() => toggleCollapse('__workflow')}
          >
            <span className="text-[10px] text-fg-2/50 transition-transform duration-200"
              style={{ transform: collapsed.has('__workflow') ? undefined : 'rotate(90deg)' }}>▸</span>
            <span className="text-[11px] font-semibold text-violet-400/70 uppercase tracking-wider">⚡ Workflow Agents</span>
            <span className="text-[10px] text-fg-2/40 tabular-nums">{workflowAgents.length}</span>
            <span className="flex-1 border-b border-border/20" />
          </button>
          {!collapsed.has('__workflow') && (
            <div className="space-y-2">
              {sortAgents(workflowAgents).map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onRefresh={onRefresh}
                  onViewHistory={onViewHistory}
                  onOpenChat={onOpenChat}
                  pinned={pins.has(agent.id)}
                  onTogglePin={() => togglePin(agent.id)}
                  selected={selectedAgents.has(agent.id)}
                  onSelect={() => toggleSelect(agent.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <RelayPanel agents={agents} />

      {/* Floating batch action bar */}
      {selectedAgents.size > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--color-bg-1)', border: '1px solid var(--color-border-1)',
          borderRadius: 12, padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 50,
        }}>
          <span style={{ color: 'var(--color-fg-1)', fontSize: '0.85rem', fontWeight: 500 }}>
            {selectedAgents.size} selected
          </span>
          <button className="btn" onClick={handleBatchStop}>⏹ Stop</button>
          <button className="btn" onClick={handleBatchRestart}>🔄 Restart</button>
          <button className="btn" onClick={selectAll}>Select All</button>
          <button className="btn" onClick={clearSelection}>✕ Clear</button>
        </div>
      )}
    </div>
  );
}
