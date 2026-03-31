import { useState, useMemo } from 'react';

/* ─── Types ───────────────────────────────────────────────────────── */

interface StepResult {
  id: string; name?: string; status: string; output: string;
  error?: string; startedAt?: string; finishedAt?: string; tokens?: number; agentName?: string;
  iteration?: number; iterations?: { attempt: number; output: string; tokens?: number; review?: { pass: boolean; feedback: string } }[];
}

interface StepDef {
  id: string; name?: string; needs?: string[]; prompt?: string;
}

interface WorkflowDAGProps {
  steps: StepDef[];
  stepResults?: StepResult[];
  onStepClick?: (stepId: string) => void;
}

/* ─── Status colors (hex) ─────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  pending: '#71717a', running: '#3b82f6', complete: '#22c55e',
  failed: '#ef4444', skipped: '#71717a', cancelled: '#71717a',
  reviewing: '#a855f7', waiting: '#f59e0b',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○', running: '◉', complete: '✓', failed: '✗',
  skipped: '—', cancelled: '⊘', reviewing: '🔍', waiting: '⏸',
};

/* ─── Helpers ─────────────────────────────────────────────────────── */

function elapsed(start: string, end?: string): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface NodePos { id: string; x: number; y: number; layer: number; }

/* ─── Layout ──────────────────────────────────────────────────────── */

function computeLayout(steps: StepDef[]): NodePos[] {
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const layers = new Map<string, number>();

  // Assign layers via topological ordering
  const assignLayer = (id: string, visited: Set<string>): number => {
    if (layers.has(id)) return layers.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const step = stepMap.get(id);
    if (!step?.needs?.length) { layers.set(id, 0); return 0; }
    let maxDep = 0;
    for (const dep of step.needs) {
      if (stepMap.has(dep)) {
        maxDep = Math.max(maxDep, assignLayer(dep, visited) + 1);
      }
    }
    layers.set(id, maxDep);
    return maxDep;
  };

  for (const s of steps) assignLayer(s.id, new Set());

  // Group by layer
  const byLayer = new Map<number, string[]>();
  for (const s of steps) {
    const l = layers.get(s.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s.id);
  }

  const NODE_W = 140;
  const NODE_H = 50;
  const H_GAP = 80;
  const V_GAP = 30;

  const positions: NodePos[] = [];
  const maxLayer = Math.max(0, ...byLayer.keys());

  for (let l = 0; l <= maxLayer; l++) {
    const ids = byLayer.get(l) || [];
    const colHeight = ids.length * NODE_H + (ids.length - 1) * V_GAP;
    const startY = -colHeight / 2;
    ids.forEach((id, i) => {
      positions.push({
        id,
        x: l * (NODE_W + H_GAP),
        y: startY + i * (NODE_H + V_GAP),
        layer: l,
      });
    });
  }

  return positions;
}

/* ─── SVG styles (keyframes injected once) ────────────────────────── */

const pulseKeyframes = `
@keyframes dag-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
`;

/* ─── Component ───────────────────────────────────────────────────── */

export default function WorkflowDAG({ steps, stepResults, onStepClick }: WorkflowDAGProps) {
  const [hoveredStep, setHoveredStep] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const resultMap = useMemo(() => {
    const m = new Map<string, StepResult>();
    if (stepResults) stepResults.forEach(r => m.set(r.id, r));
    return m;
  }, [stepResults]);

  const stepMap = useMemo(() => new Map(steps.map(s => [s.id, s])), [steps]);

  const positions = useMemo(() => computeLayout(steps), [steps]);
  const posMap = useMemo(() => new Map(positions.map(p => [p.id, p])), [positions]);

  const NODE_W = 140;
  const NODE_H = 50;
  const PADDING = 40;

  // Compute viewBox
  const bounds = useMemo(() => {
    if (positions.length === 0) return { minX: 0, minY: 0, w: 300, h: 200 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of positions) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + NODE_H);
    }
    return {
      minX: minX - PADDING,
      minY: minY - PADDING,
      w: maxX - minX + NODE_W + PADDING * 2,
      h: maxY - minY + NODE_H + PADDING * 2,
    };
  }, [positions]);

  // Build edges
  const edges = useMemo(() => {
    const result: { from: string; to: string }[] = [];
    for (const s of steps) {
      if (s.needs) {
        for (const dep of s.needs) {
          if (posMap.has(dep)) {
            result.push({ from: dep, to: s.id });
          }
        }
      }
    }
    return result;
  }, [steps, posMap]);

  const getStatus = (id: string) => resultMap.get(id)?.status ?? 'pending';

  // Build tooltip content
  const tooltipContent = useMemo(() => {
    if (!hoveredStep) return null;
    const step = stepMap.get(hoveredStep);
    const result = resultMap.get(hoveredStep);
    if (!step) return null;
    const status = result?.status ?? 'pending';
    const duration = result?.startedAt ? elapsed(result.startedAt, result.finishedAt) : null;
    const promptPreview = step.prompt ? step.prompt.slice(0, 100) + (step.prompt.length > 100 ? '…' : '') : null;
    return { name: step.name || step.id, status, duration, promptPreview };
  }, [hoveredStep, stepMap, resultMap]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <style>{pulseKeyframes}</style>
      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.w} ${bounds.h}`}
        style={{ width: '100%', height: 'auto', maxHeight: '400px', display: 'block' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Arrowhead marker defs */}
        <defs>
          {['pending', 'running', 'complete', 'failed', 'skipped', 'cancelled', 'reviewing', 'waiting'].map(st => (
            <marker
              key={st}
              id={`arrow-${st}`}
              viewBox="0 0 10 7"
              refX="10"
              refY="3.5"
              markerWidth="8"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 3.5 L 0 7 z" fill={STATUS_COLORS[st] || '#71717a'} />
            </marker>
          ))}
        </defs>

        {/* Edges */}
        {edges.map(({ from, to }) => {
          const fp = posMap.get(from)!;
          const tp = posMap.get(to)!;
          const srcStatus = getStatus(from);
          const edgeColor = srcStatus === 'pending' ? '#52525b' : (STATUS_COLORS[srcStatus] || '#52525b');

          const x1 = fp.x + NODE_W;
          const y1 = fp.y + NODE_H / 2;
          const x2 = tp.x;
          const y2 = tp.y + NODE_H / 2;

          const cx1 = x1 + (x2 - x1) * 0.4;
          const cx2 = x1 + (x2 - x1) * 0.6;

          return (
            <path
              key={`${from}-${to}`}
              d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={edgeColor}
              strokeWidth={2}
              strokeOpacity={srcStatus === 'pending' ? 0.4 : 0.8}
              markerEnd={`url(#arrow-${srcStatus})`}
              style={{ transition: 'stroke 0.4s ease, stroke-opacity 0.4s ease' }}
            />
          );
        })}

        {/* Nodes */}
        {positions.map(pos => {
          const status = getStatus(pos.id);
          const color = STATUS_COLORS[status] || '#71717a';
          const icon = STATUS_ICONS[status] || '○';
          const step = stepMap.get(pos.id);
          const label = step?.name || pos.id;
          const isRunning = status === 'running' || status === 'reviewing';
          const isFailed = status === 'failed';

          return (
            <g
              key={pos.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              style={{ cursor: onStepClick ? 'pointer' : 'default' }}
              onClick={() => onStepClick?.(pos.id)}
              onMouseEnter={(e) => {
                setHoveredStep(pos.id);
                const svg = (e.target as SVGElement).closest('svg');
                if (svg) {
                  const rect = svg.getBoundingClientRect();
                  const pt = svg.createSVGPoint();
                  pt.x = pos.x + NODE_W / 2;
                  pt.y = pos.y;
                  const ctm = svg.getScreenCTM();
                  if (ctm) {
                    const screenPt = pt.matrixTransform(ctm);
                    setTooltipPos({ x: screenPt.x - rect.left, y: screenPt.y - rect.top });
                  }
                }
              }}
              onMouseLeave={() => { setHoveredStep(null); setTooltipPos(null); }}
            >
              {/* Shadow for failed */}
              {isFailed && (
                <rect
                  x={2} y={3} rx={8} ry={8}
                  width={NODE_W} height={NODE_H}
                  fill="rgba(239, 68, 68, 0.2)"
                />
              )}

              {/* Background rect */}
              <rect
                rx={8} ry={8}
                width={NODE_W} height={NODE_H}
                fill="var(--color-bg-1, #1e1e2e)"
                stroke={color}
                strokeWidth={2.5}
                style={{
                  transition: 'fill 0.4s ease, stroke 0.4s ease',
                  animation: isRunning ? 'dag-pulse 2s ease-in-out infinite' : 'none',
                }}
              />

              {/* Status fill overlay */}
              <rect
                rx={8} ry={8}
                width={NODE_W} height={NODE_H}
                fill={color}
                opacity={status === 'complete' ? 0.1 : status === 'running' ? 0.08 : status === 'failed' ? 0.12 : 0.05}
                style={{ transition: 'fill 0.4s ease, opacity 0.4s ease', pointerEvents: 'none' }}
              />

              {/* Status icon */}
              <text
                x={14} y={NODE_H / 2 + 1}
                dominantBaseline="central"
                textAnchor="middle"
                fill={color}
                fontSize={14}
                style={{ transition: 'fill 0.4s ease' }}
              >
                {icon}
              </text>

              {/* Label */}
              <text
                x={28} y={NODE_H / 2 + 1}
                dominantBaseline="central"
                fill="var(--color-fg, #e4e4e7)"
                fontSize={11}
                fontFamily="system-ui, sans-serif"
                fontWeight={500}
                style={{ transition: 'fill 0.4s ease' }}
              >
                {label.length > 14 ? label.slice(0, 13) + '…' : label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredStep && tooltipContent && tooltipPos && (
        <div
          style={{
            position: 'absolute',
            left: tooltipPos.x,
            top: tooltipPos.y - 8,
            transform: 'translate(-50%, -100%)',
            background: 'var(--color-bg-2, #2a2a3e)',
            border: '1px solid var(--color-border, #3f3f46)',
            borderRadius: 8,
            padding: '8px 12px',
            maxWidth: 260,
            zIndex: 50,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-fg, #e4e4e7)', marginBottom: 4 }}>
            {tooltipContent.name}
          </div>
          <div style={{ fontSize: 11, color: STATUS_COLORS[tooltipContent.status] || '#71717a', marginBottom: 2 }}>
            {STATUS_ICONS[tooltipContent.status] || '○'} {tooltipContent.status}
            {tooltipContent.duration && (
              <span style={{ color: 'var(--color-fg-2, #a1a1aa)', marginLeft: 8 }}>{tooltipContent.duration}</span>
            )}
          </div>
          {tooltipContent.promptPreview && (
            <div style={{
              fontSize: 10,
              color: 'var(--color-fg-2, #a1a1aa)',
              marginTop: 4,
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {tooltipContent.promptPreview}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
