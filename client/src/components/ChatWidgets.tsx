/**
 * Shared chat widget components extracted from HeadlessChatPanel.
 * Used by HeadlessChatPanel (full panel) and Sessions page (rich view).
 */
import { useState, useEffect, useRef } from 'react';
import { formatDuration } from './ChatMarkdown';

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

export interface ToolCall {
  tool: string;
  name?: string;
  description?: string;
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

/** Thinking block — sleek animated accordion, auto-expands while streaming */
export function ThinkingBlock({ text, isStreaming, hasResponse }: { text: string; isStreaming: boolean; hasResponse: boolean }) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const wasStreaming = useRef(false);

  // Auto-expand while reasoning is actively streaming (no response yet).
  // Once response arrives, auto-collapse — unless user manually toggled.
  const autoExpanded = isStreaming && !hasResponse;
  useEffect(() => {
    if (autoExpanded) wasStreaming.current = true;
    if (wasStreaming.current && !autoExpanded && manualToggle === null) {
      // streaming just ended — auto-collapse
      wasStreaming.current = false;
    }
  }, [autoExpanded, manualToggle]);

  const expanded = manualToggle !== null ? manualToggle : autoExpanded;
  const charCount = text.length;

  return (
    <div className="mb-2">
      <button
        onClick={() => setManualToggle(prev => prev !== null ? !prev : !expanded)}
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
      <div className={`overflow-hidden transition-all duration-300 ease-out ${expanded ? 'max-h-[500px] opacity-100 mt-1.5' : 'max-h-0 opacity-0'}`}>
        <div className="text-[11px] text-fg-2/55 bg-violet-500/[0.03] rounded-lg p-3 border border-violet-500/[0.06] whitespace-pre-wrap font-mono leading-relaxed overflow-y-auto max-h-[480px]">
          {text}
          {isStreaming && !hasResponse && (
            <span className="inline-block w-[2px] h-3 bg-violet-400/60 ml-0.5 animate-pulse rounded-full align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline expandable tool call card with live timer — shows what the tool did */
export function InlineToolCall({ tool, compact }: { tool: ToolCall; compact?: boolean }) {
  const isRunning = tool.status === 'running';
  const [expanded, setExpanded] = useState(isRunning);
  const [now, setNow] = useState(Date.now());
  const hasDetails = !!(tool.input || tool.output);

  // Auto-expand while running, auto-collapse when done
  useEffect(() => {
    if (isRunning) setExpanded(true);
  }, [isRunning]);

  useEffect(() => {
    if (tool.status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [tool.status]);

  const elapsed = (tool.endTimestamp || (tool.status === 'running' ? now : Date.now())) - tool.timestamp;

  // Build a short summary of what the tool did from input
  const inputSummary = (() => {
    if (!tool.input) return tool.description || null;
    try {
      const parsed = typeof tool.input === 'string' ? JSON.parse(tool.input) : tool.input;
      if (parsed.command) return parsed.description || (typeof parsed.command === 'string' ? parsed.command.slice(0, 120) : null);
      if (parsed.pattern) return `/${parsed.pattern}/ ${parsed.path || parsed.glob || ''}`.trim();
      if (parsed.path && parsed.old_str) return `edit ${parsed.path}`;
      if (parsed.path) return parsed.path;
      if (parsed.query) return parsed.query.slice(0, 100);
      if (parsed.url) return parsed.url.slice(0, 100);
      if (parsed.prompt) return parsed.prompt.slice(0, 100);
      if (parsed.message) return parsed.message.slice(0, 100);
      if (tool.description) return tool.description;
      return null;
    } catch {
      return tool.description || (typeof tool.input === 'string' ? tool.input.slice(0, 100) : null);
    }
  })();

  // Build a short summary of the output
  const outputSummary = (() => {
    if (!tool.output) return null;
    const raw = typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output);
    const lines = raw.split('\n');
    if (lines.length > 3) return `${lines.length} lines`;
    return raw.slice(0, 80);
  })();

  return (
    <div
      className={`group/tool rounded-md transition-colors ${hasDetails ? 'cursor-pointer hover:bg-bg-3/30' : ''}`}
      style={{
        padding: compact ? '2px 6px' : '4px 8px',
        fontSize: compact ? '0.65rem' : '0.7rem',
        fontFamily: 'monospace',
      }}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      {/* Main row: status icon + tool name + summary + duration */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="flex-shrink-0" style={{ color: isRunning ? '#3b82f6' : '#22c55e', fontSize: compact ? '0.6rem' : '0.7rem' }}>
          {isRunning ? '⏳' : '✓'}
        </span>
        <span className="text-blue-400/80 flex-shrink-0 font-semibold">{tool.tool}</span>
        {inputSummary && (
          <span className="text-fg-2/50 truncate min-w-0 flex-1">{inputSummary}</span>
        )}
        <span className="ml-auto text-fg-2/30 flex-shrink-0 tabular-nums">
          {formatDuration(elapsed)}
        </span>
        {outputSummary && !expanded && (
          <span className="text-emerald-400/40 flex-shrink-0 max-w-[80px] truncate">{outputSummary}</span>
        )}
        {hasDetails && (
          <span className="text-fg-2/30 flex-shrink-0 text-[8px]">{expanded ? '▾' : '▸'}</span>
        )}
      </div>
      {/* Expanded details: full input + output */}
      {expanded && (
        <div className="mt-1.5 pt-1.5 border-t border-border/20 space-y-1.5">
          {tool.input && (
            <div className="text-fg-2/50 text-[10px] leading-relaxed whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto rounded bg-bg/50 px-2 py-1">
              <span className="text-fg-1/60 select-none">→ </span>
              {typeof tool.input === 'string' ? tool.input.slice(0, 1000) : JSON.stringify(tool.input, null, 2).slice(0, 1000)}
            </div>
          )}
          {tool.output && (
            <div className="text-fg-1/70 text-[10px] leading-relaxed whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto rounded bg-bg/50 px-2 py-1">
              <span className="text-emerald-400/60 select-none">← </span>
              {typeof tool.output === 'string' ? tool.output.slice(0, 2000) : JSON.stringify(tool.output, null, 2).slice(0, 2000)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tool timeline — vertical stack of inline tool cards */
export function ToolTimeline({ tools, compact }: { tools: ToolCall[]; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 my-1">
      {tools.map((t, i) => (
        <InlineToolCall key={`${t.tool}-${i}`} tool={t} compact={compact} />
      ))}
    </div>
  );
}
