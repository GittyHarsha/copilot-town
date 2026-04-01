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

/* ── Filter types ── */
type StatusFilter = 'all' | 'running' | 'idle' | 'stopped';
type TypeFilter = 'all' | 'pane' | 'headless';

interface Props {
  agents: AgentData[];
  setAgents: React.Dispatch<React.SetStateAction<AgentData[]>>;
  connected: boolean;
  onRefresh: () => void;
  onOpenChat?: (agentName: string) => void;
}

export default function Dashboard({ agents, onRefresh, onOpenChat }: Props) {
  const [pins, setPins] = useState<Set<string>>(loadPins);
  const [groupMode, setGroupMode] = useState<GroupMode>('flat');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['__workflow']));
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

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
    let result = agents;
    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (a.model || '').toLowerCase().includes(q) ||
        (a.task || '').toLowerCase().includes(q)
      );
    }
    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(a => a.status === statusFilter);
    }
    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter(a => (a.type || 'pane') === typeFilter);
    }
    // Model filter
    if (modelFilter !== 'all') {
      result = result.filter(a => (a.model || '') === modelFilter);
    }
    return result;
  }, [agents, search, statusFilter, typeFilter, modelFilter]);

  // Available models for the model filter dropdown
  const availableModels = useMemo(() => {
    const models = new Set<string>();
    agents.forEach(a => { if (a.model) models.add(a.model); });
    return [...models].sort();
  }, [agents]);

  const activeFilterCount = (statusFilter !== 'all' ? 1 : 0) +
    (typeFilter !== 'all' ? 1 : 0) +
    (modelFilter !== 'all' ? 1 : 0);

  const clearAllFilters = useCallback(() => {
    setSearch('');
    setStatusFilter('all');
    setTypeFilter('all');
    setModelFilter('all');
  }, []);

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

  // Show empty state only if there are truly zero agents (no filters applied)
  const hasAnyAgents = agents.length > 0;
  const hasFilteredResults = userAgents.length > 0 || workflowAgents.length > 0;

  if (!hasAnyAgents) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem 2rem', color: 'var(--color-fg-2)', textAlign: 'center', gap: '1rem' }}>
        <div style={{ fontSize: '3.5rem', marginBottom: '0.5rem', opacity: 0.8 }}>🏘️</div>
        <div style={{ fontSize: '1.15rem', color: 'var(--color-fg-1)', fontWeight: 500 }}>No agents running</div>
        <div style={{ fontSize: '0.85rem', maxWidth: 420, lineHeight: 1.6, color: 'var(--color-fg-2)', opacity: 0.8 }}>Spawn an agent from the command palette (Ctrl+K) or use psmux to start agent panes.</div>
      </div>
    );
  }

  const modes: GroupMode[] = ['flat', 'by status', 'by source'];

  return (
    <div className="space-y-4">
      <StatsBar agents={agents} />

      {/* Search & Filters */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div style={{ position: 'relative', flex: '1 1 auto', maxWidth: 320, minWidth: 200 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-fg-2)', fontSize: 13, pointerEvents: 'none', opacity: 0.5 }}>🔍</span>
            <input
              type="text"
              placeholder="Search by name, model, task…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px 8px 32px', fontSize: 13,
                background: 'var(--color-bg-2)', color: 'var(--color-fg)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--shape-xl, 28px)',
                outline: 'none', transition: 'border-color 200ms ease, box-shadow 200ms ease',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(96,165,250,0.3)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(96,165,250,0.08)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--color-fg-2)', cursor: 'pointer', fontSize: 12, padding: 4 }}
              >✕</button>
            )}
          </div>

          {/* Filter toggle */}
          <button
            className="btn"
            onClick={() => setShowFilters(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              ...(activeFilterCount > 0 ? { color: '#60a5fa', background: 'rgba(96,165,250,0.1)' } : {})
            }}
          >
            <span style={{ fontSize: 13 }}>⚙</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, borderRadius: '50%',
                background: 'rgba(96,165,250,0.2)', color: '#60a5fa',
                fontSize: 10, fontWeight: 600,
              }}>{activeFilterCount}</span>
            )}
          </button>

          {/* Group toggle */}
          <div className="flex items-center bg-bg-2 overflow-hidden" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--shape-xl, 28px)' }}>
            {modes.map(m => (
              <button
                key={m}
                className="text-[11px] font-medium px-4 py-2"
                style={{
                  background: groupMode === m ? 'var(--color-bg-3)' : 'transparent',
                  color: groupMode === m ? 'var(--color-fg)' : 'var(--color-fg-2)',
                  transition: 'all 200ms ease',
                  border: 'none', cursor: 'pointer',
                }}
                onClick={() => setGroupMode(m)}
              >
                {m === 'flat' ? '☰ Flat' : m === 'by status' ? '● Status' : '▤ Source'}
              </button>
            ))}
          </div>

          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ New</button>
        </div>

        {/* Filter chips row */}
        {showFilters && (
          <div className="animate-slide-down flex items-center gap-3 flex-wrap" style={{ padding: '8px 0' }}>
            {/* Status filter */}
            <div className="flex items-center gap-1.5">
              <span style={{ fontSize: 10, color: 'var(--color-fg-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Status</span>
              {(['all', 'running', 'idle', 'stopped'] as StatusFilter[]).map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  style={{
                    padding: '4px 12px', fontSize: 11, fontWeight: 500,
                    borderRadius: 'var(--shape-xl, 28px)', border: '1px solid',
                    cursor: 'pointer',
                    transition: 'all 200ms ease',
                    ...(statusFilter === s
                      ? { background: s === 'running' ? 'rgba(34,197,94,0.12)' : s === 'idle' ? 'rgba(234,179,8,0.12)' : s === 'stopped' ? 'rgba(248,113,113,0.12)' : 'rgba(96,165,250,0.12)',
                          color: s === 'running' ? '#4ade80' : s === 'idle' ? '#facc15' : s === 'stopped' ? '#f87171' : '#60a5fa',
                          borderColor: s === 'running' ? 'rgba(34,197,94,0.25)' : s === 'idle' ? 'rgba(234,179,8,0.25)' : s === 'stopped' ? 'rgba(248,113,113,0.25)' : 'rgba(96,165,250,0.25)' }
                      : { background: 'transparent', color: 'var(--color-fg-2)', borderColor: 'var(--color-border)' })
                  }}
                >
                  {s === 'all' ? 'All' : s === 'running' ? '● Running' : s === 'idle' ? '◐ Idle' : '○ Stopped'}
                </button>
              ))}
            </div>

            <span style={{ width: 1, height: 20, background: 'var(--color-border)', flexShrink: 0 }} />

            {/* Type filter */}
            <div className="flex items-center gap-1.5">
              <span style={{ fontSize: 10, color: 'var(--color-fg-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Type</span>
              {(['all', 'pane', 'headless'] as TypeFilter[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  style={{
                    padding: '4px 12px', fontSize: 11, fontWeight: 500,
                    borderRadius: 'var(--shape-xl, 28px)', border: '1px solid',
                    cursor: 'pointer',
                    transition: 'all 200ms ease',
                    ...(typeFilter === t
                      ? { background: 'rgba(96,165,250,0.12)', color: '#60a5fa', borderColor: 'rgba(96,165,250,0.25)' }
                      : { background: 'transparent', color: 'var(--color-fg-2)', borderColor: 'var(--color-border)' })
                  }}
                >
                  {t === 'all' ? 'All' : t === 'pane' ? '📺 Pane' : '⚡ Headless'}
                </button>
              ))}
            </div>

            <span style={{ width: 1, height: 20, background: 'var(--color-border)', flexShrink: 0 }} />

            {/* Model filter */}
            {availableModels.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span style={{ fontSize: 10, color: 'var(--color-fg-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Model</span>
                <select
                  value={modelFilter}
                  onChange={e => setModelFilter(e.target.value)}
                  style={{
                    padding: '4px 24px 4px 10px', fontSize: 11, fontWeight: 500,
                    borderRadius: 'var(--shape-xl, 28px)',
                    border: `1px solid ${modelFilter !== 'all' ? 'rgba(96,165,250,0.25)' : 'var(--color-border)'}`,
                    background: modelFilter !== 'all' ? 'rgba(96,165,250,0.12)' : 'var(--color-bg-2)',
                    color: modelFilter !== 'all' ? '#60a5fa' : 'var(--color-fg-2)',
                    cursor: 'pointer', outline: 'none',
                    transition: 'all 200ms ease',
                    appearance: 'none', WebkitAppearance: 'none',
                    backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%239e9ea8' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m2 5 6 6 6-6'/%3e%3c/svg%3e")`,
                    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center', backgroundSize: '12px',
                  }}
                >
                  <option value="all">All Models</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Clear all */}
            {activeFilterCount > 0 && (
              <button
                onClick={clearAllFilters}
                style={{
                  padding: '4px 12px', fontSize: 11, fontWeight: 500,
                  borderRadius: 'var(--shape-xl, 28px)', border: '1px solid rgba(248,113,113,0.2)',
                  background: 'rgba(248,113,113,0.06)', color: '#f87171',
                  cursor: 'pointer', marginLeft: 4,
                  transition: 'all 200ms ease',
                }}
              >
                ✕ Clear all
              </button>
            )}
          </div>
        )}

        {/* Active filters summary (collapsed) */}
        {!showFilters && activeFilterCount > 0 && (
          <div className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--color-fg-2)' }}>
            <span>Filtered:</span>
            {statusFilter !== 'all' && (
              <span style={{ padding: '2px 8px', borderRadius: 'var(--shape-xl, 28px)', background: 'rgba(96,165,250,0.08)', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {statusFilter}
                <button onClick={() => setStatusFilter('all')} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              </span>
            )}
            {typeFilter !== 'all' && (
              <span style={{ padding: '2px 8px', borderRadius: 'var(--shape-xl, 28px)', background: 'rgba(96,165,250,0.08)', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {typeFilter}
                <button onClick={() => setTypeFilter('all')} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              </span>
            )}
            {modelFilter !== 'all' && (
              <span style={{ padding: '2px 8px', borderRadius: 'var(--shape-xl, 28px)', background: 'rgba(96,165,250,0.08)', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {modelFilter}
                <button onClick={() => setModelFilter('all')} style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              </span>
            )}
            <span style={{ color: 'var(--color-fg-2)', opacity: 0.5 }}>— {filtered.length} of {agents.length} agents</span>
          </div>
        )}
      </div>

      <CreateSessionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onLaunched={() => { setCreateOpen(false); setTimeout(() => onRefresh(), 1500); }}
      />

      {/* Agent list */}
      <div className="space-y-5">
        {groups.map(group => (
          <div key={group.name || '__flat'}>
            {group.name && (
              <button
                className="flex items-center gap-2 w-full text-left mb-3 mt-6 group"
                onClick={() => toggleCollapse(group.name)}
              >
                <span className="text-[10px] text-fg-2/80 transition-transform duration-200"
                  style={{ transform: collapsed.has(group.name) ? undefined : 'rotate(90deg)' }}>▸</span>
                <span className="text-[10px] font-semibold text-fg-1 uppercase" style={{ letterSpacing: '0.05em' }}>{group.name}</span>
                <span className="text-[10px] text-fg-2/70 tabular-nums">{group.agents.length}</span>
                <span className="flex-1 border-b border-border/60" />
              </button>
            )}
            {!collapsed.has(group.name) && (
              <div className="space-y-3">
                {group.agents.map(agent => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onRefresh={onRefresh}
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
        {!hasFilteredResults && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <span className="text-3xl mb-3 opacity-25">🔍</span>
            <p className="text-sm" style={{ color: 'var(--color-fg-2)' }}>
              {search ? `No agents match "${search}"` : `No ${statusFilter !== 'all' ? statusFilter : ''} ${typeFilter !== 'all' ? typeFilter : ''} agents found`}
            </p>
            {(activeFilterCount > 0 || search) && (
              <button
                className="btn btn-primary mt-3"
                onClick={clearAllFilters}
              >
                Clear all filters
              </button>
            )}
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
            <span className="text-[10px] font-semibold text-violet-400/70 uppercase" style={{ letterSpacing: '0.05em' }}>⚡ Workflow Agents</span>
            <span className="text-[10px] text-fg-2/40 tabular-nums">{workflowAgents.length}</span>
            <span className="flex-1 border-b border-border/20" />
          </button>
          {!collapsed.has('__workflow') && (
            <div className="space-y-3">
              {sortAgents(workflowAgents).map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onRefresh={onRefresh}
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
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--color-bg-1)', border: '1px solid var(--color-border-1)',
          borderTop: '1px solid rgba(59,130,246,0.3)',
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
