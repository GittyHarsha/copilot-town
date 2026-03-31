import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api, type AgentData } from '../lib/api';
import { MiniMarkdownContent, CopyButton, relativeTime } from '../components/ChatMarkdown';

/* ─── Types ──────────────────────────────────────────────────────── */

interface ToolInfo {
  name: string;
  status: 'running' | 'done';
}

interface StreamMessage {
  role: 'user' | 'agent';
  text: string;
  thinking?: boolean;
  tools?: ToolInfo[];
  timestamp: number;
}

interface StreamState {
  messages: StreamMessage[];
  streaming: string;
  thinking: boolean;
  activeTool: string | null;
  intent: string | null;
  connected: boolean;
  busy: boolean;
  activeTools: ToolInfo[];
}

const WS_BASE = `ws://${window.location.host}/ws/headless`;

/* ─── MiniChat — compact agent panel for grid ────────────────────── */

const MiniChat = memo(function MiniChat({
  agent, onExpand,
}: {
  agent: AgentData;
  onExpand: () => void;
}) {
  const [state, setState] = useState<StreamState>({
    messages: [], streaming: '', thinking: false,
    activeTool: null, intent: null, connected: false, busy: false,
    activeTools: [],
  });
  const [input, setInput] = useState('');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingSend = useRef<string | null>(null);
  const toolsRef = useRef<ToolInfo[]>([]);

  const isAlive = agent.status === 'running' || agent.status === 'idle';

  const wireWs = useCallback((ws: WebSocket) => {
    ws.onopen = () => {
      setState(s => ({ ...s, connected: true }));
      if (pendingSend.current) {
        ws.send(JSON.stringify({ prompt: pendingSend.current }));
        pendingSend.current = null;
      }
    };
    ws.onclose = () => {
      setState(s => ({ ...s, connected: false }));
      wsRef.current = null;
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'message_delta':
          case 'streaming_delta':
            streamRef.current += msg.delta || msg.content || msg.text || '';
            setState(s => ({ ...s, streaming: streamRef.current, busy: true }));
            break;
          case 'reasoning':
          case 'reasoning_delta':
            setState(s => ({ ...s, thinking: true, busy: true }));
            break;
          case 'tool_start':
            toolsRef.current = [...toolsRef.current, { name: msg.tool, status: 'running' }];
            setState(s => ({ ...s, activeTool: msg.tool, busy: true, activeTools: [...toolsRef.current] }));
            break;
          case 'tool_complete':
            toolsRef.current = toolsRef.current.map(t =>
              t.name === msg.tool && t.status === 'running' ? { ...t, status: 'done' as const } : t
            );
            setState(s => ({ ...s, activeTool: null, activeTools: [...toolsRef.current] }));
            break;
          case 'intent':
            setState(s => ({ ...s, intent: msg.intent }));
            break;
          case 'response': {
            const text = msg.content || msg.text || msg.response || streamRef.current;
            const tools = toolsRef.current.length > 0 ? [...toolsRef.current] : undefined;
            if (text) {
              setState(s => ({
                ...s,
                messages: [...s.messages, { role: 'agent', text, tools, timestamp: Date.now() }],
                streaming: '', thinking: false, activeTool: null, busy: false, activeTools: [],
              }));
            }
            streamRef.current = '';
            toolsRef.current = [];
            break;
          }
          case 'turn_end':
            if (streamRef.current) {
              const text = streamRef.current;
              const tools = toolsRef.current.length > 0 ? [...toolsRef.current] : undefined;
              streamRef.current = '';
              toolsRef.current = [];
              setState(s => ({
                ...s,
                messages: [...s.messages, { role: 'agent', text, tools, timestamp: Date.now() }],
                streaming: '', thinking: false, activeTool: null, busy: false, activeTools: [],
              }));
            } else {
              setState(s => ({ ...s, thinking: false, activeTool: null, busy: false, activeTools: [] }));
              toolsRef.current = [];
            }
            break;
          case 'history':
            if (msg.messages?.length) {
              const history = msg.messages
                .map((m: any) => ({
                  role: (m.role === 'user' ? 'user' : 'agent') as 'user' | 'agent',
                  text: m.content || m.text || m.prompt || '',
                  timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
                }))
                .filter((m: any) => m.text);
              setState(s => ({ ...s, messages: history }));
            }
            break;
        }
      } catch {}
    };
  }, [agent.name]);

  const ensureWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agent.name)}`);
    wsRef.current = ws;
    wireWs(ws);
    return ws;
  }, [agent.name, wireWs]);

  useEffect(() => {
    if (!isAlive) return;
    ensureWs();
    return () => { wsRef.current?.close(); wsRef.current = null; };
  }, [agent.name, isAlive, ensureWs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    setState(s => ({
      ...s,
      messages: [...s.messages, { role: 'user', text, timestamp: Date.now() }],
      busy: true,
    }));
    setInput('');
    streamRef.current = '';
    toolsRef.current = [];
    setState(s => ({ ...s, streaming: '', activeTools: [] }));

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const action = state.busy ? 'steer' : undefined;
      ws.send(JSON.stringify(action ? { action, prompt: text } : { prompt: text }));
    } else {
      pendingSend.current = text;
      ensureWs();
    }
  }, [input, state.busy, ensureWs]);

  const borderClass = state.busy
    ? 'border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.08)]'
    : state.connected
      ? 'border-border-1'
      : 'border-border';

  const lastMessages = state.messages.slice(-30);

  return (
    <div className={`flex flex-col rounded-xl border overflow-hidden transition-all duration-300 bg-bg-1 ${borderClass} min-h-0`}>
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-2/40 flex-shrink-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          state.busy ? 'bg-blue-500 animate-pulse'
          : isAlive ? 'bg-emerald-500 dot-live'
          : 'bg-fg-2/30'
        }`} />
        <span className="text-[11px] font-semibold truncate flex-1 tracking-tight">{agent.name}</span>

        {/* Live status indicators */}
        {state.thinking && (
          <span className="flex items-center gap-1 flex-shrink-0">
            <span className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </span>
        )}
        {state.activeTool && !state.thinking && (
          <span className="text-[9px] text-amber-400/80 truncate max-w-[100px] flex-shrink-0 font-mono">
            {state.activeTool}
          </span>
        )}
        {state.intent && !state.thinking && !state.activeTool && (
          <span className="text-[9px] text-blue-400/60 truncate max-w-[120px] flex-shrink-0">{state.intent}</span>
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
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2.5 py-2 space-y-2 min-h-0">
        {lastMessages.map((msg, i) => (
          <div
            key={i}
            className="group/msg"
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {msg.role === 'user' ? (
              /* ── User message: right-aligned bubble ── */
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-xl rounded-br-sm px-2.5 py-1.5 bg-blue-500/[0.07] border border-blue-500/[0.1] text-[11px] text-fg leading-relaxed whitespace-pre-wrap break-words">
                  {msg.text}
                </div>
              </div>
            ) : (
              /* ── Agent message: full-width with markdown ── */
              <div className="text-fg-1">
                {/* Tool pills */}
                {msg.tools && msg.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {msg.tools.map((t, j) => (
                      <span key={j} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-2/60 text-fg-2/50 border border-border/30 font-mono">
                        {t.status === 'done' ? '✓' : '⟳'} {t.name}
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
        {state.streaming && (
          <div className="text-fg-1">
            {state.activeTools.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1">
                {state.activeTools.map((t, j) => (
                  <span key={j} className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                    t.status === 'running'
                      ? 'bg-amber-500/[0.06] text-amber-400/70 border-amber-500/15 animate-pulse'
                      : 'bg-bg-2/60 text-fg-2/50 border-border/30'
                  }`}>
                    {t.status === 'done' ? '✓' : '⟳'} {t.name}
                  </span>
                ))}
              </div>
            )}
            <MiniMarkdownContent content={state.streaming} />
            <span className="inline-block w-[2px] h-3 bg-blue-400/60 animate-pulse rounded-full align-text-bottom ml-0.5" />
          </div>
        )}

        {/* Thinking indicator */}
        {state.thinking && !state.streaming && (
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
        {!state.streaming && !state.thinking && state.activeTool && (
          <div className="flex items-center gap-1.5 py-1">
            <span className="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse flex-shrink-0" />
            <span className="text-[9px] text-amber-400/60 font-mono truncate">{state.activeTool}</span>
          </div>
        )}

        {/* Empty state */}
        {state.messages.length === 0 && !state.streaming && !state.thinking && !state.activeTool && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-border/30 flex items-center justify-center mb-2">
              <span className="text-sm opacity-40">⚡</span>
            </div>
            <div className="text-[10px] text-fg-2/40">
              {state.connected ? 'Ready — send a message' : isAlive ? 'Connecting…' : 'Type to wake agent'}
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
          placeholder={state.busy ? '↯ Steer…' : 'Message…'}
          className="flex-1 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-fg placeholder-fg-2/40 focus:border-blue-500/30 focus:outline-none transition-colors min-w-0"
        />
        <button
          onClick={send}
          disabled={!input.trim()}
          className="px-2 py-1.5 text-[10px] bg-blue-600/80 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-30 flex-shrink-0 flex items-center justify-center w-7"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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

  const filtered = filter === 'active'
    ? agents.filter(a => a.status === 'running' || a.status === 'idle')
    : agents;

  const activeCount = agents.filter(a => a.status === 'running' || a.status === 'idle').length;
  const effectiveCols = Math.min(cols, Math.max(filtered.length, 1));

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      {/* ── Header ── */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <span>⚡</span> Live Grid
        </h2>
        <span className="text-[10px] text-fg-2 tabular-nums">
          {activeCount} active · {agents.length} total
        </span>
        <div className="flex-1" />

        {/* Filter toggle */}
        <div className="flex items-center gap-0.5 bg-bg-1/60 rounded-lg p-0.5 border border-border/50">
          {(['active', 'all'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-[10px] rounded-md transition-all duration-150 ${
                filter === f ? 'bg-bg-3/80 text-fg shadow-sm font-medium' : 'text-fg-2 hover:text-fg-1'
              }`}
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
        <div className="flex items-center gap-1.5">
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
          {filtered.map(agent => (
            <MiniChat
              key={agent.name}
              agent={agent}
              onExpand={() => onOpenChat?.(agent.name)}
            />
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
    </div>
  );
}
