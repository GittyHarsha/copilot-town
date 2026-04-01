import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api, type AgentData } from '../lib/api';
import { MiniMarkdownContent, CopyButton, relativeTime } from '../components/ChatMarkdown';
import { useHeadlessChat, type ChatMessage } from '../hooks/useHeadlessChat';

/* ─── MiniChat — compact agent panel for grid ────────────────────── */

const MiniChat = memo(function MiniChat({
  agent, onExpand, displayAgents,
  relayTarget, setRelayTarget, relayTo, setRelayTo, relayInput, setRelayInput,
}: {
  agent: AgentData;
  onExpand: () => void;
  displayAgents?: AgentData[];
  relayTarget?: string | null;
  setRelayTarget?: (name: string | null) => void;
  relayTo?: string;
  setRelayTo?: (name: string) => void;
  relayInput?: string;
  setRelayInput?: (value: string) => void;
}) {
  const isAlive = agent.status === 'running' || agent.status === 'idle';
  const chat = useHeadlessChat(isAlive ? agent.name : null, { maxMessages: 60 });
  const { messages, connected, sending, liveIntent } = chat;

  const [input, setInput] = useState('');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derive compact status from last streaming message
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const isStreaming = lastMsg?.streaming ?? false;
  const streamingText = isStreaming ? lastMsg!.text : '';
  const isThinking = isStreaming && !!lastMsg?.thinking && !lastMsg?.text;
  const activeTools = isStreaming && lastMsg?.tools ? lastMsg.tools : [];
  const activeTool = activeTools.find(t => t.status === 'running')?.name ?? null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    chat.send(text, sending ? 'steer' : undefined);
    setInput('');
  }, [input, sending, chat]);

  const borderClass = sending
    ? 'border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.08)]'
    : connected
      ? 'border-border-1'
      : 'border-border';

  const lastMessages = messages.slice(-30);

  return (
    <div className={`flex flex-col border overflow-hidden bg-bg-1 ${borderClass} min-h-0`} style={{ height: '100%', borderRadius: 'var(--shape-lg)', transition: 'all var(--duration-medium) var(--ease-standard)' }}>
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-2/40 flex-shrink-0 relative">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          sending ? 'bg-blue-500 animate-pulse'
          : isAlive ? 'bg-emerald-500 dot-live'
          : 'bg-fg-2/30'
        }`} />
        <span className="text-[11px] font-semibold truncate flex-1 tracking-tight">{agent.name}</span>

        {/* Live status indicators */}
        {isThinking && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </span>
        )}
        {activeTool && !isThinking && (
          <span className="text-[9px] text-amber-400/80 truncate max-w-[100px] flex-shrink-0 font-mono">
            {activeTool}
          </span>
        )}
        {liveIntent && !isThinking && !activeTool && (
          <span className="text-[9px] text-blue-400/60 truncate max-w-[120px] flex-shrink-0">{liveIntent}</span>
        )}

        {/* Relay button */}
        {setRelayTarget && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRelayTarget(relayTarget === agent.name ? null : agent.name);
              setRelayTo?.('');
              setRelayInput?.('');
            }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: relayTarget === agent.name ? '#3b82f6' : 'var(--color-fg-2)',
              fontSize: '0.8rem', padding: '0 2px',
            }}
            title="Send relay message"
            aria-label={`Relay from ${agent.name}`}
          >
            📤
          </button>
        )}

        <button
          onClick={onExpand}
          className="text-fg-2/40 hover:text-fg text-xs transition-colors flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-bg-3/60"
          title="Open full panel"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>

        {/* Relay popup */}
        {relayTarget === agent.name && displayAgents && setRelayTo && setRelayInput && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 30,
            background: 'var(--color-bg-1)', border: '1px solid var(--color-border-1)',
            borderRadius: 8, padding: 8, width: 220,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-fg-2)', marginBottom: 6 }}>
              Relay from {agent.name} to:
            </div>
            <select
              style={{
                width: '100%', padding: '4px 6px', marginBottom: 6,
                background: 'var(--color-bg-2)', color: 'var(--color-fg)',
                border: '1px solid var(--color-border)', borderRadius: 4, fontSize: '0.8rem',
              }}
              value={relayTo}
              onChange={(e) => setRelayTo(e.target.value)}
            >
              <option value="">Select agent...</option>
              {displayAgents.filter(a => a.name !== agent.name).map(a => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type="text"
                value={relayInput}
                onChange={(e) => setRelayInput(e.target.value)}
                placeholder="Message..."
                style={{
                  flex: 1, padding: '4px 6px', fontSize: '0.8rem',
                  background: 'var(--color-bg-2)', color: 'var(--color-fg)',
                  border: '1px solid var(--color-border)', borderRadius: 4,
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && relayTo && relayInput?.trim()) {
                    api.relayMessage(agent.name, relayTo, relayInput.trim());
                    setRelayInput('');
                    setRelayTarget?.(null);
                  }
                  if (e.key === 'Escape') setRelayTarget?.(null);
                }}
              />
              <button
                className="btn"
                style={{ fontSize: '0.75rem', padding: '4px 8px' }}
                disabled={!relayTo || !relayInput?.trim()}
                onClick={() => {
                  if (relayTo && relayInput?.trim()) {
                    api.relayMessage(agent.name, relayTo, relayInput.trim());
                    setRelayInput('');
                    setRelayTarget?.(null);
                  }
                }}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2.5 py-2 space-y-3 min-h-0">
        {lastMessages.map((msg, i) => (
          <div
            key={msg.id}
            className="group/msg"
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {msg.role === 'user' ? (
              /* ── User message: right-aligned bubble ── */
              <div className="flex justify-end">
                <div className="max-w-[88%] px-3 py-2 bg-blue-500/[0.07] border border-blue-500/[0.1] text-[11px] text-fg leading-relaxed whitespace-pre-wrap break-words"
                  style={{ borderRadius: '16px 16px 4px 16px' }}>
                  {msg.text}
                </div>
              </div>
            ) : (
              /* ── Agent message: full-width with markdown ── */
              <div className="text-fg-1 px-3 py-2" style={{ borderRadius: '16px 16px 16px 4px' }}>
                {/* Tool pills */}
                {msg.tools && msg.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {msg.tools.map((t, j) => (
                      <span key={j} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-2/60 text-fg-2/50 border border-border/30 font-mono">
                        {t.status === 'done' ? '✓' : '⟳'} {t.tool}
                      </span>
                    ))}
                  </div>
                )}
                <MiniMarkdownContent content={msg.text} />
              </div>
            )}

            {/* Hover: timestamp + copy */}
            {hoveredIdx === i && (
              <div className={`flex items-center gap-1.5 mt-0.5 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                <span className="text-[9px] text-fg-2/25 tabular-nums">{relativeTime(msg.timestamp)}</span>
                <CopyButton text={msg.text} size="small" />
              </div>
            )}
          </div>
        ))}

        {/* Streaming */}
        {isStreaming && streamingText && (
          <div className="text-fg-1">
            {activeTools.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {activeTools.map((t, j) => (
                  <span key={j} className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                    t.status === 'running'
                      ? 'bg-amber-500/[0.06] text-amber-400/70 border-amber-500/15 animate-pulse'
                      : 'bg-bg-2/60 text-fg-2/50 border-border/30'
                  }`}>
                    {t.status === 'done' ? '✓' : '⟳'} {t.tool}
                  </span>
                ))}
              </div>
            )}
            <MiniMarkdownContent content={streamingText} />
            <span className="inline-block w-[2px] h-3 bg-blue-400/60 animate-pulse rounded-full align-text-bottom ml-0.5" />
          </div>
        )}

        {/* Thinking indicator */}
        {isThinking && (
          <div className="flex items-center gap-1.5 py-1">
            <div className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-[9px] text-violet-400/60">reasoning</span>
          </div>
        )}

        {/* Active tool indicator (no streaming yet) */}
        {!streamingText && !isThinking && activeTool && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse flex-shrink-0" />
            <span className="text-[9px] text-amber-400/60 font-mono truncate">{activeTool}</span>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && !isStreaming && !isThinking && !activeTool && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-border/30 flex items-center justify-center mb-2">
              <span className="text-sm opacity-40">⚡</span>
            </div>
            <div className="text-[10px] text-fg-2/40">
              {connected ? 'Ready — send a message' : isAlive ? 'Connecting…' : 'Type to wake agent'}
            </div>
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <div className="border-t border-border px-2 py-1.5 flex gap-1.5 flex-shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={sending ? '↯ Steer…' : 'Message…'}
          className="flex-1 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-fg placeholder-fg-2/40 focus:border-blue-500/30 focus:outline-none transition-colors min-w-0"
        />
        <button
          onClick={send}
          disabled={!input.trim()}
          className="px-2 py-1.5 text-[10px] bg-blue-600/80 hover:bg-blue-500 hover:shadow-sm text-white rounded-lg transition-colors disabled:opacity-30 flex-shrink-0 flex items-center justify-center w-8 h-7"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
});

/* ─── LiveGrid — mission control for headless agents ─────────────── */

export default function LiveGrid({ onOpenChat }: { onOpenChat?: (name: string) => void }) {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [cols, setCols] = useState(() => {
    try { return parseInt(localStorage.getItem('copilot-town:grid-cols') || '2') || 2; } catch { return 2; }
  });
  const [rowHeight, setRowHeight] = useState(() => {
    try { return parseInt(localStorage.getItem('copilot-town:grid-row-h') || '340') || 340; } catch { return 340; }
  });
  const [filter, setFilter] = useState<'active' | 'all'>('all');
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [fullscreenAgent, setFullscreenAgent] = useState<string | null>(null);
  const [relayTarget, setRelayTarget] = useState<string | null>(null);
  const [relayTo, setRelayTo] = useState('');
  const [relayInput, setRelayInput] = useState('');

  const load = useCallback(async () => {
    try {
      const all = await api.getAgents();
      setAgents(all.filter(a => a.type === 'headless'));
    } catch {}
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 4000); return () => clearInterval(iv); }, [load]);

  const setColsPersist = (n: number) => {
    setCols(n);
    try { localStorage.setItem('copilot-town:grid-cols', String(n)); } catch {}
  };

  const setRowHeightPersist = (h: number) => {
    setRowHeight(h);
    try { localStorage.setItem('copilot-town:grid-row-h', String(h)); } catch {}
  };

  // Keyboard navigation for grid cells
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when an input/textarea is focused
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') {
        if (fullscreenAgent) {
          setFullscreenAgent(null);
        } else {
          setFocusedIndex(-1);
        }
        e.preventDefault();
        return;
      }

      const count = filteredRef.current.length;
      if (count === 0) return;

      const columns = Math.min(cols, Math.max(count, 1));

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          setFocusedIndex(prev => (prev > 0 ? prev - 1 : 0));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setFocusedIndex(prev => (prev < count - 1 ? prev + 1 : prev));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex(prev => (prev >= columns ? prev - columns : prev));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex(prev => (prev < count - columns ? prev + columns : prev));
          break;
        case 'Enter':
          setFocusedIndex(prev => {
            if (prev >= 0 && prev < count) {
              setFullscreenAgent(filteredRef.current[prev].name);
            }
            return prev;
          });
          e.preventDefault();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cols, fullscreenAgent]);

  const filtered = filter === 'active'
    ? agents.filter(a => a.status === 'running' || a.status === 'idle')
    : agents;

  // Keep a ref to filtered so the keyboard handler can access current list without re-subscribing
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const activeCount = agents.filter(a => a.status === 'running' || a.status === 'idle').length;
  const effectiveCols = Math.min(cols, Math.max(filtered.length, 1));

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ height: 'calc(100vh - 120px)' }}>
      {/* ── Header ── */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <span>⚡</span> Live Grid
        </h2>
        <span className="text-[10px] text-fg-2 tabular-nums">
          {activeCount} active · {agents.length} total
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-2)' }}>
          Use arrow keys to navigate • Enter for fullscreen
        </span>
        <div className="flex-1" />

        {/* Filter toggle */}
        <div className="flex items-center gap-0.5 bg-bg-1/60 p-0.5 border border-border/50" style={{ borderRadius: 'var(--shape-xl)' }}>
          {(['active', 'all'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-[10px] transition-all duration-150 ${
                filter === f ? 'bg-bg-3/80 text-fg shadow-sm font-medium' : 'text-fg-2 hover:text-fg-1'
              }`}
              style={{ borderRadius: 'var(--shape-xl)' }}
            >
              {f === 'active' ? '● Active' : '○ All'}
            </button>
          ))}
        </div>

        {/* Column picker */}
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              onClick={() => setColsPersist(n)}
              className={`w-6 h-6 text-[10px] rounded-md transition-all duration-150 ${
                cols === n
                  ? 'bg-bg-3/80 text-fg border border-border-1 shadow-sm font-medium'
                  : 'text-fg-2 hover:text-fg-1 border border-transparent'
              }`}
            >{n}</button>
          ))}
          <span className="text-[9px] text-fg-2/50 ml-1">cols</span>
        </div>

        {/* Row height slider */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-1/60 border border-border/50" style={{ borderRadius: 'var(--shape-xl)' }}>
          <span className="text-[9px] text-fg-2/50">↕</span>
          <input
            type="range"
            min={180}
            max={700}
            step={20}
            value={rowHeight}
            onChange={e => setRowHeightPersist(Number(e.target.value))}
            className="w-16 h-1 accent-fg-2 cursor-pointer"
            title={`Row height: ${rowHeight}px`}
          />
          <span className="text-[9px] text-fg-2/50 tabular-nums w-7">{rowHeight}</span>
        </div>

        <button onClick={load} className="btn text-[10px]">↻</button>
      </div>

      {/* ── Grid ── */}
      {filtered.length > 0 ? (
        <div
          className="flex-1 overflow-y-auto min-h-0"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))`,
            gridAutoRows: `${rowHeight}px`,
            gap: '10px',
            alignContent: 'start',
          }}
        >
          {filtered.map((agent, i) => (
            <div
              key={agent.name}
              style={{
                outline: focusedIndex === i ? '2px solid #3b82f6' : 'none',
                outlineOffset: -2,
                borderRadius: 'var(--shape-lg)',
                height: '100%',
              }}
              onClick={() => setFocusedIndex(i)}
            >
              <MiniChat
                agent={agent}
                onExpand={() => setFullscreenAgent(agent.name)}
                displayAgents={filtered}
                relayTarget={relayTarget}
                setRelayTarget={setRelayTarget}
                relayTo={relayTo}
                setRelayTo={setRelayTo}
                relayInput={relayInput}
                setRelayInput={setRelayInput}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-4xl mb-3 opacity-60">⚡</div>
            <div className="text-sm font-medium text-fg-1 mb-1">No headless agents{filter === 'active' ? ' active' : ''}</div>
            <div className="text-xs text-fg-2/60 max-w-xs">
              {filter === 'active'
                ? 'Start headless agents from the Dashboard, or switch to "All" to see stopped agents.'
                : 'Create headless agents from the Dashboard to see them here.'}
            </div>
            {filter === 'active' && agents.length > 0 && (
              <button
                onClick={() => setFilter('all')}
                className="mt-3 btn text-[10px]"
              >Show {agents.length} stopped agent{agents.length !== 1 ? 's' : ''}</button>
            )}
          </div>
        </div>
      )}

      {/* ── Fullscreen Agent Overlay ── */}
      {fullscreenAgent && (() => {
        const agent = agents.find(a => a.name === fullscreenAgent);
        if (!agent) return null;
        const isAlive = agent.status === 'running' || agent.status === 'idle';
        return (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            animation: 'livegrid-fullscreen-in var(--duration-medium) var(--ease-emphasized-decel) both',
          }}>
            <style>{`
              @keyframes livegrid-fullscreen-in {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
              }
            `}</style>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px', borderBottom: '1px solid var(--color-border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    isAlive ? 'bg-emerald-500 dot-live' : 'bg-fg-2/30'
                  }`}
                />
                <span style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--color-fg)' }}>
                  {fullscreenAgent}
                </span>
              </div>
              <button className="btn" onClick={() => setFullscreenAgent(null)} aria-label="Close fullscreen">
                ✕ Close
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <MiniChat
                agent={agent}
                onExpand={() => setFullscreenAgent(null)}
                displayAgents={filtered}
                relayTarget={relayTarget}
                setRelayTarget={setRelayTarget}
                relayTo={relayTo}
                setRelayTo={setRelayTo}
                relayInput={relayInput}
                setRelayInput={setRelayInput}
              />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
