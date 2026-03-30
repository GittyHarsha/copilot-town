import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface ToolCall {
  tool: string;
  status: 'running' | 'done';
  timestamp: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  thinking?: string;
  tokens?: number;
  timestamp: number;
  from?: string;
  streaming?: boolean;
  tools?: ToolCall[];
  intent?: string;
}

interface Props {
  agentName: string;
  onClose: () => void;
}

const WS_BASE = `ws://${window.location.host}/ws/headless`;

export default function HeadlessChatPanel({ agentName, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  const [liveIntent, setLiveIntent] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msgCounter = useRef(0);
  const streamBuf = useRef('');
  const thinkBuf = useRef('');
  const toolsBuf = useRef<ToolCall[]>([]);
  const activeStreamId = useRef<string | null>(null);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Load conversation history on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await api.getAgentMessages(agentName);
        if (!data?.messages) return;
        const history: ChatMessage[] = [];
        for (const m of data.messages) {
          if (m.type === 'user.message') {
            const text = m.prompt || m.content || m.text || '';
            // Skip completely empty user messages only if no matching assistant response follows
            if (!text) {
              history.push({
                id: m.id || `h-${msgCounter.current++}`,
                role: 'user',
                text: '(message not available)',
                from: 'you',
                timestamp: new Date(m.timestamp || 0).getTime(),
              });
              continue;
            }
            history.push({
              id: m.id || `h-${msgCounter.current++}`,
              role: 'user',
              text,
              from: text.startsWith('[Message from ') ? text.match(/\[Message from (.+?)\]/)?.[1] : 'you',
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          } else if (m.type === 'assistant.message') {
            history.push({
              id: m.id || `h-${msgCounter.current++}`,
              role: 'agent',
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

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const sid = activeStreamId.current;

        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          streamBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const text = streamBuf.current;
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, text, streaming: true } : m
            ));
          }
        } else if (msg.type === 'reasoning_delta') {
          thinkBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const thinking = thinkBuf.current;
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, thinking, streaming: true } : m
            ));
          }
        } else if (msg.type === 'tool_start') {
          toolsBuf.current = [...toolsBuf.current, { tool: msg.tool, status: 'running', timestamp: Date.now() }];
          if (sid) {
            const tools = [...toolsBuf.current];
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, tools } : m
            ));
          }
        } else if (msg.type === 'tool_complete') {
          toolsBuf.current = toolsBuf.current.map(t =>
            t.tool === msg.tool && t.status === 'running' ? { ...t, status: 'done' as const } : t
          );
          if (sid) {
            const tools = [...toolsBuf.current];
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, tools } : m
            ));
          }
        } else if (msg.type === 'intent') {
          setLiveIntent(msg.intent || null);
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, intent: msg.intent } : m
            ));
          }
        } else if (msg.type === 'response') {
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? {
                ...m,
                text: msg.content || streamBuf.current,
                thinking: msg.thinking || thinkBuf.current || undefined,
                tokens: msg.outputTokens,
                tools: toolsBuf.current.length > 0 ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const })) : undefined,
                streaming: false,
              } : m
            ));
          }
          activeStreamId.current = null;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setLiveIntent(null);
          setSending(false);
        } else if (msg.type === 'error') {
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, text: `Error: ${msg.message}`, streaming: false } : m
            ));
          } else {
            setMessages(prev => [...prev, {
              id: `err-${msgCounter.current++}`, role: 'system',
              text: `Error: ${msg.message}`, timestamp: Date.now(),
            }]);
          }
          activeStreamId.current = null;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setLiveIntent(null);
          setSending(false);
        }
      } catch {}
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [agentName]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const userId = `u-${msgCounter.current++}`;
    setMessages(prev => [...prev, { id: userId, role: 'user', text, from: 'you', timestamp: Date.now() }]);

    const agentId = `a-${msgCounter.current++}`;
    setMessages(prev => [...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]);

    activeStreamId.current = agentId;
    streamBuf.current = '';
    thinkBuf.current = '';
    toolsBuf.current = [];
    setSending(true);
    setInput('');

    wsRef.current.send(JSON.stringify({ prompt: text }));
  }, [input, sending]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-w-[90vw] bg-bg-1 border-l border-border/60 flex flex-col animate-slide-in-right"
        style={{ boxShadow: '-8px 0 40px rgba(0,0,0,0.4)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60 flex-shrink-0">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold tracking-tight">⚡ {agentName}</span>
              <span className={`badge ${
                connected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/15' : 'bg-red-500/10 text-red-400 border border-red-500/15'
              }`}>{connected ? '● live' : '● offline'}</span>
            </div>
            {liveIntent && (
              <span className="text-[10px] text-blue-400/70 truncate max-w-[300px]">📋 {liveIntent}</span>
            )}
          </div>
          <button onClick={onClose} className="text-fg-2 hover:text-fg text-sm px-2 py-1.5 rounded-lg hover:bg-bg-2 transition-all duration-150">✕</button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
          {messages.length === 0 && (
            <div className="text-center text-fg-2 text-xs mt-12">
              <span className="text-3xl block mb-3 opacity-20">⚡</span>
              <p>No messages yet.</p>
              <p className="mt-1 text-fg-2/50">Send a message or relay from another agent.</p>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'rounded-2xl rounded-br-md px-4 py-2.5 bg-blue-500/[0.08] text-fg border border-blue-500/[0.12]'
                  : m.role === 'system'
                  ? 'rounded-xl px-4 py-2.5 bg-red-500/[0.06] text-red-400 border border-red-500/[0.1]'
                  : 'space-y-0'
              }`}>
                {/* Relay sender */}
                {m.from && m.from !== 'you' && (
                  <div className="text-[10px] text-fg-2/50 mb-1 font-mono">↗ from {m.from}</div>
                )}

                {/* ── Agent message: structured sections ── */}
                {m.role === 'agent' ? (
                  <>
                    {/* Thinking block */}
                    {m.thinking && (
                      <div className="mb-1.5">
                        <button
                          className="flex items-center gap-1.5 text-[10px] text-violet-400/60 hover:text-violet-400 transition-colors group/think"
                          onClick={() => toggleThinking(m.id)}>
                          <span className="transition-transform duration-150" style={{ transform: expandedThinking.has(m.id) ? 'rotate(90deg)' : undefined }}>▸</span>
                          <span className="flex items-center gap-1">
                            💭 Thinking
                            {m.streaming && !m.text && <span className="w-1 h-1 rounded-full bg-violet-400/60 animate-pulse" />}
                          </span>
                          <span className="text-fg-2/30">{m.thinking.length > 200 ? `${Math.ceil(m.thinking.length / 4)} chars` : ''}</span>
                        </button>
                        {expandedThinking.has(m.id) && (
                          <div className="mt-1.5 text-[11px] text-fg-2/60 bg-violet-500/[0.04] rounded-xl p-3 border border-violet-500/[0.08] whitespace-pre-wrap font-mono leading-relaxed max-h-[250px] overflow-y-auto italic">
                            {m.thinking}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tool calls */}
                    {m.tools && m.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {m.tools.map((t, i) => (
                          <span key={`${t.tool}-${i}`} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg border font-mono ${
                            t.status === 'running'
                              ? 'bg-amber-500/[0.06] text-amber-400/80 border-amber-500/[0.12]'
                              : 'bg-emerald-500/[0.04] text-emerald-400/60 border-emerald-500/[0.08]'
                          }`}>
                            {t.status === 'running' ? <span className="spinner" style={{ width: 8, height: 8, borderWidth: 1 }} /> : <span>✓</span>}
                            {t.tool}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Response content */}
                    {(m.text || m.streaming) && (
                      <div className="rounded-2xl rounded-bl-md px-4 py-2.5 bg-bg-2/50 text-fg border border-border/60 whitespace-pre-wrap break-words">
                        {m.text || (m.streaming && !m.thinking && <span className="text-fg-2/40 italic">thinking…</span>)}
                        {m.streaming && m.text && (
                          <span className="inline-block w-1.5 h-3.5 bg-emerald-500/50 ml-0.5 animate-pulse rounded-sm align-text-bottom" />
                        )}
                      </div>
                    )}

                    {/* Intent indicator */}
                    {m.intent && m.streaming && (
                      <div className="text-[10px] text-blue-400/50 mt-1 px-1 truncate">📋 {m.intent}</div>
                    )}

                    {/* Footer: tokens */}
                    {!m.streaming && m.tokens && (
                      <div className="flex items-center gap-2 mt-1.5 px-1">
                        <span className="text-[10px] text-fg-2/30 tabular-nums">{m.tokens.toLocaleString()} tokens</span>
                      </div>
                    )}
                  </>
                ) : (
                  /* ── User / system message content ── */
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="border-t border-border/60 p-3.5 flex-shrink-0">
          {!connected && (
            <div className="text-[10px] text-amber-400/70 bg-amber-400/[0.05] rounded-lg px-3 py-1.5 mb-2 border border-amber-400/[0.08]">
              ⚠️ WebSocket not connected — messages won't send
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              className="flex-1 bg-bg border border-border rounded-xl px-3.5 py-2.5 text-xs text-fg resize-none focus:outline-none focus:border-blue-500/30 min-h-[40px] max-h-[120px] transition-colors placeholder-fg-2/30"
              placeholder={sending ? 'Waiting for response…' : 'Message this agent…'}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending || !connected}
              onInput={e => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 120) + 'px';
              }}
            />
            <button
              className="btn btn-primary flex-shrink-0 px-4"
              onClick={sendMessage}
              disabled={sending || !connected || !input.trim()}>
              {sending ? '⏳' : '↑ Send'}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-0.5">
            <span className="text-[10px] text-fg-2/25">Enter to send · Shift+Enter for newline</span>
            <span className="text-[10px] text-fg-2/25">⚡ headless via SDK</span>
          </div>
        </div>
      </div>
    </div>
  );
}
