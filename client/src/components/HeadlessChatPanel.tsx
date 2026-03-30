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
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[500px] max-w-[90vw] bg-bg-1 border-l border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">💬 Chat — {agentName}</span>
            <span className={`text-[8px] px-1.5 py-0.5 rounded font-mono ${
              connected ? 'bg-green/10 text-green' : 'bg-red/10 text-red'
            }`}>{connected ? '● live' : '● disconnected'}</span>
          </div>
          <button onClick={onClose} className="text-fg-2 hover:text-fg text-xs px-1">✕</button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
          {messages.length === 0 && (
            <div className="text-center text-fg-2 text-[11px] mt-8">
              <p>No messages yet.</p>
              <p className="mt-1 text-[10px]">Send a message or relay from another agent.</p>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
                m.role === 'user'
                  ? 'bg-blue/10 text-fg border border-blue/20'
                  : m.role === 'system'
                  ? 'bg-red/10 text-red border border-red/20'
                  : 'bg-bg-2 text-fg border border-border'
              }`}>
                {/* Sender label */}
                {m.from && m.from !== 'you' && (
                  <div className="text-[9px] text-fg-2 mb-1 font-mono">from: {m.from}</div>
                )}

                {/* Thinking toggle */}
                {m.thinking && (
                  <button
                    className="text-[9px] text-purple/70 hover:text-purple mb-1 flex items-center gap-1"
                    onClick={() => toggleThinking(m.id)}>
                    {showThinking[m.id] ? '▾' : '▸'} thinking
                    {m.tokens && <span className="text-fg-2 ml-1">({m.tokens} tokens)</span>}
                  </button>
                )}
                {showThinking[m.id] && m.thinking && (
                  <div className="text-[10px] text-fg-2 bg-bg rounded p-2 mb-2 border border-border whitespace-pre-wrap font-mono leading-relaxed max-h-[200px] overflow-y-auto">
                    {m.thinking}
                  </div>
                )}

                {/* Message content */}
                <div className="whitespace-pre-wrap break-words">
                  {m.text || (m.streaming && <span className="text-fg-2 italic">thinking…</span>)}
                </div>

                {/* Streaming indicator */}
                {m.streaming && m.text && (
                  <span className="inline-block w-1.5 h-3 bg-green/70 ml-0.5 animate-pulse rounded-sm" />
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
              className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-[11px] text-fg resize-none focus:outline-none focus:border-border-1 min-h-[36px] max-h-[120px]"
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
              className="px-3 py-2 rounded-lg text-[11px] font-medium bg-fg text-bg hover:opacity-90 disabled:opacity-40 flex-shrink-0"
              onClick={sendMessage}
              disabled={sending || !connected || !input.trim()}>
              {sending ? '⏳' : 'Send'}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] text-fg-2">Enter to send · Shift+Enter for newline</span>
            <span className="text-[9px] text-fg-2">⚡ headless via SDK</span>
          </div>
        </div>
      </div>
    </div>
  );
}
