import { useState, useEffect, useRef, useMemo } from 'react';
import { api, type AgentData } from '../lib/api';
import { useAgentStatus } from '../hooks/useAgentStatus';

/* ── Dynamic color/ring from agent name ───────────── */
function hashHex(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  const s = 0.7, l = 0.6;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function agentRing(agent: AgentData): number {
  if (agent.status === 'running') return 0;
  if (agent.status === 'idle') return 1;
  return 2;
}

function agentLabel(agent: AgentData): string {
  const name = agent.template?.name;
  return name ? name.slice(0, 8) : 'session';
}

function agentColor(agent: AgentData): string {
  return hashHex(agent.name);
}

/* ── Types ────────────────────────────────────────── */
interface Relay { from: string; to: string; message: string; timestamp: string }
interface NodePos { name: string; x: number; y: number; agent: AgentData; color: string; ring: number }

export default function TownView() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const { status: wsStatus } = useAgentStatus();
  const [relays, setRelays] = useState<Relay[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Fetch full agent data when WS status updates (avoids redundant REST polling)
  useEffect(() => {
    if (!wsStatus) return;
    api.getAgents().then(setAgents).catch(() => {});
  }, [wsStatus]);

  // Relays: fetch once on mount, then infrequently
  useEffect(() => {
    api.getRelays(50).then(setRelays).catch(() => {});
    const iv = setInterval(() => api.getRelays(50).then(setRelays).catch(() => {}), 30000);
    return () => clearInterval(iv);
  }, []);

  // Resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Layout: concentric rings
  const nodes = useMemo<NodePos[]>(() => {
    const cx = size.w / 2;
    const cy = size.h / 2;
    const maxR = Math.min(size.w, size.h) * 0.4;
    const rings: Map<number, AgentData[]> = new Map();
    agents.forEach(a => {
      const r = agentRing(a);
      if (!rings.has(r)) rings.set(r, []);
      rings.get(r)!.push(a);
    });
    const result: NodePos[] = [];
    rings.forEach((members, ring) => {
      const radius = ring === 0 ? 0 : maxR * (ring / 3) * 0.9;
      members.forEach((a, i) => {
        const angle = (2 * Math.PI * i) / members.length - Math.PI / 2;
        // For ring 0, offset slightly so they don't overlap
        const r0 = ring === 0 ? 35 * (i - (members.length - 1) / 2) : radius;
        const offsetAngle = ring === 0 ? -Math.PI / 2 : angle;
        result.push({
          name: a.name,
          x: ring === 0 ? cx + r0 : cx + radius * Math.cos(angle),
          y: ring === 0 ? cy : cy + radius * Math.sin(angle),
          agent: a,
          color: agentColor(a),
          ring,
        });
      });
    });
    return result;
  }, [agents, size]);

  // Relay edges (unique pairs with count)
  const edges = useMemo(() => {
    const map = new Map<string, { from: string; to: string; count: number }>();
    for (const r of relays) {
      const key = `${r.from}→${r.to}`;
      const e = map.get(key);
      if (e) e.count++;
      else map.set(key, { from: r.from, to: r.to, count: 1 });
    }
    return Array.from(map.values());
  }, [relays]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodePos>();
    nodes.forEach(n => m.set(n.name, n));
    return m;
  }, [nodes]);

  const selAgent = selected ? nodeMap.get(selected) : null;

  const activeCount = agents.filter(a => a.status === 'running' || a.status === 'idle').length;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 80px)' }}>
      {/* Stats bar */}
      <div className="flex items-center justify-between px-2 py-2 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold tracking-tight">🏘️ Copilot Town</h2>
          <div className="flex items-center gap-1.5 text-[10px] text-fg-2">
            <span>{agents.length} agents</span>
            <span className="text-fg-2/30">·</span>
            <span className="text-green-400">{activeCount} alive</span>
            <span className="text-fg-2/30">·</span>
            <span>{relays.length} relays</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-fg-2/60">
          {[['🟢','running'],['🟡','idle'],['🔴','stopped']].map(([icon, label]) => (
            <span key={label} className="flex items-center gap-1">{icon} {label}</span>
          ))}
        </div>
      </div>

      {/* Main visualization */}
      <div ref={containerRef} className="flex-1 min-h-0 relative overflow-hidden rounded-xl border border-white/5"
        style={{ background: 'radial-gradient(ellipse at center, #0d1117 0%, #010409 100%)' }}
        onClick={() => setSelected(null)}>

        {/* Animated grid background */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,.3) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }} />

        {/* Concentric ring guides */}
        {[1, 2, 3].map(ring => {
          const cx = size.w / 2;
          const cy = size.h / 2;
          const maxR = Math.min(size.w, size.h) * 0.4;
          const r = maxR * (ring / 3) * 0.9;
          return (
            <div key={ring} className="absolute rounded-full border border-white/[0.03]"
              style={{
                left: cx - r, top: cy - r,
                width: r * 2, height: r * 2,
              }} />
          );
        })}

        {/* Connection lines (SVG overlay) */}
        <svg className="absolute inset-0 pointer-events-none" width={size.w} height={size.h}>
          <defs>
            {edges.map((e, i) => {
              const from = nodeMap.get(e.from);
              const to = nodeMap.get(e.to);
              if (!from || !to) return null;
              return (
                <linearGradient key={i} id={`edge-grad-${i}`}
                  x1={from.x} y1={from.y} x2={to.x} y2={to.y} gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor={from.color} stopOpacity="0.4" />
                  <stop offset="100%" stopColor={to.color} stopOpacity="0.4" />
                </linearGradient>
              );
            })}
          </defs>
          {edges.map((e, i) => {
            const from = nodeMap.get(e.from);
            const to = nodeMap.get(e.to);
            if (!from || !to) return null;
            const isHighlight = selected === e.from || selected === e.to;
            // Curve the line
            const mx = (from.x + to.x) / 2;
            const my = (from.y + to.y) / 2;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const cx = mx - dy * 0.12;
            const cy = my + dx * 0.12;
            return (
              <g key={i}>
                <path
                  d={`M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`}
                  fill="none"
                  stroke={isHighlight ? `url(#edge-grad-${i})` : 'rgba(255,255,255,0.04)'}
                  strokeWidth={isHighlight ? 1.5 : 0.5}
                  strokeDasharray={isHighlight ? 'none' : '4 4'}
                />
                {/* Animated particle along path */}
                {isHighlight && (
                  <circle r="2.5" fill={from.color} opacity="0.8">
                    <animateMotion
                      dur={`${2 + Math.random()}s`}
                      repeatCount="indefinite"
                      path={`M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`}
                    />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>

        {/* Agent nodes */}
        {nodes.map(n => {
          const isActive = n.agent.status === 'running' || n.agent.status === 'idle';
          const isRunning = n.agent.status === 'running';
          const isSel = selected === n.name;
          const isHov = hovered === n.name;
          const sz = isSel ? 52 : isHov ? 48 : isActive ? 44 : 36;

          return (
            <div key={n.name}
              className="absolute flex flex-col items-center cursor-pointer transition-all duration-300 ease-out group"
              style={{
                left: n.x - sz / 2,
                top: n.y - sz / 2,
                width: sz,
                zIndex: isSel ? 30 : isHov ? 20 : 10,
              }}
              onClick={e => { e.stopPropagation(); setSelected(s => s === n.name ? null : n.name); }}
              onMouseEnter={() => setHovered(n.name)}
              onMouseLeave={() => setHovered(null)}>

              {/* Outer pulse ring for running agents */}
              {isRunning && (
                <div className="absolute rounded-full animate-ping"
                  style={{
                    width: sz + 16, height: sz + 16,
                    left: -8, top: -8,
                    border: `1px solid ${n.color}`,
                    opacity: 0.15,
                    animationDuration: '2s',
                  }} />
              )}

              {/* Glow halo */}
              {isActive && (
                <div className="absolute rounded-full transition-all duration-500"
                  style={{
                    width: sz + 24, height: sz + 24,
                    left: -12, top: -12,
                    background: `radial-gradient(circle, ${n.color}15 0%, transparent 70%)`,
                    transform: isSel ? 'scale(1.3)' : 'scale(1)',
                  }} />
              )}

              {/* Node body */}
              <div className="relative rounded-full flex items-center justify-center transition-all duration-300"
                style={{
                  width: sz, height: sz,
                  background: isActive
                    ? `radial-gradient(circle at 35% 35%, ${n.color}20, ${n.color}08)`
                    : 'rgba(255,255,255,0.02)',
                  border: `${isSel ? 2 : 1}px solid ${isActive ? n.color + (isSel ? '80' : '40') : 'rgba(255,255,255,0.06)'}`,
                  boxShadow: isActive
                    ? `0 0 ${isSel ? 20 : 10}px ${n.color}20, inset 0 0 ${isSel ? 15 : 8}px ${n.color}10`
                    : 'none',
                }}>

                {/* Status dot */}
                <div className="rounded-full transition-all duration-300"
                  style={{
                    width: isActive ? 8 : 5,
                    height: isActive ? 8 : 5,
                    background: isRunning ? '#22c55e' : n.agent.status === 'idle' ? '#eab308'
                      : n.agent.status === 'stopped' ? '#ef4444' : '#333',
                    boxShadow: isRunning ? '0 0 8px #22c55e60' : n.agent.status === 'idle' ? '0 0 6px #eab30840' : 'none',
                  }} />
              </div>

              {/* Name label */}
              <span className="mt-1.5 text-center leading-tight transition-all duration-200 whitespace-nowrap"
                style={{
                  fontSize: isSel ? 10 : 8,
                  fontWeight: isSel || isHov ? 600 : 400,
                  color: isActive ? '#e2e8f0' : '#475569',
                  textShadow: isActive ? `0 0 12px ${n.color}40` : 'none',
                }}>
                {n.name.replace(/-/g, ' ')}
              </span>

              {/* Domain badge */}
              <span className="text-[7px] font-medium tracking-wider uppercase transition-opacity duration-200"
                style={{
                  color: n.color + '80',
                  opacity: isHov || isSel ? 1 : 0.5,
                }}>
                {agentLabel(n.agent)}
              </span>
            </div>
          );
        })}

        {/* Floating ambient particles */}
        {Array.from({ length: 15 }, (_, i) => {
          const speed = 20 + (i * 7) % 30;
          const delay = (i * 3) % 20;
          const startX = (i * 137) % 100;
          const startY = (i * 89) % 100;
          return (
            <div key={`p-${i}`}
              className="absolute rounded-full pointer-events-none"
              style={{
                width: 2,
                height: 2,
                background: `rgba(${100 + (i * 30) % 155}, ${100 + (i * 50) % 155}, 255, ${0.1 + (i % 5) * 0.04})`,
                left: `${startX}%`,
                top: `${startY}%`,
                animation: `float-particle-${i % 3} ${speed}s ${delay}s linear infinite`,
              }} />
          );
        })}
      </div>

      {/* Selected agent detail panel */}
      {selAgent && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[90%] max-w-md animate-fade-in"
          onClick={e => e.stopPropagation()}>
          <div className="rounded-xl border backdrop-blur-xl px-5 py-4"
            style={{
              background: `linear-gradient(135deg, rgba(0,0,0,0.85), rgba(0,0,0,0.92))`,
              borderColor: selAgent.color + '30',
              boxShadow: `0 0 30px ${selAgent.color}10, 0 20px 60px rgba(0,0,0,0.5)`,
            }}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-3 h-3 rounded-full"
                style={{ background: selAgent.color, boxShadow: `0 0 10px ${selAgent.color}60` }} />
              <span className="text-sm font-bold">{selAgent.name}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full ml-auto font-medium"
                style={{
                  color: selAgent.agent.status === 'running' ? '#22c55e' : selAgent.agent.status === 'idle' ? '#eab308' : '#888',
                  background: selAgent.agent.status === 'running' ? '#22c55e12' : selAgent.agent.status === 'idle' ? '#eab30812' : '#88888808',
                  border: `1px solid ${selAgent.agent.status === 'running' ? '#22c55e20' : selAgent.agent.status === 'idle' ? '#eab30820' : '#88888815'}`,
                }}>
                {selAgent.agent.status}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">{selAgent.agent.template?.description || 'Copilot session'}</p>
            {selAgent.agent.pane && (
              <p className="text-[9px] text-slate-600 mt-1 font-mono">📍 pane {selAgent.agent.pane.target}</p>
            )}

            {/* Relay connections */}
            {edges.filter(e => e.from === selected || e.to === selected).length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/5">
                <p className="text-[8px] text-slate-500 uppercase tracking-widest mb-1.5">Connections</p>
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set(edges.filter(e => e.from === selected || e.to === selected)
                    .flatMap(e => [e.from, e.to])
                    .filter(n => n !== selected))].map(peer => {
                    const peerNode = nodeMap.get(peer);
                    return (
                      <span key={peer} className="text-[9px] px-2 py-0.5 rounded-full cursor-pointer hover:opacity-100 transition-opacity"
                        style={{
                          color: peerNode?.color || '#888',
                          background: (peerNode?.color || '#888') + '10',
                          border: `1px solid ${(peerNode?.color || '#888')}20`,
                          opacity: 0.7,
                        }}
                        onClick={() => setSelected(peer)}>
                        {peer}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* CSS keyframes for floating particles */}
      <style>{`
        @keyframes float-particle-0 {
          0% { transform: translate(0, 0); opacity: 0; }
          10% { opacity: 0.3; }
          90% { opacity: 0.3; }
          100% { transform: translate(200px, -300px); opacity: 0; }
        }
        @keyframes float-particle-1 {
          0% { transform: translate(0, 0); opacity: 0; }
          10% { opacity: 0.2; }
          90% { opacity: 0.2; }
          100% { transform: translate(-150px, -250px); opacity: 0; }
        }
        @keyframes float-particle-2 {
          0% { transform: translate(0, 0); opacity: 0; }
          10% { opacity: 0.25; }
          90% { opacity: 0.25; }
          100% { transform: translate(100px, -350px); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
