import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  thinking?: string;
  tokens?: number;
  timestamp: number;
  from?: string;
  streaming?: boolean;
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
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const msgCounter = useRef(0);
  const streamBuf = useRef('');
  const thinkBuf = useRef('');
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
            const text = m.content || m.text || '';
            if (!text) continue;
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
              thinking: m.reasoningText || m.thinking || undefined,
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

        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          // Live streaming token
          streamBuf.current += msg.content || msg.deltaContent || '';
          const sid = activeStreamId.current;
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, text: streamBuf.current, streaming: true } : m
            ));
          }
        } else if (msg.type === 'reasoning_delta') {
          thinkBuf.current += msg.content || msg.deltaContent || '';
          const sid = activeStreamId.current;
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? { ...m, thinking: thinkBuf.current, streaming: true } : m
            ));
          }
        } else if (msg.type === 'response') {
          // Final response — replace streaming message
          const sid = activeStreamId.current;
          if (sid) {
            setMessages(prev => prev.map(m =>
              m.id === sid ? {
                ...m,
                text: msg.content || streamBuf.current,
                thinking: msg.thinking || thinkBuf.current || undefined,
                tokens: msg.outputTokens,
                streaming: false,
              } : m
            ));
          }
          activeStreamId.current = null;
          streamBuf.current = '';
          thinkBuf.current = '';
          setSending(false);
        } else if (msg.type === 'error') {
          const sid = activeStreamId.current;
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
          setSending(false);
        }
      } catch {}
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [agentName]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Add user message
    const userId = `u-${msgCounter.current++}`;
    setMessages(prev => [...prev, { id: userId, role: 'user', text, from: 'you', timestamp: Date.now() }]);

    // Add placeholder for agent response
    const agentId = `a-${msgCounter.current++}`;
    setMessages(prev => [...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]);

    activeStreamId.current = agentId;
    streamBuf.current = '';
    thinkBuf.current = '';
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
    setShowThinking(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[520px] max-w-[90vw] bg-bg-1 border-l border-border/60 flex flex-col animate-slide-in-right"
        style={{ boxShadow: '-8px 0 40px rgba(0,0,0,0.4)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold tracking-tight">⚡ {agentName}</span>
            <span className={`badge ${
              connected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/15' : 'bg-red-500/10 text-red-400 border border-red-500/15'
            }`}>{connected ? '● live' : '● offline'}</span>
          </div>
          <button onClick={onClose} className="text-fg-2 hover:text-fg text-sm px-2 py-1.5 rounded-lg hover:bg-bg-2 transition-all duration-150">✕</button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          {messages.length === 0 && (
            <div className="text-center text-fg-2 text-xs mt-12">
              <span className="text-3xl block mb-3 opacity-20">⚡</span>
              <p>No messages yet.</p>
              <p className="mt-1 text-fg-2/50">Send a message or relay from another agent.</p>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-blue-500/8 text-fg border border-blue-500/15'
                  : m.role === 'system'
                  ? 'bg-red-500/8 text-red-400 border border-red-500/15'
                  : 'bg-bg-2/60 text-fg border border-border'
              }`}>
                {m.from && m.from !== 'you' && (
                  <div className="text-[10px] text-fg-2/60 mb-1 font-mono">from: {m.from}</div>
                )}

                {m.thinking && (
                  <button
                    className="text-[10px] text-violet-400/70 hover:text-violet-400 mb-1 flex items-center gap-1 transition-colors"
                    onClick={() => toggleThinking(m.id)}>
                    {showThinking[m.id] ? '▾' : '▸'} thinking
                    {m.tokens && <span className="text-fg-2/50 ml-1">({m.tokens} tok)</span>}
                  </button>
                )}
                {showThinking[m.id] && m.thinking && (
                  <div className="text-[11px] text-fg-2/70 bg-bg/60 rounded-lg p-2.5 mb-2 border border-border whitespace-pre-wrap font-mono leading-relaxed max-h-[200px] overflow-y-auto">
                    {m.thinking}
                  </div>
                )}

                {/* Message content */}
                <div className="whitespace-pre-wrap break-words">
                  {m.text || (m.streaming && <span className="text-fg-2/50 italic">thinking…</span>)}
                </div>

                {m.streaming && m.text && (
                  <span className="inline-block w-1.5 h-3 bg-emerald-500/60 ml-0.5 animate-pulse rounded-sm" />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="border-t border-border p-3 flex-shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              className="flex-1 bg-bg border border-border rounded-lg px-3 py-2.5 text-xs text-fg resize-none focus:outline-none focus:border-blue-500/40 min-h-[40px] max-h-[120px] transition-colors"
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
              className="btn btn-primary flex-shrink-0"
              onClick={sendMessage}
              disabled={sending || !connected || !input.trim()}>
              {sending ? '⏳' : 'Send'}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-fg-2/30">Enter to send · Shift+Enter for newline</span>
            <span className="text-[10px] text-fg-2/30">⚡ headless via SDK</span>
          </div>
        </div>
      </div>
    </div>
  );
}
