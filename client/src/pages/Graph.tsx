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
  vx: number;
  vy: number;
  status: AgentData['status'];
}

interface GraphEdge {
  from: string;
  to: string;
  count: number;
}

const STATUS_COLOR: Record<string, string> = {
  running: '#22c55e',
  idle: '#eab308',
  stopped: '#ef4444',
};

const NODE_RADIUS = 24;

function buildGraph(relays: RelayEntry[], agents: AgentData[]) {
  const edgeMap = new Map<string, number>();
  const nodeSet = new Set<string>();

  for (const r of relays) {
    nodeSet.add(r.from);
    nodeSet.add(r.to);
    const key = `${r.from}→${r.to}`;
    edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
  }

  // Also include agents that have no relays
  for (const a of agents) nodeSet.add(a.name);

  const statusMap = new Map<string, AgentData['status']>();
  for (const a of agents) statusMap.set(a.name, a.status);

  const nodeArr = Array.from(nodeSet);
  const cx = 300, cy = 250;
  const radius = Math.max(120, nodeArr.length * 28);

  const nodes: GraphNode[] = nodeArr.map((id, i) => {
    const angle = (2 * Math.PI * i) / nodeArr.length - Math.PI / 2;
    return {
      id,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      vx: 0,
      vy: 0,
      status: statusMap.get(id) || 'stopped',
    };
  });

  const edges: GraphEdge[] = [];
  for (const [key, count] of edgeMap) {
    const [from, to] = key.split('→');
    edges.push({ from, to, count });
  }

  return { nodes, edges };
}

// Simple force simulation (runs a fixed number of iterations)
function forceLayout(nodes: GraphNode[], edges: GraphEdge[], iterations = 80) {
  const cx = 300, cy = 250;
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 1 - iter / iterations;
    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (800 * alpha) / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[i].x -= fx;
        nodes[i].y -= fy;
        nodes[j].x += fx;
        nodes[j].y += fy;
      }
    }
    // Attraction along edges
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
      if (!a || !b) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 150) * 0.01 * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.x += fx;
      a.y += fy;
      b.x -= fx;
      b.y -= fy;
    }
    // Center gravity
    for (const n of nodes) {
      n.x += (cx - n.x) * 0.01 * alpha;
      n.y += (cy - n.y) * 0.01 * alpha;
    }
  }
  return nodes;
}

export default function Graph() {
  const [relays, setRelays] = useState<RelayEntry[]>([]);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
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

  const { nodes, edges } = useMemo(() => {
    const g = buildGraph(relays, agents);
    forceLayout(g.nodes, g.edges);
    return g;
  }, [relays, agents]);

  const maxCount = Math.max(1, ...edges.map(e => e.count));

  // Compute SVG viewBox to fit all nodes
  const viewBox = useMemo(() => {
    if (nodes.length === 0) return '0 0 600 500';
    const pad = 60;
    const minX = Math.min(...nodes.map(n => n.x)) - pad;
    const minY = Math.min(...nodes.map(n => n.y)) - pad;
    const maxX = Math.max(...nodes.map(n => n.x)) + pad;
    const maxY = Math.max(...nodes.map(n => n.y)) + pad;
    return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  }, [nodes]);

  const isConnected = useCallback(
    (nodeId: string) => {
      if (!selected) return true;
      if (nodeId === selected) return true;
      return edges.some(
        e => (e.from === selected && e.to === nodeId) || (e.to === selected && e.from === nodeId)
      );
    },
    [selected, edges]
  );

  const isEdgeHighlighted = useCallback(
    (e: GraphEdge) => {
      if (!selected) return true;
      return e.from === selected || e.to === selected;
    },
    [selected]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-60">
        <span className="text-xs text-fg-2">Loading graph…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">Agent Dependency Graph</h2>
          <p className="text-[11px] text-fg-2 mt-0.5">
            {nodes.length} agents · {edges.length} connections · {relays.length} messages
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected && (
            <button
              className="text-[10px] px-2 py-1 rounded bg-bg-2 text-fg-1 border border-border hover:text-fg"
              onClick={() => setSelected(null)}
            >
              Clear selection
            </button>
          )}
          <button
            className="text-[10px] px-2 py-1 rounded bg-bg-2 text-fg-1 border border-border hover:text-fg hover:border-border-1"
            onClick={refresh}
          >
            ↻
          </button>
        </div>
      </div>

      {relays.length === 0 ? (
        <div className="text-center py-16 text-fg-2 text-xs">
          <span className="text-3xl block mb-3 opacity-20">⊙</span>
          <p>No relay messages yet. Agents will appear here once they communicate.</p>
          <p className="mt-1 text-[10px] text-fg-2/50">
            {agents.length} agents loaded (no edges to draw)
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg bg-bg-1 overflow-hidden">
          <svg
            ref={svgRef}
            viewBox={viewBox}
            className="w-full"
            style={{ height: 'calc(100vh - 200px)', minHeight: 300 }}
            onClick={() => setSelected(null)}
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="7"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 8 3, 0 6"
                  className="fill-fg-2/40"
                />
              </marker>
              <marker
                id="arrowhead-hl"
                markerWidth="8"
                markerHeight="6"
                refX="7"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 8 3, 0 6"
                  className="fill-blue"
                />
              </marker>
            </defs>

            {/* Edges */}
            {edges.map(e => {
              const from = nodes.find(n => n.id === e.from);
              const to = nodes.find(n => n.id === e.to);
              if (!from || !to) return null;

              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const ux = dx / dist;
              const uy = dy / dist;
              const x1 = from.x + ux * (NODE_RADIUS + 2);
              const y1 = from.y + uy * (NODE_RADIUS + 2);
              const x2 = to.x - ux * (NODE_RADIUS + 10);
              const y2 = to.y - uy * (NODE_RADIUS + 10);

              const hl = isEdgeHighlighted(e);
              const hovered = hoveredEdge === `${e.from}→${e.to}`;
              const width = 1 + (e.count / maxCount) * 4;
              const key = `${e.from}→${e.to}`;

              return (
                <g key={key}>
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={hovered ? 'var(--color-blue, #3b82f6)' : hl ? 'var(--color-fg-2, #888)' : 'var(--color-fg-2, #888)'}
                    strokeWidth={width}
                    strokeOpacity={hl ? (hovered ? 0.9 : 0.4) : 0.08}
                    markerEnd={hovered ? 'url(#arrowhead-hl)' : 'url(#arrowhead)'}
                  />
                  {/* Invisible wider hitbox for hover */}
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="transparent"
                    strokeWidth={Math.max(12, width + 8)}
                    onMouseEnter={() => setHoveredEdge(key)}
                    onMouseLeave={() => setHoveredEdge(null)}
                    style={{ cursor: 'pointer' }}
                  />
                  {/* Count label on hover */}
                  {hovered && (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 8}
                      textAnchor="middle"
                      className="fill-fg text-[10px]"
                      style={{ fontSize: 10, fontFamily: 'Inter, sans-serif' }}
                    >
                      {e.count} msg{e.count !== 1 ? 's' : ''}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map(node => {
              const connected = isConnected(node.id);
              const isSelected = selected === node.id;
              const color = STATUS_COLOR[node.status] || '#6b7280';

              return (
                <g
                  key={node.id}
                  onClick={ev => { ev.stopPropagation(); setSelected(isSelected ? null : node.id); }}
                  style={{ cursor: 'pointer' }}
                  opacity={connected ? 1 : 0.15}
                >
                  {/* Glow ring for selected */}
                  {isSelected && (
                    <circle
                      cx={node.x} cy={node.y} r={NODE_RADIUS + 6}
                      fill="none" stroke="var(--color-blue, #3b82f6)" strokeWidth={2}
                      strokeDasharray="4 3" opacity={0.6}
                    />
                  )}
                  <circle
                    cx={node.x} cy={node.y} r={NODE_RADIUS}
                    fill={color} fillOpacity={0.15}
                    stroke={color} strokeWidth={isSelected ? 2 : 1.5}
                  />
                  <text
                    x={node.x} y={node.y + 1}
                    textAnchor="middle" dominantBaseline="middle"
                    className="fill-fg"
                    style={{ fontSize: 9, fontFamily: 'Inter, sans-serif', fontWeight: 500 }}
                  >
                    {node.id.length > 14 ? node.id.slice(0, 12) + '…' : node.id}
                  </text>
                  {/* Status dot */}
                  <circle
                    cx={node.x + NODE_RADIUS - 4} cy={node.y - NODE_RADIUS + 4} r={4}
                    fill={color} stroke="var(--color-bg-1, #1a1a1a)" strokeWidth={1.5}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-[10px] text-fg-2 flex-wrap">
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <div key={s} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: c }} />
            {s}
          </div>
        ))}
        <span className="text-fg-2/30">|</span>
        <span>Edge width = message count</span>
        <span>Click node to filter</span>
      </div>
    </div>
  );
}
