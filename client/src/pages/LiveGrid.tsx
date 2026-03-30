import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { api, type AgentData } from '../lib/api';
import HeadlessChatPanel from '../components/HeadlessChatPanel';

/* ─── Types ──────────────────────────────────────────────────────── */

interface StreamState {
  messages: { role: 'user' | 'agent'; text: string }[];
  streaming: string;
  thinking: boolean;
  activeTool: string | null;
  intent: string | null;
  connected: boolean;
  busy: boolean;
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
  });
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingSend = useRef<string | null>(null);

  const isAlive = agent.status === 'running' || agent.status === 'idle';

  // Wire WS message handler
  const wireWs = useCallback((ws: WebSocket) => {
    ws.onopen = () => {
      setState(s => ({ ...s, connected: true }));
      // Send any pending message that triggered the connection
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
            setState(s => ({ ...s, activeTool: msg.tool, busy: true }));
            break;
          case 'tool_complete':
            setState(s => ({ ...s, activeTool: null }));
            break;
          case 'intent':
            setState(s => ({ ...s, intent: msg.intent }));
            break;
          case 'response': {
            const text = msg.content || msg.text || msg.response || streamRef.current;
            if (text) {
              setState(s => ({
                ...s,
                messages: [...s.messages, { role: 'agent', text }],
                streaming: '', thinking: false, activeTool: null, busy: false,
              }));
            }
            streamRef.current = '';
            break;
          }
          case 'turn_end':
            if (streamRef.current) {
              const text = streamRef.current;
              streamRef.current = '';
              setState(s => ({
                ...s,
                messages: [...s.messages, { role: 'agent', text }],
                streaming: '', thinking: false, activeTool: null, busy: false,
              }));
            } else {
              setState(s => ({ ...s, thinking: false, activeTool: null, busy: false }));
            }
            break;
          case 'history':
            if (msg.messages?.length) {
              const history = msg.messages
                .map((m: any) => ({
                  role: (m.role === 'user' ? 'user' : 'agent') as 'user' | 'agent',
                  text: m.content || m.text || m.prompt || '',
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

  // Auto-connect for active agents only
  useEffect(() => {
    if (!isAlive) return;
    ensureWs();
    return () => { wsRef.current?.close(); wsRef.current = null; };
  }, [agent.name, isAlive, ensureWs]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    setState(s => ({
      ...s,
      messages: [...s.messages, { role: 'user', text }],
      busy: true,
    }));
    setInput('');
    streamRef.current = '';
    setState(s => ({ ...s, streaming: '' }));

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const action = state.busy ? 'steer' : undefined;
      ws.send(JSON.stringify(action ? { action, prompt: text } : { prompt: text }));
    } else {
      // Lazy connect — store pending message, WS onopen will send it
      pendingSend.current = text;
      ensureWs();
    }
  }, [input, state.busy, ensureWs]);

  // Border color based on activity
  const borderClass = state.busy
    ? 'border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.08)]'
    : state.connected
      ? 'border-border-1'
      : 'border-border';

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

        {/* Live indicators */}
        {state.thinking && (
          <span className="text-[9px] text-purple-400/80 animate-pulse flex-shrink-0">thinking</span>
        )}
        {state.activeTool && (
          <span className="text-[9px] text-amber-400/80 truncate max-w-[100px] flex-shrink-0">
            🔧 {state.activeTool}
          </span>
        )}
        {state.intent && !state.thinking && !state.activeTool && (
          <span className="text-[9px] text-fg-2/60 truncate max-w-[120px] flex-shrink-0">{state.intent}</span>
        )}

        <button
          onClick={onExpand}
          className="text-fg-2/40 hover:text-fg text-xs transition-colors flex-shrink-0"
          title="Open full panel"
        >⛶</button>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
        {state.messages.slice(-30).map((msg, i) => (
          <div key={i} className={`text-[11px] leading-relaxed ${
            msg.role === 'user' ? 'text-blue-400' : 'text-fg-1'
          }`}>
            <span className={`text-[9px] mr-1 font-medium ${
              msg.role === 'user' ? 'text-blue-400/60' : 'text-fg-2/60'
            }`}>
              {msg.role === 'user' ? '▸ you' : '◂ ' + agent.name.slice(0, 10)}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {msg.text.length > 600 ? msg.text.slice(0, 600) + '…' : msg.text}
            </span>
          </div>
        ))}

        {/* Streaming */}
        {state.streaming && (
          <div className="text-[11px] text-fg-1 leading-relaxed">
            <span className="text-[9px] text-fg-2/60 mr-1 font-medium">
              ◂ {agent.name.slice(0, 10)}
            </span>
            <span className="whitespace-pre-wrap break-words">
              {state.streaming.length > 600 ? '…' + state.streaming.slice(-600) : state.streaming}
            </span>
            <span className="animate-pulse text-blue-400 ml-0.5">▊</span>
          </div>
        )}

        {/* Thinking indicator */}
        {state.thinking && !state.streaming && (
          <div className="flex items-center gap-1.5 py-1">
            <div className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-[9px] text-purple-400/60">thinking</span>
          </div>
        )}

        {/* Empty state */}
        {state.messages.length === 0 && !state.streaming && !state.thinking && (
          <div className="text-[10px] text-fg-2/40 text-center py-6">
            {state.connected ? 'Ready' : isAlive ? 'Connecting…' : 'Type to wake agent'}
          </div>
        )}
      </div>

      {/* ── Input — always shown, WS auto-revives stopped agents ── */}
      <div className="border-t border-border px-2 py-1.5 flex gap-1.5 flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={state.busy ? '↯ Steer…' : 'Message…'}
            className="flex-1 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-fg placeholder-fg-2/40 focus:border-border-1 focus:outline-none transition-colors min-w-0"
          />
          <button
            onClick={send}
            disabled={!input.trim()}
            className="px-2.5 py-1.5 text-[10px] bg-blue-600/80 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-30 flex-shrink-0"
          >↑</button>
      </div>
    </div>
  );
});

/* ─── LiveGrid — mission control for headless agents ─────────────── */

export default function LiveGrid() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [cols, setCols] = useState(() => {
    try { return parseInt(localStorage.getItem('copilot-town:grid-cols') || '2') || 2; } catch { return 2; }
  });
  const [filter, setFilter] = useState<'active' | 'all'>('all');
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

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

        <button onClick={load} className="btn text-[10px]">↻</button>
      </div>

      {/* ── Grid ── */}
      {filtered.length > 0 ? (
        <div
          className="flex-1 overflow-y-auto min-h-0"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${effectiveCols}, minmax(0, 1fr))`,
            gridAutoRows: 'minmax(200px, 1fr)',
            gap: '10px',
            alignContent: 'start',
          }}
        >
          {filtered.map(agent => (
            <MiniChat
              key={agent.name}
              agent={agent}
              onExpand={() => setExpandedAgent(agent.name)}
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

      {/* ── Expanded chat panel (full HeadlessChatPanel as overlay) ── */}
      {expandedAgent && (
        <HeadlessChatPanel
          agentName={expandedAgent}
          onClose={() => setExpandedAgent(null)}
        />
      )}
    </div>
  );
}
