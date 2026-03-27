import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

interface Props {
  agentName: string;
  onClose: () => void;
}

export default function ChatPanel({ agentName, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [lastOutput, setLastOutput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgCounter = useRef(0);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Focus input on open
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Poll agent terminal output for responses
  const pollOutput = useCallback(() => {
    api.getAgentOutput(agentName, 80).then(({ output }) => {
      if (output && output !== lastOutput) {
        setLastOutput(output);
        // Extract the new portion
        const newContent = lastOutput ? output.replace(lastOutput, '').trim() : output.trim();
        if (newContent) {
          setMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            // Update existing agent message if it was just created, otherwise add new
            if (lastMsg?.role === 'agent') {
              return [...prev.slice(0, -1), { ...lastMsg, text: output.slice(-2000) }];
            }
            return [...prev, {
              id: `agent-${++msgCounter.current}`,
              role: 'agent',
              text: output.slice(-2000),
              timestamp: Date.now(),
            }];
          });
        }
      }
    }).catch(() => {});
  }, [agentName, lastOutput]);

  useEffect(() => {
    pollRef.current = setInterval(pollOutput, 8000);
    // Initial fetch
    pollOutput();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollOutput]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setSending(true);

    setMessages(prev => [...prev, {
      id: `user-${++msgCounter.current}`,
      role: 'user',
      text,
      timestamp: Date.now(),
    }]);

    try {
      await api.sendMessage(agentName, text);
    } catch {
      setMessages(prev => [...prev, {
        id: `err-${++msgCounter.current}`,
        role: 'agent',
        text: '⚠ Failed to send message',
        timestamp: Date.now(),
      }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 z-50 h-full w-[400px] max-w-[90vw] bg-bg border-l border-border flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-3 h-10 border-b border-border bg-bg-1 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] text-fg-2">💬</span>
            <span className="text-xs font-medium truncate">{agentName}</span>
          </div>
          <button
            className="text-fg-2 hover:text-fg text-xs px-1.5 py-0.5 rounded hover:bg-bg-2"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] text-fg-2/50">Send a message to {agentName}</p>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${
                msg.role === 'user'
                  ? 'bg-blue/15 text-fg border border-blue/20'
                  : 'bg-bg-1 text-fg-1 border border-border'
              }`}>
                <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono">{msg.text}</pre>
                <span className="text-[9px] text-fg-2/40 mt-0.5 block">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="flex-shrink-0 border-t border-border bg-bg-1 p-2">
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              className="flex-1 bg-bg text-xs border border-border rounded px-2.5 py-2 text-fg placeholder-fg-2/40 focus:border-blue/40 outline-none"
              placeholder={`Message ${agentName}…`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              disabled={sending}
            />
            <button
              className="text-xs px-3 py-2 rounded bg-fg text-bg hover:opacity-90 disabled:opacity-30 font-medium flex-shrink-0"
              onClick={handleSend}
              disabled={sending || !input.trim()}
            >
              {sending ? '…' : '↗'}
            </button>
          </div>
          <p className="text-[9px] text-fg-2/30 mt-1 px-0.5">Uses psmux 3-step protocol · Esc to close</p>
        </div>
      </div>
    </>
  );
}
