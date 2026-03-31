import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api } from '../lib/api';
import { MarkdownContent, CopyButton, copyToClipboard, relativeTime, formatDuration } from './ChatMarkdown';

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

interface ToolCall {
  tool: string;
  status: 'running' | 'done';
  timestamp: number;
  endTimestamp?: number;
}

interface UsageInfo {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  duration?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  thinking?: string;
  tokens?: number;
  usage?: UsageInfo;
  timestamp: number;
  from?: string;
  streaming?: boolean;
  tools?: ToolCall[];
  intent?: string;
  action?: 'enqueue' | 'steer';
}

interface Props {
  agentName: string;
  onClose: () => void;
}

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */

const WS_BASE = `ws://${window.location.host}/ws/headless`;

/* ═══════════════════════════════════════════════════════════════════
   Sub-components (panel-specific)
   ═══════════════════════════════════════════════════════════════════ */

/** Thinking block — sleek animated accordion */
function ThinkingBlock({ text, isStreaming, hasResponse }: { text: string; isStreaming: boolean; hasResponse: boolean }) {
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

/** Tool timeline — vertical list with status dots and duration */
function ToolTimeline({ tools }: { tools: ToolCall[] }) {
  const now = Date.now();
  return (
    <div className="mb-2 pl-1">
      <div className="flex flex-col gap-0.5">
        {tools.map((t, i) => {
          const elapsed = (t.endTimestamp || now) - t.timestamp;
          return (
            <div key={`${t.tool}-${i}`} className="flex items-center gap-2 py-0.5 group/tool">
              {/* Status indicator */}
              <div className="flex-shrink-0 w-4 flex justify-center">
                {t.status === 'running' ? (
                  <span className="w-2 h-2 rounded-full bg-amber-400/80 animate-pulse" />
                ) : (
                  <svg className="w-3 h-3 text-emerald-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              {/* Tool name */}
              <span className={`text-[11px] font-mono truncate ${
                t.status === 'running' ? 'text-amber-400/80' : 'text-fg-2/50'
              }`}>{t.tool}</span>
              {/* Duration */}
              <span className="text-[10px] text-fg-2/25 tabular-nums ml-auto opacity-0 group-hover/tool:opacity-100 transition-opacity">
                {formatDuration(elapsed)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Empty state with quick suggestions */
function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  const suggestions = [
    { label: 'Status check', prompt: 'What are you currently working on?' },
    { label: 'Explore codebase', prompt: 'Give me an overview of this codebase' },
    { label: 'Run tests', prompt: 'Run the test suite and report results' },
    { label: 'Review changes', prompt: 'Review the current git diff' },
  ];
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-border/40 flex items-center justify-center mb-4">
        <span className="text-xl opacity-40">⚡</span>
      </div>
      <p className="text-sm text-fg/60 mb-1">Start a conversation</p>
      <p className="text-[11px] text-fg-2/40 mb-5 max-w-[280px]">Send a message, relay from another agent, or try a quick action below.</p>
      <div className="grid grid-cols-2 gap-2 w-full max-w-[320px]">
        {suggestions.map(s => (
          <button
            key={s.label}
            onClick={() => onSend(s.prompt)}
            className="text-[11px] text-left px-3 py-2 rounded-lg bg-bg-2/40 text-fg-2/60 hover:text-fg hover:bg-bg-2 border border-border/30 hover:border-border/50 transition-all"
          >{s.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════════ */

export default function HeadlessChatPanel({ agentName, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [liveIntent, setLiveIntent] = useState<string | null>(null);
  const [liveUsage, setLiveUsage] = useState<UsageInfo | null>(null);
  const [agentMode, setAgentMode] = useState<string>('plan');
  const [pendingPermission, setPendingPermission] = useState<{ id: string; tool: string; args?: any } | null>(null);
  const [hoveredMsg, setHoveredMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msgCounter = useRef(0);
  const streamBuf = useRef('');
  const thinkBuf = useRef('');
  const toolsBuf = useRef<ToolCall[]>([]);
  const activeStreamId = useRef<string | null>(null);
  const pendingSend = useRef<string | null>(null);

  /* ── Auto-scroll ── */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  /* ── Auto-focus input ── */
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  /* ── Escape to close (only when not typing) ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = document.activeElement?.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          (document.activeElement as HTMLElement).blur();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /* ── Load conversation history ── */
  useEffect(() => {
    (async () => {
      try {
        const data = await api.getAgentMessages(agentName);
        if (!data?.messages) return;
        const history: ChatMessage[] = [];
        for (const m of data.messages) {
          if (m.type === 'user.message') {
            const text = m.prompt || m.content || m.text || '';
            if (!text) {
              history.push({ id: m.id || `h-${msgCounter.current++}`, role: 'user', text: '(message not available)', from: 'you', timestamp: new Date(m.timestamp || 0).getTime() });
              continue;
            }
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'user', text,
              from: text.startsWith('[Message from ') ? text.match(/\[Message from (.+?)\]/)?.[1] : 'you',
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          } else if (m.type === 'assistant.message') {
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'agent',
              text: m.content || m.text || '',
              thinking: m.thinking || m.reasoningText || undefined,
              tokens: m.outputTokens,
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          }
        }
        setMessages(history);
      } catch {}
    })();
  }, [agentName]);

  /* ── WebSocket ── */
  const wireWs = useCallback((ws: WebSocket) => {
    ws.onopen = () => {
      setConnected(true);
      if (pendingSend.current) {
        const prompt = pendingSend.current;
        pendingSend.current = null;
        const agentId = `a-${msgCounter.current++}`;
        setMessages(prev => [...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]);
        activeStreamId.current = agentId;
        streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
        setSending(true);
        ws.send(JSON.stringify({ prompt }));
      }
    };
    ws.onclose = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const sid = activeStreamId.current;

        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          streamBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const text = streamBuf.current;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, text, streaming: true } : m));
          }
        } else if (msg.type === 'reasoning_delta') {
          thinkBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const thinking = thinkBuf.current;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, thinking, streaming: true } : m));
          }
        } else if (msg.type === 'tool_start') {
          toolsBuf.current = [...toolsBuf.current, { tool: msg.tool, status: 'running', timestamp: Date.now() }];
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'tool_complete') {
          toolsBuf.current = toolsBuf.current.map(t =>
            t.tool === msg.tool && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now() } : t
          );
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'intent') {
          setLiveIntent(msg.intent || null);
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, intent: msg.intent } : m));
        } else if (msg.type === 'usage') {
          const usage: UsageInfo = { model: msg.model, inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, cost: msg.cost, duration: msg.duration };
          setLiveUsage(usage);
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, usage, tokens: msg.outputTokens } : m));
        } else if (msg.type === 'subagent_start') {
          toolsBuf.current = [...toolsBuf.current, { tool: `🤖 ${msg.name || 'subagent'}`, status: 'running', timestamp: Date.now() }];
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'subagent_complete') {
          toolsBuf.current = toolsBuf.current.map(t =>
            t.tool === `🤖 ${msg.name}` && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now() } : t
          );
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'response') {
          if (sid) {
            setMessages(prev => prev.map(m => m.id === sid ? {
              ...m,
              text: msg.content || streamBuf.current,
              thinking: msg.thinking || thinkBuf.current || undefined,
              tokens: msg.outputTokens,
              tools: toolsBuf.current.length > 0 ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() })) : undefined,
              streaming: false,
            } : m));
          }
          activeStreamId.current = null;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setLiveIntent(null);
          setLiveUsage(null);
          setSending(false);
        } else if (msg.type === 'aborted') {
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: m.text || '(aborted)', streaming: false } : m));
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false);
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '⏹ Response aborted', timestamp: Date.now() }]);
        } else if (msg.type === 'enqueued') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '📋 Queued — runs when idle', timestamp: Date.now() }]);
        } else if (msg.type === 'steered') {
          // User message already added
        } else if (msg.type === 'compacted') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '🗜️ Context compacted', timestamp: Date.now() }]);
        } else if (msg.type === 'mode_changed') {
          const m = msg.mode ?? msg.data?.mode;
          if (m) {
            setAgentMode(m);
            setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: `Mode → ${m}`, timestamp: Date.now() }]);
          }
        } else if (msg.type === 'permission_request') {
          setPendingPermission({ id: msg.requestId, tool: msg.tool, args: msg.args });
        } else if (msg.type === 'error') {
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: `Error: ${msg.message}`, streaming: false } : m));
          else setMessages(prev => [...prev, { id: `err-${msgCounter.current++}`, role: 'system', text: `⚠ ${msg.message}`, timestamp: Date.now() }]);
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setSending(false);
        } else if (msg.type === 'turn_end') {
          // Finalize stream if server sends turn_end instead of response
          if (sid && streamBuf.current) {
            const text = streamBuf.current;
            const thinking = thinkBuf.current || undefined;
            const tools = toolsBuf.current.length > 0
              ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() }))
              : undefined;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, text, thinking, tools, streaming: false } : m));
          } else if (sid) {
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, streaming: false } : m));
          }
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false);
        } else if (msg.type === 'user_message') {
          const prompt = msg.prompt || '';
          const from = prompt.startsWith('[Message from ') ? prompt.match(/\[Message from (.+?)\]/)?.[1] : undefined;
          setMessages(prev => [...prev, { id: `ext-${msgCounter.current++}`, role: 'user', text: prompt, from: from || 'external', timestamp: Date.now() }]);
        }
      } catch {}
    };
  }, [agentName]);

  // Auto-connect on mount
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    wireWs(ws);
    return () => { ws.close(); wsRef.current = null; };
  }, [agentName, wireWs]);

  const ensureWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    wireWs(ws);
    return ws;
  }, [agentName, wireWs]);

  /* ── Actions ── */
  const sendMessage = useCallback((action?: 'enqueue' | 'steer', textOverride?: string) => {
    const text = (textOverride || input).trim();
    if (!text) return;

    const userId = `u-${msgCounter.current++}`;
    const userMsg: ChatMessage = { id: userId, role: 'user', text, from: 'you', timestamp: Date.now() };
    if (action) userMsg.action = action;
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    const ws = wsRef.current;
    const isOpen = ws && ws.readyState === WebSocket.OPEN;

    if (action === 'enqueue') {
      if (isOpen) ws.send(JSON.stringify({ action: 'enqueue', prompt: text }));
      return;
    }
    if (action === 'steer') {
      activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      const agentId = `a-${msgCounter.current++}`;
      setMessages(prev => [...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]);
      activeStreamId.current = agentId;
      if (isOpen) ws!.send(JSON.stringify({ action: 'steer', prompt: text }));
      else { pendingSend.current = text; ensureWs(); }
      return;
    }

    if (sending) return;
    if (isOpen) {
      const agentId = `a-${msgCounter.current++}`;
      setMessages(prev => [...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]);
      activeStreamId.current = agentId;
      streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      setSending(true);
      ws!.send(JSON.stringify({ prompt: text }));
    } else {
      pendingSend.current = text;
      ensureWs();
    }
  }, [input, sending, ensureWs]);

  const abortAgent = useCallback(() => {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ action: 'abort' }));
  }, []);

  const compactAgent = useCallback(() => {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ action: 'compact' }));
  }, []);

  const changeMode = useCallback(async (mode: string) => {
    try {
      await api.setAgentMode(agentName, mode);
      setAgentMode(mode);
    } catch (e: any) {
      setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: `Failed: ${e.message}`, timestamp: Date.now() }]);
    }
  }, [agentName]);

  const respondPermission = useCallback((approved: boolean) => {
    if (!pendingPermission || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ action: 'permission_response', requestId: pendingPermission.id, approved }));
    setPendingPermission(null);
  }, [pendingPermission]);

  useEffect(() => {
    api.getAgentMode(agentName).then(r => {
      const mode = r.mode || 'plan';
      setAgentMode(mode === 'interactive' ? 'plan' : mode);
    }).catch(() => {});
  }, [agentName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'q' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (input.trim()) sendMessage('enqueue');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (sending) { if (input.trim()) sendMessage('steer'); }
      else sendMessage();
    }
  };

  /* ═══════════════════════════════════════════════════════════════════
     Render
     ═══════════════════════════════════════════════════════════════════ */

  return (
    <div className="h-full bg-bg-1 border-l border-border/50 flex flex-col">

      {/* ── Header ── */}
        <div className="flex-shrink-0 border-b border-border/40">
          {/* Top row: agent name + close */}
          <div className="flex items-center justify-between px-5 pt-3.5 pb-2">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full flex-shrink-0 dot-live"
                style={{ background: connected ? '#4ade80' : '#f87171' }} />
              <span className="text-sm font-semibold tracking-tight text-fg">{agentName}</span>
            </div>
            <button onClick={onClose}
              className="text-fg-2/40 hover:text-fg w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-2 transition-all">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {/* Toolbar row: mode + controls */}
          <div className="flex items-center justify-between px-5 pb-2.5">
            <div className="flex items-center gap-2">
              {/* Mode segmented control — no "interactive" */}
              <div className="flex items-center bg-bg-2/60 rounded-lg border border-border/30 p-0.5">
                {(['plan', 'autopilot'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => changeMode(m)}
                    disabled={!connected}
                    className={`text-[10px] px-2.5 py-1 rounded-md transition-all font-medium ${
                      agentMode === m
                        ? 'bg-bg-3 text-fg shadow-sm border border-border/40'
                        : 'text-fg-2/50 hover:text-fg-2 border border-transparent'
                    } disabled:opacity-30`}
                  >{m}</button>
                ))}
              </div>
              {/* Live intent */}
              {liveIntent && (
                <span className="text-[10px] text-blue-400/60 truncate max-w-[180px] flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-blue-400/50 animate-pulse flex-shrink-0" />
                  {liveIntent}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {sending && (
                <button onClick={abortAgent}
                  className="text-[10px] px-2.5 py-1 rounded-lg bg-red-500/8 text-red-400 hover:bg-red-500/15 border border-red-500/12 transition-all font-medium">
                  ⏹ Abort
                </button>
              )}
              <button onClick={compactAgent}
                className="text-fg-2/30 hover:text-fg-2 text-[11px] w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-2 transition-all" title="Compact context">
                🗜️
              </button>
            </div>
          </div>
        </div>

        {/* ── Messages ── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {messages.length === 0 ? (
            <EmptyState onSend={(text) => sendMessage(undefined, text)} />
          ) : (
            <div className="px-5 py-4 space-y-4">
              {messages.map(m => {
                const isHovered = hoveredMsg === m.id;

                /* ── System message ── */
                if (m.role === 'system') {
                  return (
                    <div key={m.id} className="flex justify-center animate-fade-in">
                      <span className="text-[10px] text-fg-2/40 bg-bg-2/30 px-3 py-1 rounded-full border border-border/20">
                        {m.text}
                      </span>
                    </div>
                  );
                }

                /* ── User message ── */
                if (m.role === 'user') {
                  return (
                    <div key={m.id} className="flex justify-end animate-fade-in"
                      onMouseEnter={() => setHoveredMsg(m.id)} onMouseLeave={() => setHoveredMsg(null)}>
                      <div className="max-w-[85%] relative group/user">
                        {/* Relay sender */}
                        {m.from && m.from !== 'you' && (
                          <div className="text-[10px] text-fg-2/40 mb-1 text-right">
                            ↗ from <span className="text-blue-400/60 font-medium">{m.from}</span>
                          </div>
                        )}
                        {/* Action badge */}
                        {m.action && (
                          <div className="flex justify-end mb-1">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${
                              m.action === 'enqueue' ? 'bg-amber-500/8 text-amber-400/60 border border-amber-500/10' : 'bg-cyan-500/8 text-cyan-400/60 border border-cyan-500/10'
                            }`}>{m.action === 'enqueue' ? '📋 queued' : '↯ steer'}</span>
                          </div>
                        )}
                        <div className="rounded-2xl rounded-br-sm px-4 py-2.5 bg-blue-500/[0.07] text-fg text-[13px] leading-relaxed border border-blue-500/[0.1] whitespace-pre-wrap break-words">
                          {m.text}
                        </div>
                        {/* Hover actions + timestamp */}
                        <div className={`flex items-center justify-end gap-2 mt-1 transition-opacity duration-150 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                          <span className="text-[10px] text-fg-2/25 tabular-nums">{relativeTime(m.timestamp)}</span>
                          <CopyButton text={m.text} />
                        </div>
                      </div>
                    </div>
                  );
                }

                /* ── Agent message (full-width) ── */
                return (
                  <div key={m.id} className="animate-fade-in"
                    onMouseEnter={() => setHoveredMsg(m.id)} onMouseLeave={() => setHoveredMsg(null)}>
                    {/* Thinking */}
                    {m.thinking && (
                      <ThinkingBlock text={m.thinking} isStreaming={!!m.streaming} hasResponse={!!m.text} />
                    )}

                    {/* Tool timeline */}
                    {m.tools && m.tools.length > 0 && <ToolTimeline tools={m.tools} />}

                    {/* Response content — full-width markdown */}
                    {(m.text || m.streaming) && (
                      <div className="text-[13px] leading-relaxed text-fg/90">
                        {m.text ? (
                          <>
                            <MarkdownContent content={m.text} />
                            {m.streaming && (
                              <span className="inline-block w-[2px] h-4 bg-blue-400/60 ml-0.5 animate-pulse rounded-full align-text-bottom" />
                            )}
                          </>
                        ) : (
                          m.streaming && !m.thinking && (
                            <div className="flex items-center gap-2 py-2">
                              <div className="flex gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '300ms' }} />
                              </div>
                              <span className="text-[11px] text-fg-2/30">Thinking…</span>
                            </div>
                          )
                        )}
                      </div>
                    )}

                    {/* Intent while streaming */}
                    {m.intent && m.streaming && (
                      <div className="text-[10px] text-blue-400/40 mt-1 flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-blue-400/40 animate-pulse" />
                        {m.intent}
                      </div>
                    )}

                    {/* Footer: usage/tokens + actions */}
                    {!m.streaming && (m.tokens || m.usage || isHovered) && (
                      <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                        {m.usage?.model && <span className="text-fg-2/25">{m.usage.model}</span>}
                        {m.tokens && <span className="text-fg-2/20 tabular-nums">{m.tokens.toLocaleString()} out</span>}
                        {m.usage?.inputTokens && <span className="text-fg-2/20 tabular-nums">{m.usage.inputTokens.toLocaleString()} in</span>}
                        {m.usage?.duration && <span className="text-fg-2/20 tabular-nums">{(m.usage.duration / 1000).toFixed(1)}s</span>}
                        <div className={`ml-auto flex items-center gap-1.5 transition-opacity duration-150 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                          <span className="text-fg-2/20 tabular-nums">{relativeTime(m.timestamp)}</span>
                          <CopyButton text={m.text} />
                        </div>
                      </div>
                    )}

                    {/* Separator between agent messages */}
                    <div className="border-b border-border/20 mt-4" />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Permission request ── */}
        {pendingPermission && (
          <div className="border-t border-amber-500/15 bg-amber-500/[0.03] px-5 py-3 flex items-center gap-3 flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
              <span className="text-sm">🔐</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-fg">Permission required</div>
              <div className="text-[11px] text-fg-2 font-mono truncate mt-0.5">{pendingPermission.tool}</div>
              {pendingPermission.args && (
                <div className="text-[10px] text-fg-2/40 truncate mt-0.5 font-mono">{JSON.stringify(pendingPermission.args).slice(0, 100)}</div>
              )}
            </div>
            <button onClick={() => respondPermission(true)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/15 transition-all font-medium">
              Allow
            </button>
            <button onClick={() => respondPermission(false)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg hover:bg-bg-2 border border-border/40 transition-all font-medium">
              Deny
            </button>
          </div>
        )}

        {/* ── Input ── */}
        <div className="border-t border-border/40 p-4 flex-shrink-0 bg-bg-1">
          {!connected && (
            <div className="text-[11px] text-amber-400/60 bg-amber-400/[0.04] rounded-lg px-3 py-2 mb-2.5 border border-amber-400/[0.08] flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
              Not connected — reconnecting…
            </div>
          )}
          <div className="flex items-end gap-2.5">
            <textarea
              ref={inputRef}
              className="flex-1 bg-bg-2/40 border border-border/40 rounded-xl px-4 py-3 text-[13px] text-fg resize-none focus:outline-none focus:border-blue-500/25 focus:bg-bg-2/60 min-h-[44px] max-h-[140px] transition-all placeholder-fg-2/25"
              placeholder={sending ? 'Type to steer or Ctrl+Q to queue…' : `Message ${agentName}…`}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={e => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 140) + 'px';
              }}
            />
            <button
              className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
                sending
                  ? input.trim()
                    ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/20'
                    : 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/15'
                  : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/15'
              } disabled:opacity-20`}
              onClick={() => sending ? (input.trim() ? sendMessage('steer') : abortAgent()) : sendMessage()}
              disabled={!input.trim() && !sending}
              title={sending ? (input.trim() ? 'Steer (redirect agent)' : 'Stop') : 'Send'}
            >
              {sending ? (
                input.trim() ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M13 5l7 7-7 7M5 12h14" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                )
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M5 12h14M12 5l7 7-7 7" /></svg>
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-2 px-1">
            <span className="text-[10px] text-fg-2/20">
              {sending ? '⏎ steer · ⌃Q queue · click ■ abort' : '⏎ send · ⇧⏎ newline · ⌃Q queue'}
            </span>
            {liveUsage?.model && (
              <span className="text-[10px] text-fg-2/20">{liveUsage.model}</span>
            )}
          </div>
        </div>
      </div>
  );
}
