import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { api, type AgentData } from '../lib/api';
import { useAgentStatus } from '../hooks/useAgentStatus';

/* ── Types ─────────────────────────────────────────── */
interface Relay { from: string; to: string; message: string; timestamp: string }
interface CardRect { cx: number; cy: number; w: number; h: number }

/* ── Helpers ────────────────────────────────────────── */
function sc(status: string) {
  if (status === 'running') return '#22c55e';
  if (status === 'idle') return '#eab308';
  return '#71717a';
}

function scBg(status: string) {
  if (status === 'running') return 'rgba(34,197,94,0.07)';
  if (status === 'idle') return 'rgba(234,179,8,0.07)';
  return 'rgba(113,113,122,0.05)';
}

function scBorder(status: string) {
  if (status === 'running') return 'rgba(34,197,94,0.3)';
  if (status === 'idle') return 'rgba(234,179,8,0.3)';
  return 'rgba(113,113,122,0.15)';
}

function modelShort(m?: string): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/^gpt-/, 'gpt-');
}

function truncStr(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/* ── Component ──────────────────────────────────────── */
export default function TownView() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const { status: wsStatus } = useAgentStatus();
  const [relays, setRelays] = useState<Relay[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatMsg, setChatMsg] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardElems = useRef(new Map<string, HTMLDivElement>());
  const [cardRects, setCardRects] = useState(new Map<string, CardRect>());
  const [tick, setTick] = useState(0);

  /* ── Data fetching ── */
  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (!wsStatus) return;
    api.getAgents().then(setAgents).catch(() => {});
  }, [wsStatus]);

  useEffect(() => {
    api.getRelays(50).then(setRelays).catch(() => {});
    const iv = setInterval(() => api.getRelays(50).then(setRelays).catch(() => {}), 30_000);
    return () => clearInterval(iv);
  }, []);

  // Clear selection if agent disappears
  useEffect(() => {
    if (selected && !agents.some(a => a.name === selected)) setSelected(null);
  }, [agents, selected]);

  /* ── Measure card positions for SVG relay lines ── */
  useEffect(() => {
    const measure = () => {
      const cont = contentRef.current;
      if (!cont) return;
      const cr = cont.getBoundingClientRect();
      const m = new Map<string, CardRect>();
      cardElems.current.forEach((el, name) => {
        const r = el.getBoundingClientRect();
        m.set(name, {
          cx: r.left - cr.left + r.width / 2,
          cy: r.top - cr.top + r.height / 2,
          w: r.width,
          h: r.height,
        });
      });
      setCardRects(m);
    };
    const t = requestAnimationFrame(() => setTimeout(measure, 30));
    const ro = new ResizeObserver(() => requestAnimationFrame(() => setTimeout(measure, 30)));
    if (contentRef.current) ro.observe(contentRef.current);
    const scEl = scrollRef.current;
    const onScroll = () => setTick(t => t + 1); // trigger SVG re-pos on scroll
    scEl?.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(t); ro.disconnect(); scEl?.removeEventListener('scroll', onScroll); };
  }, [agents, selected, tick]);

  /* ── Derived data ── */
  const sorted = useMemo(() => {
    const ord: Record<string, number> = { running: 0, idle: 1, stopped: 2 };
    return [...agents].sort((a, b) => {
      const d = (ord[a.status] ?? 3) - (ord[b.status] ?? 3);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }, [agents]);

  const edges = useMemo(() => {
    const m = new Map<string, { from: string; to: string; count: number; last: string }>();
    for (const r of relays) {
      const key = [r.from, r.to].sort().join('\0');
      const e = m.get(key);
      if (e) { e.count++; e.last = r.message; }
      else m.set(key, { from: r.from, to: r.to, count: 1, last: r.message });
    }
    return Array.from(m.values());
  }, [relays]);

  const connectedNames = useMemo(() => {
    const s = new Set<string>();
    edges.forEach(e => { s.add(e.from); s.add(e.to); });
    return s;
  }, [edges]);

  const selAgent = agents.find(a => a.name === selected);
  const selEdges = useMemo(() => {
    if (!selected) return [];
    return edges.filter(e => e.from === selected || e.to === selected);
  }, [selected, edges]);

  const counts = useMemo(() => ({
    total: agents.length,
    running: agents.filter(a => a.status === 'running').length,
    idle: agents.filter(a => a.status === 'idle').length,
    stopped: agents.filter(a => a.status === 'stopped').length,
  }), [agents]);

  /* ── Actions ── */
  const handleStop = useCallback(async (name: string) => {
    try { await api.stopAgent(name); } catch { /* */ }
  }, []);

  const handleChat = useCallback(async () => {
    if (!selected || !chatMsg.trim()) return;
    setSending(true);
    try { await api.sendMessage(selected, chatMsg.trim()); setChatMsg(''); }
    catch { /* */ } finally { setSending(false); }
  }, [selected, chatMsg]);

  const setRef = useCallback((name: string) => (el: HTMLDivElement | null) => {
    if (el) cardElems.current.set(name, el);
    else cardElems.current.delete(name);
  }, []);

  const contentH = contentRef.current?.scrollHeight ?? 600;
  const contentW = contentRef.current?.scrollWidth ?? 800;

  return (
    <div style={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)' }}>

      {/* ═══ Header stats bar ═══ */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg-1)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
            🏘️ Copilot Town
          </h2>
          <div style={{ display: 'flex', gap: '14px', fontSize: '12px', color: 'var(--color-fg-2)' }}>
            <span>{counts.total} agent{counts.total !== 1 ? 's' : ''}</span>
            {counts.running > 0 && <span style={{ color: '#22c55e' }}>● {counts.running} running</span>}
            {counts.idle > 0 && <span style={{ color: '#eab308' }}>● {counts.idle} idle</span>}
            {counts.stopped > 0 && <span style={{ color: '#71717a' }}>○ {counts.stopped} stopped</span>}
          </div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-2)' }}>
          {relays.length > 0 && <span>🔗 {relays.length} relay{relays.length !== 1 ? 's' : ''}</span>}
        </div>
      </div>

      {/* ═══ Main content area ═══ */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ── Scrollable grid + SVG overlay ── */}
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}
          onClick={() => setSelected(null)}>

          <div ref={contentRef} style={{ position: 'relative', padding: '20px', minHeight: '100%' }}>

            {/* SVG relay lines between cards */}
            <svg style={{
              position: 'absolute', top: 0, left: 0,
              width: contentW, height: contentH,
              pointerEvents: 'none', zIndex: 0,
            }}>
              <defs>
                <filter id="glow-line">
                  <feGaussianBlur stdDeviation="2" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              {edges.map((edge, i) => {
                const a = cardRects.get(edge.from);
                const b = cardRects.get(edge.to);
                if (!a || !b) return null;
                const hi = selected === edge.from || selected === edge.to;
                const dx = b.cx - a.cx;
                const dy = b.cy - a.cy;
                const mx = (a.cx + b.cx) / 2 - dy * 0.08;
                const my = (a.cy + b.cy) / 2 + dx * 0.08;
                return (
                  <g key={i}>
                    <path
                      d={`M${a.cx},${a.cy} Q${mx},${my} ${b.cx},${b.cy}`}
                      fill="none"
                      stroke={hi ? '#3b82f6' : '#3f3f46'}
                      strokeWidth={hi ? 2 : 1}
                      strokeOpacity={hi ? 0.6 : 0.2}
                      strokeDasharray={hi ? undefined : '6 4'}
                      filter={hi ? 'url(#glow-line)' : undefined}
                    />
                    {hi && (
                      <circle r="3" fill="#3b82f6" opacity="0.9">
                        <animateMotion
                          dur="2.5s" repeatCount="indefinite"
                          path={`M${a.cx},${a.cy} Q${mx},${my} ${b.cx},${b.cy}`}
                        />
                      </circle>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Empty state */}
            {agents.length === 0 ? (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: 'calc(100vh - 160px)',
                color: 'var(--color-fg-2)', gap: '12px',
              }}>
                <span style={{ fontSize: '56px' }}>🏘️</span>
                <span style={{ fontSize: '16px', fontWeight: 600 }}>No agents in town</span>
                <span style={{ fontSize: '13px' }}>Spawn agents to see them here</span>
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))',
                gap: '12px',
                position: 'relative', zIndex: 1,
              }}>
                {sorted.map(agent => {
                  const isSel = selected === agent.name;
                  const color = sc(agent.status);
                  const isActive = agent.status === 'running' || agent.status === 'idle';
                  const hasConn = connectedNames.has(agent.name);
                  const isRunning = agent.status === 'running';
                  const isRelayHi = selected
                    ? edges.some(e => (e.from === selected && e.to === agent.name) || (e.to === selected && e.from === agent.name))
                    : false;

                  return (
                    <div
                      key={agent.name}
                      ref={setRef(agent.name)}
                      className="card-surface"
                      onClick={e => { e.stopPropagation(); setSelected(s => s === agent.name ? null : agent.name); }}
                      style={{
                        cursor: 'pointer',
                        padding: '14px 16px',
                        borderLeft: `3px solid ${color}`,
                        position: 'relative',
                        overflow: 'hidden',
                        transition: 'all 150ms ease',
                        ...(isSel ? {
                          borderColor: color,
                          background: scBg(agent.status),
                          boxShadow: `0 0 0 1px ${scBorder(agent.status)}, 0 4px 16px rgba(0,0,0,0.3)`,
                        } : isRelayHi ? {
                          borderColor: '#3b82f640',
                          boxShadow: '0 0 0 1px rgba(59,130,246,0.2)',
                        } : {}),
                      }}
                    >
                      {/* Running left-edge glow */}
                      {isRunning && (
                        <div style={{
                          position: 'absolute', top: 0, left: 0, bottom: 0, width: '3px',
                          background: color, boxShadow: `0 0 12px ${color}80`,
                        }} />
                      )}

                      {/* Row 1: Name + Status badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{
                          fontSize: '13px', fontWeight: 600, color: 'var(--color-fg)',
                          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {agent.name}
                        </span>
                        <span className="badge" style={{
                          color, background: scBg(agent.status),
                          border: `1px solid ${scBorder(agent.status)}`,
                          fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>
                          {isActive ? '●' : '○'} {agent.status}
                        </span>
                      </div>

                      {/* Row 2: Type + Model + Flags */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                        <span className="badge" style={{
                          background: 'var(--color-bg-3)', color: 'var(--color-fg-1)', fontSize: '9px',
                        }}>
                          {agent.type === 'headless' ? '⚡' : '📺'} {agent.type ?? 'pane'}
                        </span>
                        {agent.model && (
                          <span className="badge" style={{
                            background: '#3b82f608', color: '#60a5fa',
                            border: '1px solid #3b82f620', fontSize: '9px',
                          }}>
                            {modelShort(agent.model)}
                          </span>
                        )}
                        {agent.flags?.includes('--yolo') && (
                          <span className="badge" style={{
                            background: '#f59e0b08', color: '#f59e0b',
                            border: '1px solid #f59e0b20', fontSize: '9px',
                          }}>
                            🔥 yolo
                          </span>
                        )}
                        {hasConn && (
                          <span style={{ fontSize: '10px', color: 'var(--color-fg-2)', marginLeft: 'auto' }}>🔗</span>
                        )}
                      </div>

                      {/* Row 3: Task or description */}
                      {(agent.task || agent.description) && (
                        <div style={{
                          fontSize: '11px', color: 'var(--color-fg-2)', lineHeight: '1.45',
                          overflow: 'hidden', display: '-webkit-box',
                          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }}>
                          {agent.task || agent.description}
                        </div>
                      )}

                      {/* Row 4: Template + time */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px',
                        fontSize: '10px', color: 'var(--color-fg-2)',
                      }}>
                        {agent.template?.name && (
                          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            📋 {agent.template.name}
                          </span>
                        )}
                        {agent.pane?.target && (
                          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                            🖥 {agent.pane.target}
                          </span>
                        )}
                        {agent.summary && !agent.task && (
                          <span style={{
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            flex: 1, opacity: 0.7,
                          }}>
                            💬 {truncStr(agent.summary, 40)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ═══ Detail side panel ═══ */}
        {selAgent && (
          <div
            className="animate-slide-in-right"
            onClick={e => e.stopPropagation()}
            style={{
              width: '340px', flexShrink: 0,
              borderLeft: '1px solid var(--color-border)',
              background: 'var(--color-bg-1)',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Panel header */}
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'flex-start', gap: '12px',
            }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%', marginTop: '3px', flexShrink: 0,
                background: sc(selAgent.status),
                boxShadow: selAgent.status === 'running' ? `0 0 10px ${sc(selAgent.status)}60` : undefined,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-fg)', wordBreak: 'break-word' }}>
                  {selAgent.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--color-fg-2)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span>{selAgent.type === 'headless' ? '⚡ headless' : '📺 pane'}</span>
                  {selAgent.model && <><span style={{ opacity: 0.4 }}>·</span><span style={{ color: '#60a5fa' }}>{modelShort(selAgent.model)}</span></>}
                </div>
              </div>
              <button className="btn" onClick={() => setSelected(null)}
                style={{ padding: '3px 8px', fontSize: '12px', lineHeight: 1 }}>✕</button>
            </div>

            {/* Panel scrollable body */}
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

              {/* Status section */}
              <Section label="Status">
                <span className="badge" style={{
                  color: sc(selAgent.status), background: scBg(selAgent.status),
                  border: `1px solid ${scBorder(selAgent.status)}`,
                }}>
                  {selAgent.status === 'stopped' ? '○' : '●'} {selAgent.status}
                </span>
              </Section>

              {/* Task */}
              {selAgent.task && (
                <Section label="Current Task">
                  <p style={{ fontSize: '12px', color: 'var(--color-fg-1)', lineHeight: '1.5', margin: 0 }}>
                    {selAgent.task}
                  </p>
                </Section>
              )}

              {/* Description */}
              {selAgent.description && (
                <Section label="Description">
                  <p style={{ fontSize: '12px', color: 'var(--color-fg-1)', lineHeight: '1.5', margin: 0 }}>
                    {selAgent.description}
                  </p>
                </Section>
              )}

              {/* Summary */}
              {selAgent.summary && (
                <Section label="Last Summary">
                  <p style={{ fontSize: '12px', color: 'var(--color-fg-2)', lineHeight: '1.5', margin: 0, fontStyle: 'italic' }}>
                    {truncStr(selAgent.summary, 280)}
                  </p>
                </Section>
              )}

              {/* Details grid */}
              <Section label="Details">
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: '11px' }}>
                  {selAgent.model && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Model</span>
                    <span style={{ color: '#60a5fa', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>{selAgent.model}</span></>
                  )}
                  {selAgent.pane && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Pane</span>
                    <span style={{ color: 'var(--color-fg-1)', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>{selAgent.pane.target}</span></>
                  )}
                  {selAgent.template?.name && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Template</span>
                    <span style={{ color: 'var(--color-fg-1)', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>{selAgent.template.name}</span></>
                  )}
                  {selAgent.sessionId && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Session</span>
                    <span style={{ color: 'var(--color-fg-1)', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>{selAgent.sessionId.slice(0, 12)}…</span></>
                  )}
                  {selAgent.flags && selAgent.flags.length > 0 && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Flags</span>
                    <span style={{ color: '#f59e0b', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px' }}>{selAgent.flags.join(' ')}</span></>
                  )}
                  {selAgent.reasoningEffort && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Reasoning</span>
                    <span style={{ color: 'var(--color-fg-1)', fontSize: '10px' }}>{selAgent.reasoningEffort}</span></>
                  )}
                  {selAgent.agentMode && (
                    <><span style={{ color: 'var(--color-fg-2)' }}>Mode</span>
                    <span style={{ color: 'var(--color-fg-1)', fontSize: '10px' }}>{selAgent.agentMode}</span></>
                  )}
                </div>
              </Section>

              {/* Connections */}
              {selEdges.length > 0 && (
                <Section label={`Connections (${selEdges.length})`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {selEdges.map((edge, i) => {
                      const peer = edge.from === selected ? edge.to : edge.from;
                      const dir = edge.from === selected ? '→' : '←';
                      return (
                        <div key={i} className="card-surface" style={{ padding: '8px 10px', cursor: 'pointer' }}
                          onClick={() => setSelected(peer)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                            <span style={{ color: 'var(--color-fg-2)' }}>{dir}</span>
                            <span style={{ color: 'var(--color-fg)', fontWeight: 600 }}>{peer}</span>
                            <span className="badge" style={{
                              marginLeft: 'auto', background: 'var(--color-bg-3)',
                              color: 'var(--color-fg-2)', fontSize: '9px',
                            }}>
                              {edge.count}×
                            </span>
                          </div>
                          <div style={{
                            fontSize: '10px', color: 'var(--color-fg-2)', marginTop: '4px',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {truncStr(edge.last, 80)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}
            </div>

            {/* Panel actions footer */}
            <div style={{
              padding: '12px 20px', borderTop: '1px solid var(--color-border)',
              display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0,
            }}>
              {/* Chat input (for active agents) */}
              {selAgent.status !== 'stopped' && (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text" placeholder="Send a message…"
                    value={chatMsg} onChange={e => setChatMsg(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleChat()}
                    disabled={sending}
                    style={{
                      flex: 1, fontSize: '11px', padding: '6px 10px',
                      background: 'var(--color-bg-2)', border: '1px solid var(--color-border)',
                      borderRadius: '6px', color: 'var(--color-fg)', outline: 'none',
                    }}
                  />
                  <button className="btn btn-primary" onClick={handleChat}
                    disabled={sending || !chatMsg.trim()}>
                    {sending ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: '1.5px' }} /> : 'Send'}
                  </button>
                </div>
              )}
              {/* Action buttons */}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {selAgent.status !== 'stopped' && (
                  <button className="btn btn-danger" onClick={() => handleStop(selAgent.name)}>
                    ■ Stop
                  </button>
                )}
                {selAgent.pane && (
                  <button className="btn" onClick={() => api.selectPane(selAgent.pane!.target)}>
                    📺 Focus Pane
                  </button>
                )}
                {selAgent.type === 'headless' && selAgent.status !== 'stopped' && (
                  <button className="btn btn-success" onClick={() => api.moveToPaneAgent(selAgent.name)}>
                    📺 Move to pane
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Tiny section helper (keeps panel organized) ── */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{
        fontSize: '10px', color: 'var(--color-fg-2)', textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: '6px', fontWeight: 600,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}
