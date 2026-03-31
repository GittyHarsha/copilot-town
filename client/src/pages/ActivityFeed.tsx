import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api, ActivityEvent, HealthStatus, StatusChange } from '../lib/api';
import { relativeTime } from '../components/ChatMarkdown';

type SeverityFilter = 'all' | 'info' | 'warn' | 'error';

const SEVERITY_COLORS: Record<string, string> = {
  info: 'var(--color-fg-2)',
  warn: '#f59e0b',
  error: '#ef4444',
};

const TYPE_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  health_warning: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },
  agent_state: { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
  agent_started: { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
  agent_stopped: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
  agent_resumed: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
  relay: { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
  workflow: { bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' },
  error: { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
};

const STATUS_DOT_COLORS: Record<string, string> = {
  running: '#22c55e',
  healthy: '#22c55e',
  idle: '#f59e0b',
  warning: '#f59e0b',
  stopped: '#ef4444',
  crashed: '#ef4444',
  hung: '#ef4444',
};

function getTypeBadge(type: string) {
  return TYPE_BADGE_COLORS[type] ?? { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' };
}

interface ActivityFeedProps {
  onNavigate?: (page: string, context?: { agent?: string }) => void;
}

export default function ActivityFeed({ onNavigate }: ActivityFeedProps) {
  // Events state
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [eventLimit] = useState(500);

  // Health state
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<Record<string, StatusChange[]>>({});
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);

  // Auto-scroll state
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newEventsCount, setNewEventsCount] = useState(0);

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch events
  const fetchEvents = useCallback(async () => {
    try {
      const data = await api.getEvents(eventLimit);
      setEvents(data);
      setEventsError(null);
    } catch (e: any) {
      setEventsError(e.message || 'Failed to load events');
    } finally {
      setEventsLoading(false);
    }
  }, [eventLimit]);

  // Fetch health
  const fetchHealth = useCallback(async () => {
    try {
      const data = await api.getHealth();
      setHealth(data);
    } catch {
      // health endpoint may not be available
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // Fetch status history for an agent
  const fetchStatusHistory = useCallback(async (agent: string) => {
    setHistoryLoading(agent);
    try {
      const data = await api.getStatusHistory(agent, 50);
      setStatusHistory(prev => ({ ...prev, [agent]: data }));
    } catch {
      setStatusHistory(prev => ({ ...prev, [agent]: [] }));
    } finally {
      setHistoryLoading(null);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchEvents();
    fetchHealth();
    const healthInterval = setInterval(fetchHealth, 30_000);
    return () => clearInterval(healthInterval);
  }, [fetchEvents, fetchHealth]);

  // WebSocket for live events
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (disposed) return;
      try {
        const ws = new WebSocket(`ws://${window.location.hostname}:${window.location.port || '3848'}/ws/status`);
        ws.onopen = () => {};
        ws.onclose = () => {
          if (!disposed) reconnectTimer = setTimeout(connect, 3000);
        };
        ws.onerror = () => {
          if (ws.readyState === WebSocket.CONNECTING) return;
          ws.close();
        };
        ws.onmessage = (raw) => {
          try {
            const data = JSON.parse(raw.data);
            if (data.type === 'event' && data.event) {
              const evt = data.event as ActivityEvent;
              setEvents(prev => {
                const next = [...prev, evt];
                return next.length > 1000 ? next.slice(-1000) : next;
              });
              if (!autoScroll) {
                setNewEventsCount(c => c + 1);
              }
            }
          } catch { /* ignore */ }
        };
        wsRef.current = ws;
      } catch {
        reconnectTimer = setTimeout(connect, 3000);
      }
    }

    const startTimer = setTimeout(connect, 200);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [autoScroll]);

  // Auto-scroll behavior
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    setAutoScroll(atBottom);
    if (atBottom) setNewEventsCount(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
      setAutoScroll(true);
      setNewEventsCount(0);
    }
  }, []);

  // Derive agent/type lists from events
  const agentOptions = useMemo(() => {
    const agents = new Set<string>();
    events.forEach(e => { if (e.agent) agents.add(e.agent); });
    return Array.from(agents).sort();
  }, [events]);

  const typeOptions = useMemo(() => {
    const types = new Set<string>();
    events.forEach(e => types.add(e.type));
    return Array.from(types).sort();
  }, [events]);

  // Filtered events
  const filtered = useMemo(() => {
    let list = events;
    if (severityFilter !== 'all') list = list.filter(e => e.severity === severityFilter);
    if (agentFilter !== 'all') list = list.filter(e => e.agent === agentFilter);
    if (typeFilter !== 'all') list = list.filter(e => e.type === typeFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e =>
        e.message.toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        (e.agent && e.agent.toLowerCase().includes(q))
      );
    }
    return list;
  }, [events, severityFilter, agentFilter, typeFilter, searchQuery]);

  // Expand/collapse agent health card
  const toggleAgent = useCallback((agent: string) => {
    if (expandedAgent === agent) {
      setExpandedAgent(null);
    } else {
      setExpandedAgent(agent);
      if (!statusHistory[agent]) {
        fetchStatusHistory(agent);
      }
    }
  }, [expandedAgent, statusHistory, fetchStatusHistory]);

  // Health agents list
  const healthAgents = useMemo(() => {
    if (!health?.agents) return [];
    return Object.entries(health.agents).map(([name, info]) => ({ name, ...info }));
  }, [health]);

  if (eventsLoading && healthLoading) {
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
      <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 130px)', minHeight: 0 }}>
        <div style={{ flex: '1 1 70%', display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={60} style={{ borderRadius: 12 }} />
          ))}
        </div>
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} height={80} style={{ borderRadius: 12 }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 130px)', minHeight: 0 }}>
      {/* ── Left: Events Feed ── */}
      <div style={{ flex: '1 1 70%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Header */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>📡</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-fg)' }}>Activity Feed</span>
              <span style={{ fontSize: 11, color: 'var(--color-fg-2)', fontVariantNumeric: 'tabular-nums' }}>
                {filtered.length === events.length
                  ? `${events.length} events`
                  : `${filtered.length} / ${events.length} events`}
              </span>
            </div>
            <button
              onClick={fetchEvents}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 8,
                background: 'var(--color-bg-2)', color: 'var(--color-fg-2)',
                border: '1px solid var(--color-border)', cursor: 'pointer',
              }}
            >
              ↻ Refresh
            </button>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 150 }}>
              <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--color-fg-2)' }}>🔍</span>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search events…"
                style={{
                  width: '100%', padding: '6px 8px 6px 28px', fontSize: 12,
                  background: 'var(--color-bg-1)', border: '1px solid var(--color-border)',
                  borderRadius: 'var(--shape-xl)', color: 'var(--color-fg)', outline: 'none',
                }}
              />
            </div>
            <FilterSelect label="Severity" value={severityFilter} onChange={v => setSeverityFilter(v as SeverityFilter)}
              options={[{ value: 'all', label: 'All' }, { value: 'info', label: 'Info' }, { value: 'warn', label: 'Warn' }, { value: 'error', label: 'Error' }]} />
            <FilterSelect label="Agent" value={agentFilter} onChange={setAgentFilter}
              options={[{ value: 'all', label: 'All Agents' }, ...agentOptions.map(a => ({ value: a, label: a }))]} />
            <FilterSelect label="Type" value={typeFilter} onChange={setTypeFilter}
              options={[{ value: 'all', label: 'All Types' }, ...typeOptions.map(t => ({ value: t, label: t }))]} />
          </div>
        </div>

        {/* Events list */}
        {eventsError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 8 }}>
            <span style={{ fontSize: 24, opacity: 0.4 }}>⚠</span>
            <span style={{ fontSize: 12, color: 'var(--color-fg-2)' }}>{eventsError}</span>
            <button onClick={fetchEvents} style={{ fontSize: 11, color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--color-fg-2)', textAlign: 'center', gap: '0.75rem', flex: 1 }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📡</div>
            <div style={{ fontSize: '1.1rem', color: 'var(--color-fg-1)', fontWeight: 500 }}>No activity yet</div>
            <div style={{ fontSize: '0.85rem', maxWidth: 400, lineHeight: 1.5 }}>Agent events, health alerts, and relay messages will stream here in real-time once agents are running.</div>
          </div>
        ) : (
          <div
            ref={feedRef}
            onScroll={handleScroll}
            style={{
              flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
              paddingRight: 4, position: 'relative',
            }}
          >
            {filtered.map(event => (
              <EventCard key={event.id} event={event} onNavigate={onNavigate} />
            ))}
          </div>
        )}

        {/* New events indicator */}
        {!autoScroll && newEventsCount > 0 && (
          <button
            onClick={scrollToBottom}
            style={{
              position: 'absolute', bottom: 80, left: '35%', transform: 'translateX(-50%)',
              padding: '6px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
              boxShadow: '0 2px 12px rgba(59,130,246,0.4)', zIndex: 10,
            }}
          >
            New events ↓ ({newEventsCount})
          </button>
        )}
      </div>

      {/* ── Right: Health Sidebar ── */}
      <div style={{
        flex: '0 0 30%', minWidth: 260, maxWidth: 400, display: 'flex', flexDirection: 'column',
        background: 'var(--color-bg-1)', border: '1px solid var(--color-border)', borderRadius: 'var(--shape-lg)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--color-border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 14 }}>🏥</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-fg)' }}>System Health</span>
          {health && (
            <span style={{
              marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-xl)',
              fontWeight: 600,
              background: health.status === 'ok' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
              color: health.status === 'ok' ? '#22c55e' : '#f59e0b',
            }}>
              {health.status === 'ok' ? '● OK' : '● Degraded'}
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {healthLoading && !health ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} style={{ height: 80, borderRadius: 12, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ) : health ? (
            <>
              {/* System info */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
              }}>
                <InfoCard label="Port" value={String(health.port)} />
                <InfoCard label="Mux" value={health.mux?.available ? '✓ Available' : '✗ Unavailable'} />
                <InfoCard label="Timestamp" value={relativeTime(new Date(health.timestamp).getTime())} />
                <InfoCard label="Agents" value={String(Object.keys(health.agents || {}).length)} />
              </div>

              {/* Agent health cards */}
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--color-fg-2)', marginTop: 16, marginBottom: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                Agent Health
              </div>
              {healthAgents.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--color-fg-2)', textAlign: 'center', padding: 16 }}>
                  No agents reported
                </div>
              ) : (
                healthAgents.map(agent => (
                  <div key={agent.name}>
                    <div
                      onClick={() => toggleAgent(agent.name)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                        background: 'var(--color-bg-2)', borderRadius: 'var(--shape-md)', cursor: 'pointer',
                        border: expandedAgent === agent.name ? '1px solid var(--color-border-1)' : '1px solid var(--color-border)',
                        transition: 'all var(--duration-short) var(--ease-standard)',
                      }}
                    >
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: STATUS_DOT_COLORS[agent.status] ?? '#94a3b8',
                        animation: agent.status === 'crashed' ? 'pulse 1.5s infinite' : undefined,
                      }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.name}
                      </span>
                      <span style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-xl)', fontWeight: 500,
                        background: STATUS_DOT_COLORS[agent.status] ? `${STATUS_DOT_COLORS[agent.status]}22` : 'var(--color-bg-3)',
                        color: STATUS_DOT_COLORS[agent.status] ?? 'var(--color-fg-2)',
                      }}>
                        {agent.status}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--color-fg-2)', transform: expandedAgent === agent.name ? 'rotate(90deg)' : 'none', transition: 'transform var(--duration-short) var(--ease-standard)' }}>
                        ▶
                      </span>
                    </div>

                    {/* Expanded status history */}
                    {expandedAgent === agent.name && (
                      <div style={{
                        padding: '8px 10px', marginTop: 4, background: 'var(--color-bg)',
                        borderRadius: 'var(--shape-md)', border: '1px solid var(--color-border)',
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-fg-2)', marginBottom: 6 }}>
                          Status History
                        </div>
                        {historyLoading === agent.name ? (
                          <div style={{ fontSize: 11, color: 'var(--color-fg-2)', padding: 8, textAlign: 'center' }} className="animate-pulse">
                            Loading…
                          </div>
                        ) : (statusHistory[agent.name]?.length ?? 0) === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--color-fg-2)', padding: 8, textAlign: 'center' }}>
                            No transitions recorded
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                            {statusHistory[agent.name]!.map((change, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                                <span style={{ color: 'var(--color-fg-2)', fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                                  {relativeTime(new Date(change.timestamp).getTime())}
                                </span>
                                <StatusBadge status={change.oldStatus} />
                                <span style={{ color: 'var(--color-fg-2)' }}>→</span>
                                <StatusBadge status={change.newStatus} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-fg-2)', textAlign: 'center', padding: 24 }}>
              Health endpoint unavailable
            </div>
          )}
        </div>

        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function EventCard({ event, onNavigate }: { event: ActivityEvent; onNavigate?: (page: string, context?: { agent?: string }) => void }) {
  const badge = getTypeBadge(event.type);
  const sevColor = SEVERITY_COLORS[event.severity] ?? SEVERITY_COLORS.info;

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
      background: 'var(--color-bg-1)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--shape-md)', borderLeft: `3px solid ${sevColor}`,
      transition: 'box-shadow var(--duration-short) var(--ease-standard), transform var(--duration-short) var(--ease-standard)',
      cursor: 'default',
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--card-shadow-hover)'; }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
    >
      {/* Timestamp */}
      <span style={{ fontSize: 10, color: 'var(--color-fg-2)', flexShrink: 0, minWidth: 52, fontVariantNumeric: 'tabular-nums', paddingTop: 2 }}>
        {relativeTime(new Date(event.timestamp).getTime())}
      </span>

      {/* Type badge */}
      <span style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 'var(--shape-xl)', fontWeight: 600, flexShrink: 0,
        background: badge.bg, color: badge.fg, whiteSpace: 'nowrap',
      }}>
        {event.type}
      </span>

      {/* Agent name */}
      {event.agent && (
        <button
          onClick={() => onNavigate?.('dashboard', { agent: event.agent! })}
          style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 'var(--shape-xl)', fontWeight: 600, flexShrink: 0,
            background: 'var(--color-bg-3)',
            color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline',
            fontFamily: 'monospace', border: 'none',
          }}>
          {event.agent}
        </button>
      )}

      {/* Message */}
      <span style={{ fontSize: 12, color: 'var(--color-fg)', flex: 1, lineHeight: 1.4 }}>
        {event.message}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_DOT_COLORS[status] ?? '#94a3b8';
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 'var(--shape-xl)', fontWeight: 500,
      background: `${color}22`, color,
      animation: status === 'crashed' ? 'pulse 1.5s infinite' : undefined,
    }}>
      {status}
    </span>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: 'var(--color-bg-2)', borderRadius: 'var(--shape-md)', padding: '8px 10px',
      border: '1px solid var(--color-border)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--color-fg-2)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-fg)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={label}
      style={{
        fontSize: 11, padding: '6px 12px', borderRadius: 'var(--shape-xl)',
        background: 'var(--color-bg-1)', border: '1px solid var(--color-border)',
        color: 'var(--color-fg)', outline: 'none', cursor: 'pointer',
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
