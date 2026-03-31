import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, ToolInfo, AgentToolsInfo } from '../lib/api';
import { relativeTime } from '../components/ChatMarkdown';

type SortKey = 'name' | 'calls' | 'lastUsed';
type CategoryFilter = 'all' | 'mcp' | 'sdk';

interface MCPToolsProps {
  onNavigate?: (page: string, context?: { agent?: string }) => void;
}

export default function MCPTools({ onNavigate }: MCPToolsProps) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('calls');
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentToolsInfo | null>(null);
  const [agentDetailLoading, setAgentDetailLoading] = useState(false);

  const fetchTools = useCallback(async () => {
    try {
      const data = await api.getToolsRegistry();
      setTools(data.tools);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTools();
    const interval = setInterval(fetchTools, 30_000);
    return () => clearInterval(interval);
  }, [fetchTools]);

  const filtered = useMemo(() => {
    let list = tools;
    if (category !== 'all') list = list.filter(t => t.category === category);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'calls') return b.stats.totalCalls - a.stats.totalCalls;
      // lastUsed
      const aTime = a.stats.lastUsed ? new Date(a.stats.lastUsed).getTime() : 0;
      const bTime = b.stats.lastUsed ? new Date(b.stats.lastUsed).getTime() : 0;
      return bTime - aTime;
    });
    return list;
  }, [tools, category, search, sortBy]);

  const stats = useMemo(() => ({
    total: tools.length,
    mcp: tools.filter(t => t.category === 'mcp').length,
    sdk: tools.filter(t => t.category === 'sdk').length,
    totalCalls: tools.reduce((s, t) => s + t.stats.totalCalls, 0),
  }), [tools]);

  const loadAgentDetail = useCallback(async (name: string) => {
    setAgentDetailLoading(true);
    try {
      const data = await api.getAgentTools(name);
      setAgentDetail(data);
    } catch {
      setAgentDetail(null);
    } finally {
      setAgentDetailLoading(false);
    }
  }, []);

  if (loading) {
    const Skeleton = ({ width = '100%', height = 14, style = {} }: { width?: string | number; height?: number; style?: React.CSSProperties }) => (
      <div style={{
        width, height, borderRadius: 6,
        background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        ...style,
      }} />
    );
    return (
      <div className="space-y-5 p-1">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-bg-1 border border-border rounded-xl p-4" style={{ height: 120 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skeleton width="50%" height={14} />
                <Skeleton width="80%" height={12} />
                <Skeleton width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <span className="text-red text-lg">⚠</span>
        <span className="text-fg-2 text-sm">{error}</span>
        <button onClick={fetchTools} className="text-[11px] text-blue hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-1">
      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Tools', value: stats.total, icon: '🔧' },
          { label: 'MCP Tools', value: stats.mcp, icon: '🔌' },
          { label: 'SDK Tools', value: stats.sdk, icon: '📦' },
          { label: 'Total Calls', value: stats.totalCalls, icon: '📊' },
        ].map(s => (
          <div key={s.label} className="bg-bg-1 border border-border rounded-xl p-4 flex items-center gap-3">
            <span className="text-xl">{s.icon}</span>
            <div>
              <div className="text-lg font-semibold text-fg tabular-nums">{s.value}</div>
              <div className="text-[11px] text-fg-2">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Search + Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2 text-sm">🔍</span>

          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search tools"
            className="w-full bg-bg-1 border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-fg placeholder:text-fg-2 focus:outline-none focus:border-border-1 transition-colors"
          />
        </div>

        <div className="flex items-center bg-bg-1 border border-border rounded-lg overflow-hidden">
          {(['all', 'mcp', 'sdk'] as CategoryFilter[]).map(c => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`text-[11px] font-medium px-4 py-2 transition-all uppercase tracking-wider ${
                category === c ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg-1'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="flex items-center bg-bg-1 border border-border rounded-lg overflow-hidden">
          {([
            { key: 'calls' as SortKey, label: 'Calls' },
            { key: 'name' as SortKey, label: 'Name' },
            { key: 'lastUsed' as SortKey, label: 'Recent' },
          ]).map(s => (
            <button
              key={s.key}
              onClick={() => setSortBy(s.key)}
              aria-pressed={sortBy === s.key}
              className={`text-[11px] font-medium px-3 py-2 transition-all ${
                sortBy === s.key ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg-1'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => {
            const data = JSON.stringify(tools, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `copilot-town-tools-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="text-[11px] px-2.5 py-1.5 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg border border-border/40 transition-all"
          aria-label="Export tools data as JSON"
        >
          📥 Export
        </button>
      </div>

      {/* Tools grid */}
      {filtered.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--color-fg-2)', textAlign: 'center', gap: '0.75rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔧</div>
          <div style={{ fontSize: '1.1rem', color: 'var(--color-fg-1)', fontWeight: 500 }}>No tools registered</div>
          <div style={{ fontSize: '0.85rem', maxWidth: 400, lineHeight: 1.5 }}>MCP and SDK tools will appear here once agents are running. Start a headless agent to see its available tools.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(tool => (
            <ToolCard
              key={tool.name}
              tool={tool}
              expanded={expandedTool === tool.name}
              onToggle={() => setExpandedTool(expandedTool === tool.name ? null : tool.name)}
              onAgentClick={(name) => {
                loadAgentDetail(name);
              }}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}

      {/* Agent detail overlay */}
      {(agentDetail || agentDetailLoading) && (
        <AgentDetailPanel
          data={agentDetail}
          loading={agentDetailLoading}
          onClose={() => setAgentDetail(null)}
        />
      )}
    </div>
  );
}

function ToolCard({
  tool,
  expanded,
  onToggle,
  onAgentClick,
  onNavigate,
}: {
  tool: ToolInfo;
  expanded: boolean;
  onToggle: () => void;
  onAgentClick: (name: string) => void;
  onNavigate?: (page: string, context?: { agent?: string }) => void;
}) {
  const lastUsed = tool.stats.lastUsed
    ? relativeTime(new Date(tool.stats.lastUsed).getTime())
    : 'never';
  const avgMs = tool.stats.avgDuration != null
    ? tool.stats.avgDuration < 1000
      ? `${Math.round(tool.stats.avgDuration)}ms`
      : `${(tool.stats.avgDuration / 1000).toFixed(1)}s`
    : '—';

  return (
    <div
      className={`bg-bg-1 border rounded-xl p-4 transition-all cursor-pointer ${
        expanded ? 'border-border-1 ring-1 ring-border-1' : 'border-border hover:border-border-1'
      }`}
      onClick={onToggle}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-mono font-bold text-sm text-fg truncate">{tool.name}</span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${
            tool.category === 'mcp'
              ? 'bg-blue/15 text-blue'
              : 'bg-purple/15 text-purple'
          }`}
        >
          {tool.category.toUpperCase()}
        </span>
      </div>

      {/* Description */}
      <p className="text-[12px] text-fg-2 leading-relaxed mb-3 line-clamp-2">
        {tool.description || 'No description'}
      </p>

      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-fg-2 tabular-nums mb-2">
        <span title="Total calls">📞 {tool.stats.totalCalls}</span>
        <span title="Last used">🕐 {lastUsed}</span>
        <span title="Avg duration">⏱ {avgMs}</span>
      </div>

      {/* Agent dots */}
      {tool.stats.agentsUsed.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {tool.stats.agentsUsed.map(agent => (
            <button
              key={agent}
              onClick={e => {
                e.stopPropagation();
                onAgentClick(agent);
              }}
              title={agent}
              className="w-6 h-6 rounded-full bg-bg-3 border border-border text-[9px] font-bold text-fg-1 flex items-center justify-center hover:border-border-1 hover:bg-bg-2 transition-all uppercase"
            >
              {agent.slice(0, 2)}
            </button>
          ))}
          {onNavigate && tool.stats.agentsUsed.map(agentName => (
            <button
              key={`nav-${agentName}`}
              onClick={e => {
                e.stopPropagation();
                onNavigate('dashboard', { agent: agentName });
              }}
              style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline', font: 'inherit', padding: 0 }}
            >
              {agentName}
            </button>
          ))}
        </div>
      )}

      {/* Expanded details */}
      <div
        className="overflow-hidden transition-all duration-300"
        style={{ maxHeight: expanded ? '600px' : '0px', opacity: expanded ? 1 : 0 }}
      >
        <hr className="border-border my-3" />

        {tool.parameters && Object.keys(tool.parameters).length > 0 && (
          <div className="mb-3">
            <div className="text-sm font-semibold text-fg mb-1.5">Parameters</div>
            <pre className="text-[11px] text-fg-2 bg-bg-2 rounded-lg p-3 overflow-x-auto font-mono leading-relaxed">
              {JSON.stringify(tool.parameters, null, 2)}
            </pre>
          </div>
        )}

        <div className="mb-1">
          <div className="text-sm font-semibold text-fg mb-1.5">Usage Summary</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-bg-2 rounded-lg p-2">
              <div className="text-fg-2">Total Calls</div>
              <div className="text-fg font-semibold tabular-nums">{tool.stats.totalCalls}</div>
            </div>
            <div className="bg-bg-2 rounded-lg p-2">
              <div className="text-fg-2">Avg Duration</div>
              <div className="text-fg font-semibold tabular-nums">{avgMs}</div>
            </div>
            <div className="bg-bg-2 rounded-lg p-2">
              <div className="text-fg-2">Last Used</div>
              <div className="text-fg font-semibold">{lastUsed}</div>
            </div>
            <div className="bg-bg-2 rounded-lg p-2">
              <div className="text-fg-2">Agents</div>
              <div className="text-fg font-semibold tabular-nums">{tool.stats.agentsUsed.length}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentDetailPanel({
  data,
  loading,
  onClose,
}: {
  data: AgentToolsInfo | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-lg bg-bg border-l border-border h-full overflow-y-auto animate-slide-in"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'slideIn 0.2s ease-out' }}
      >
        <style>{`
          @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}</style>

        <div className="sticky top-0 bg-bg border-b border-border p-4 flex items-center justify-between z-10">
          <div className="text-sm font-semibold text-fg">
            {loading ? 'Loading…' : `Agent: ${data?.agent ?? ''}`}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-2 hover:text-fg text-lg leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-32 text-fg-2 text-sm animate-pulse">
            Loading agent tools…
          </div>
        )}

        {data && (
          <div className="p-4 space-y-5">
            {/* Agent stats */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Total Calls', value: data.stats.totalCalls },
                { label: 'Unique Tools', value: data.stats.uniqueTools },
                {
                  label: 'Last Active',
                  value: data.stats.lastActive
                    ? relativeTime(new Date(data.stats.lastActive).getTime())
                    : '—',
                },
              ].map(s => (
                <div key={s.label} className="bg-bg-1 border border-border rounded-lg p-3 text-center">
                  <div className="text-sm font-semibold text-fg tabular-nums">{s.value}</div>
                  <div className="text-[10px] text-fg-2">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Available tools */}
            <div>
              <div className="text-sm font-semibold text-fg mb-2">Available Tools</div>
              {data.available.length === 0 ? (
                <div className="text-[11px] text-fg-2">No tools registered</div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {data.available.map(t => (
                    <div
                      key={t.name}
                      className="flex items-center justify-between bg-bg-2 rounded-lg px-3 py-2"
                    >
                      <span className="font-mono text-[11px] text-fg">{t.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                          t.category === 'mcp'
                            ? 'bg-blue/15 text-blue'
                            : 'bg-purple/15 text-purple'
                        }`}
                      >
                        {t.category.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Activity log */}
            <div>
              <div className="text-sm font-semibold text-fg mb-2">Activity Log</div>
              {data.activity.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-24 gap-1">
                  <span className="text-2xl opacity-30">📋</span>
                  <span className="text-[11px] text-fg-2">No activity recorded</span>
                </div>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {data.activity.map((entry, i) => (
                    <div key={i} className="bg-bg-2 rounded-lg p-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold text-fg">
                          {entry.tool}
                        </span>
                        <span className="text-[10px] text-fg-2 tabular-nums">
                          {relativeTime(new Date(entry.timestamp).getTime())}
                        </span>
                      </div>
                      {entry.duration != null && (
                        <div className="text-[10px] text-fg-2 tabular-nums">
                          ⏱ {entry.duration < 1000 ? `${Math.round(entry.duration)}ms` : `${(entry.duration / 1000).toFixed(1)}s`}
                        </div>
                      )}
                      {entry.args && (
                        <pre className="text-[10px] text-fg-2 bg-bg-1 rounded p-2 overflow-x-auto font-mono max-h-24 overflow-y-auto">
                          {typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args, null, 2)}
                        </pre>
                      )}
                      {entry.result && (
                        <pre className="text-[10px] text-fg-2 bg-bg-1 rounded p-2 overflow-x-auto font-mono max-h-24 overflow-y-auto">
                          {entry.result.length > 200 ? entry.result.slice(0, 200) + '…' : entry.result}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
