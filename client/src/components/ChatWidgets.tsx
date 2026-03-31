/**
 * Shared chat widget components extracted from HeadlessChatPanel.
 * Used by HeadlessChatPanel (full panel) and Sessions page (rich view).
 */
import { useState } from 'react';
import { formatDuration } from './ChatMarkdown';

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

export interface ToolCall {
  tool: string;
  status: 'running' | 'done';
  timestamp: number;
  endTimestamp?: number;
  input?: string;
  output?: string;
}

export interface UsageInfo {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  duration?: number;
}

/* ═══════════════════════════════════════════════════════════════════
   Components
   ═══════════════════════════════════════════════════════════════════ */

/** Thinking block — sleek animated accordion */
export function ThinkingBlock({ text, isStreaming, hasResponse }: { text: string; isStreaming: boolean; hasResponse: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const charCount = text.length;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left group/think"
      >
        <div className="flex items-center gap-1.5 text-[11px]">
          <svg
            className={`w-3 h-3 text-violet-400/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          ><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          <span className="text-violet-400/70 group-hover/think:text-violet-400 transition-colors font-medium">
            Reasoning
          </span>
          {isStreaming && !hasResponse && (
            <span className="flex gap-0.5 ml-1">
              <span className="w-1 h-1 rounded-full bg-violet-400/60 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400/60 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400/60 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
        </div>
        <span className="text-[10px] text-fg-2/25 tabular-nums">
          {charCount > 100 && `${(charCount / 1000).toFixed(1)}k chars`}
        </span>
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-out ${expanded ? 'max-h-[400px] opacity-100 mt-1.5' : 'max-h-0 opacity-0'}`}>
        <div className="text-[11px] text-fg-2/55 bg-violet-500/[0.03] rounded-lg p-3 border border-violet-500/[0.06] whitespace-pre-wrap font-mono leading-relaxed overflow-y-auto max-h-[380px]">
          {text}
        </div>
      </div>
    </div>
  );
}

/** Inline expandable tool call card */
export function InlineToolCall({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const now = Date.now();
  const elapsed = (tool.endTimestamp || now) - tool.timestamp;
  const hasDetails = !!(tool.input || tool.output);

  return (
    <div
      style={{
        background: 'transparent',
        border: '1px solid var(--color-border-1)',
        borderRadius: 'var(--shape-md)',
        padding: '4px 8px',
        fontSize: '0.75rem',
        fontFamily: 'monospace',
        cursor: hasDetails ? 'pointer' : 'default',
      }}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: tool.status === 'done' ? '#22c55e' : '#3b82f6' }}>
          {tool.status === 'done' ? '✓' : '⏳'}
        </span>
        <span style={{ color: '#60a5fa' }}>{tool.tool}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-fg-2)', fontSize: '0.7rem' }}>
          {formatDuration(elapsed)}
        </span>
        {hasDetails && (
          <span style={{ color: 'var(--color-fg-2)' }}>{expanded ? '▾' : '▸'}</span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--color-border)' }}>
          {tool.input && (
            <div style={{ color: 'var(--color-fg-2)', marginBottom: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 100, overflow: 'auto' }}>
              <span style={{ color: 'var(--color-fg-1)' }}>→ </span>
              {typeof tool.input === 'string' ? tool.input.slice(0, 300) : JSON.stringify(tool.input).slice(0, 300)}
            </div>
          )}
          {tool.output && (
            <div style={{ color: 'var(--color-fg-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 150, overflow: 'auto' }}>
              <span style={{ color: '#22c55e' }}>← </span>
              {typeof tool.output === 'string' ? tool.output.slice(0, 500) : JSON.stringify(tool.output).slice(0, 500)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tool timeline — vertical stack of inline tool cards */
export function ToolTimeline({ tools }: { tools: ToolCall[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0' }}>
      {tools.map((t, i) => (
        <InlineToolCall key={`${t.tool}-${i}`} tool={t} />
      ))}
    </div>
  );
}
