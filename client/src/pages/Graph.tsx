import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../lib/api';
import type { AgentData } from '../lib/api';

interface RelayEntry {
  from: string;
  to: string;
  message: string;
  timestamp: string;
}

interface GraphNode {
  id: string;
  x: number;
  y: number;
  status: AgentData['status'];
  type?: string;
  isVirtual?: boolean; // "me" or other non-agent nodes
}

interface GraphEdge {
  from: string;
  to: string;
  count: number;
  lastMessage?: string;
  lastTime?: string;
}

const R = 18; // node radius

const statusColor = (s: string) =>
  s === 'running' ? '#10b981' : s === 'idle' ? '#10b981' : '#52525b';
const statusBg = (s: string) =>
  s === 'running' ? 'rgba(16,185,129,0.12)' : s === 'idle' ? 'rgba(16,185,129,0.08)' : 'rgba(82,82,91,0.10)';

function buildGraph(relays: RelayEntry[], agents: AgentData[]) {
  const edgeMap = new Map<string, GraphEdge>();
  const agentNames = new Set(agents.map(a => a.name));
  const statusMap = new Map(agents.map(a => [a.name, a]));

  for (const r of relays) {
    const key = `${r.from}→${r.to}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count++;
      if (!existing.lastTime || r.timestamp > existing.lastTime) {
        existing.lastMessage = r.message;
        existing.lastTime = r.timestamp;
      }
    } else {
      edgeMap.set(key, { from: r.from, to: r.to, count: 1, lastMessage: r.message, lastTime: r.timestamp });
    }
    agentNames.add(r.from);
    agentNames.add(r.to);
  }

  const nodeArr = Array.from(agentNames);
  // Place connected nodes centrally, disconnected on the periphery
  const connectedSet = new Set<string>();
  for (const e of edgeMap.values()) { connectedSet.add(e.from); connectedSet.add(e.to); }
  const connected = nodeArr.filter(n => connectedSet.has(n));
  const disconnected = nodeArr.filter(n => !connectedSet.has(n));

  const nodes: GraphNode[] = [];
  const cx = 400, cy = 300;

  // Connected nodes in a tight cluster
  const cRadius = Math.max(80, connected.length * 35);
  connected.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / Math.max(connected.length, 1) - Math.PI / 2;
    const agent = statusMap.get(id);
    nodes.push({
      id, x: cx + cRadius * Math.cos(angle), y: cy + cRadius * Math.sin(angle),
      status: agent?.status || 'stopped', type: agent?.type, isVirtual: !statusMap.has(id),
    });
  });

  // Disconnected nodes in a wider ring below
  const dRadius = Math.max(cRadius + 100, 200);
  disconnected.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / Math.max(disconnected.length, 1) - Math.PI / 2;
    const agent = statusMap.get(id);
    nodes.push({
      id, x: cx + dRadius * Math.cos(angle), y: cy + dRadius * Math.sin(angle),
      status: agent?.status || 'stopped', type: agent?.type, isVirtual: !statusMap.has(id),
    });
  });

  // Run force layout
  forceLayout(nodes, Array.from(edgeMap.values()), cx, cy);

  return { nodes, edges: Array.from(edgeMap.values()) };
}

function forceLayout(nodes: GraphNode[], edges: GraphEdge[], cx: number, cy: number, iterations = 100) {
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 0.3 * (1 - iter / iterations);
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x || 0.1;
        const dy = nodes[j].y - nodes[i].y || 0.1;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (600 * alpha) / (dist * dist);
        nodes[i].x -= (dx / dist) * force;
        nodes[i].y -= (dy / dist) * force;
        nodes[j].x += (dx / dist) * force;
        nodes[j].y += (dy / dist) * force;
      }
    }
    // Edge attraction
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 120) * 0.02 * alpha;
      a.x += (dx / dist) * force;
      a.y += (dy / dist) * force;
      b.x -= (dx / dist) * force;
      b.y -= (dy / dist) * force;
    }
    // Center gravity
    for (const n of nodes) {
      n.x += (cx - n.x) * 0.008 * alpha;
      n.y += (cy - n.y) * 0.008 * alpha;
    }
  }
}

function timeAgo(ts: string) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

export default function Graph() {
  const [relays, setRelays] = useState<RelayEntry[]>([]);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    Promise.all([api.getRelays(200), api.getAgents()])
      .then(([r, a]) => { setRelays(r); setAgents(a); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([api.getRelays(200), api.getAgents()])
      .then(([r, a]) => { setRelays(r); setAgents(a); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const { nodes, edges } = useMemo(() => buildGraph(relays, agents), [relays, agents]);
  const maxCount = Math.max(1, ...edges.map(e => e.count));

  const viewBox = useMemo(() => {
    if (!nodes.length) return '0 0 800 600';
    const pad = 80;
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    return `${x0} ${y0} ${Math.max(...xs) - x0 + pad} ${Math.max(...ys) - y0 + pad}`;
  }, [nodes]);

  // Edges connected to selected/hovered node
  const activeNode = selected || hovered;
  const connectedNodes = useMemo(() => {
    if (!activeNode) return null;
    const s = new Set<string>([activeNode]);
    edges.forEach(e => { if (e.from === activeNode) s.add(e.to); if (e.to === activeNode) s.add(e.from); });
    return s;
  }, [activeNode, edges]);

  // Selected node detail
  const selectedAgent = agents.find(a => a.name === selected);
  const selectedEdges = useMemo(() => {
    if (!selected) return [];
    return edges.filter(e => e.from === selected || e.to === selected);
  }, [selected, edges]);
  const selectedRelays = useMemo(() => {
    if (!selected) return [];
    return relays.filter(r => r.from === selected || r.to === selected).slice(0, 20);
  }, [selected, relays]);

  if (loading) {
    return <div className="flex items-center justify-center h-60"><span className="spinner" /></div>;
  }

  const idleCount = agents.filter(a => a.status === 'idle').length;
  const runCount = agents.filter(a => a.status === 'running').length;
  const stopCount = agents.filter(a => a.status === 'stopped').length;

  return (
    <div className="flex gap-0 h-[calc(100vh-56px)]">
      {/* Graph area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-semibold text-fg">Relay Graph</h2>
            <div className="flex items-center gap-2 text-[11px] text-fg-2">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{runCount + idleCount} active</span>
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-fg-2" />{stopCount} stopped</span>
              <span className="text-fg-2/30">·</span>
              <span>{edges.length} connection{edges.length !== 1 ? 's' : ''}</span>
              <span className="text-fg-2/30">·</span>
              <span>{relays.length} message{relays.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selected && (
              <button className="btn text-[11px] px-2 py-1" onClick={() => setSelected(null)}>✕ Clear</button>
            )}
            <button className="btn text-[11px] px-2 py-1" onClick={refresh}>↻ Refresh</button>
          </div>
        </div>

        {/* SVG canvas */}
        <div className="flex-1 relative bg-bg-1">
          {edges.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-fg-2">
              <div className="text-4xl opacity-10 mb-4">⊙</div>
              <p className="text-sm">No relay connections yet</p>
              <p className="text-[11px] text-fg-2/50 mt-1">{agents.length} agents loaded — send a relay to see the graph</p>
            </div>
          ) : null}
          <svg ref={svgRef} viewBox={viewBox} className="w-full h-full" onClick={() => setSelected(null)}>
            <defs>
              <marker id="arrow" markerWidth="6" markerHeight="5" refX="5.5" refY="2.5" orient="auto">
                <path d="M0,0 L6,2.5 L0,5" fill="none" stroke="var(--color-fg-2, #71717a)" strokeWidth="1" opacity="0.5" />
              </marker>
              <marker id="arrow-hl" markerWidth="6" markerHeight="5" refX="5.5" refY="2.5" orient="auto">
                <path d="M0,0 L6,2.5 L0,5" fill="none" stroke="#3b82f6" strokeWidth="1.2" />
              </marker>
            </defs>

            {/* Edges */}
            {edges.map(e => {
              const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
              if (!a || !b) return null;
              const dx = b.x - a.x, dy = b.y - a.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const ux = dx / dist, uy = dy / dist;
              // Offset start/end from node center
              const x1 = a.x + ux * (R + 3), y1 = a.y + uy * (R + 3);
              const x2 = b.x - ux * (R + 8), y2 = b.y - uy * (R + 8);
              const key = `${e.from}→${e.to}`;
              const isActive = activeNode && (e.from === activeNode || e.to === activeNode);
              const isDimmed = activeNode && !isActive;
              const w = 1 + (e.count / maxCount) * 2.5;
              // Curved edge (quadratic bezier with slight offset)
              const mx = (x1 + x2) / 2 - uy * 20, my = (y1 + y2) / 2 + ux * 20;

              return (
                <g key={key} opacity={isDimmed ? 0.08 : 1}>
                  <path
                    d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`}
                    fill="none"
                    stroke={isActive ? '#3b82f6' : 'var(--color-fg-2, #71717a)'}
                    strokeWidth={w}
                    strokeOpacity={isActive ? 0.7 : 0.25}
                    markerEnd={isActive ? 'url(#arrow-hl)' : 'url(#arrow)'}
                  />
                  {/* Count badge on edge */}
                  {e.count > 1 && !isDimmed && (
                    <g>
                      <rect x={mx - 8} y={my - 7} width={16} height={14} rx={4}
                        fill="var(--color-bg-2, #27272a)" stroke="var(--color-border, #3f3f46)" strokeWidth={0.5} />
                      <text x={mx} y={my + 1} textAnchor="middle" dominantBaseline="middle"
                        fill="var(--color-fg-2, #a1a1aa)" style={{ fontSize: 8, fontFamily: 'JetBrains Mono, monospace' }}>
                        {e.count}×
                      </text>
                    </g>
                  )}
                  {/* Wider hitbox */}
                  <path d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }} />
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map(node => {
              const isSelected = selected === node.id;
              const isHov = hovered === node.id;
              const isDimmed = connectedNodes && !connectedNodes.has(node.id);
              const color = statusColor(node.status);
              const bg = statusBg(node.status);
              const nodeEdgeCount = edges.filter(e => e.from === node.id || e.to === node.id).length;

              return (
                <g key={node.id}
                  onClick={ev => { ev.stopPropagation(); setSelected(isSelected ? null : node.id); }}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  style={{ cursor: 'pointer' }}
                  opacity={isDimmed ? 0.1 : 1}
                >
                  {/* Selection ring */}
                  {isSelected && (
                    <circle cx={node.x} cy={node.y} r={R + 5} fill="none" stroke="#3b82f6" strokeWidth={1.5} opacity={0.6} />
                  )}
                  {/* Hover ring */}
                  {isHov && !isSelected && (
                    <circle cx={node.x} cy={node.y} r={R + 4} fill="none" stroke="var(--color-fg-2, #71717a)" strokeWidth={0.5} opacity={0.4} />
                  )}
                  {/* Node circle */}
                  <circle cx={node.x} cy={node.y} r={R} fill={bg} stroke={color} strokeWidth={isSelected ? 2 : 1} />
                  {/* Icon inside */}
                  <text x={node.x} y={node.y + 1} textAnchor="middle" dominantBaseline="middle"
                    style={{ fontSize: 12 }}>
                    {node.isVirtual ? '👤' : node.type === 'headless' ? '⚡' : '📺'}
                  </text>
                  {/* Label below */}
                  <text x={node.x} y={node.y + R + 12} textAnchor="middle"
                    fill="var(--color-fg, #fafafa)" style={{ fontSize: 10, fontFamily: 'Inter, sans-serif', fontWeight: 500 }}>
                    {node.id.length > 16 ? node.id.slice(0, 14) + '…' : node.id}
                  </text>
                  {/* Edge count badge */}
                  {nodeEdgeCount > 0 && (
                    <g>
                      <circle cx={node.x + R - 2} cy={node.y - R + 2} r={7}
                        fill="var(--color-bg-2, #27272a)" stroke={color} strokeWidth={1} />
                      <text x={node.x + R - 2} y={node.y - R + 3} textAnchor="middle" dominantBaseline="middle"
                        fill="var(--color-fg, #fafafa)" style={{ fontSize: 7, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                        {nodeEdgeCount}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-[300px] border-l border-border bg-bg flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-fg truncate">{selected}</h3>
              <button className="text-fg-2 hover:text-fg text-xs" onClick={() => setSelected(null)}>✕</button>
            </div>
            {selectedAgent && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="badge" style={{ color: statusColor(selectedAgent.status), background: statusBg(selectedAgent.status) }}>
                  {selectedAgent.status}
                </span>
                {selectedAgent.type === 'headless' && <span className="badge text-cyan-400 bg-cyan-400/10">⚡ headless</span>}
                {selectedAgent.model && <span className="badge text-fg-2 bg-bg-2">{selectedAgent.model.replace('claude-', '').replace('gpt-', '')}</span>}
              </div>
            )}
            {!selectedAgent && <p className="text-[11px] text-fg-2/50 mt-1">External / virtual node</p>}
          </div>

          {/* Connections */}
          <div className="px-4 py-3 border-b border-border">
            <h4 className="text-[11px] font-semibold text-fg-2 uppercase tracking-wider mb-2">
              Connections ({selectedEdges.length})
            </h4>
            {selectedEdges.length === 0 ? (
              <p className="text-[11px] text-fg-2/40">No connections</p>
            ) : (
              <div className="space-y-1.5">
                {selectedEdges.map(e => (
                  <div key={`${e.from}→${e.to}`} className="card-surface p-2 !rounded-md">
                    <div className="flex items-center gap-1 text-[11px]">
                      <span className={e.from === selected ? 'text-emerald-400' : 'text-fg-2'}>{e.from}</span>
                      <span className="text-fg-2/30">→</span>
                      <span className={e.to === selected ? 'text-emerald-400' : 'text-fg-2'}>{e.to}</span>
                      <span className="ml-auto badge text-fg-2/60 bg-bg-2">{e.count}×</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <h4 className="text-[11px] font-semibold text-fg-2 uppercase tracking-wider mb-2">
              Recent Messages ({selectedRelays.length})
            </h4>
            {selectedRelays.length === 0 ? (
              <p className="text-[11px] text-fg-2/40">No messages</p>
            ) : (
              <div className="space-y-2">
                {selectedRelays.map((r, i) => (
                  <div key={i} className="card-surface p-2.5 !rounded-md">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1 text-[10px]">
                        <span className="text-emerald-400/70">{r.from}</span>
                        <span className="text-fg-2/30">→</span>
                        <span className="text-blue-400/70">{r.to}</span>
                      </div>
                      <span className="text-[9px] text-fg-2/30">{timeAgo(r.timestamp)}</span>
                    </div>
                    <p className="text-[11px] text-fg-2 leading-relaxed break-words">
                      {r.message.length > 120 ? r.message.slice(0, 120) + '…' : r.message}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
