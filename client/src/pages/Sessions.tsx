import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type CopilotSession, type AgentData } from '../lib/api';

interface Turn {
  turn_index: number;
  user_message: string;
  assistant_response: string;
  timestamp: string;
}

interface SessionEntry {
  id: string;
  summary: string;
  branch: string;
  created_at: string;
  updated_at: string;
}

interface Props {
  agents: AgentData[];
  initialAgent?: string | null;
}

function relativeTime(dateStr: string): string {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const TURNS_PER_PAGE = 50;

/** Normalize headless agent SDK messages into Turn[] for display */
function normalizeHeadlessMessages(msgs: any[]): Turn[] {
  const normalized: Turn[] = [];
  let turnIdx = 0;
  let pendingUser: string | null = null;
  let pendingTs = '';
  for (const m of msgs) {
    if (m.type === 'user.message') {
      if (pendingUser !== null) {
        normalized.push({ turn_index: turnIdx++, user_message: pendingUser, assistant_response: '', timestamp: pendingTs });
      }
      pendingUser = m.prompt || m.content || m.text || '';
      pendingTs = m.timestamp || '';
    } else if (m.type === 'assistant.message') {
      const resp = m.content || m.text || '';
      const thinking = m.reasoningText || m.thinking || '';
      const prefix = thinking ? `> 💭 **thinking**\n>\n> ${thinking.replace(/\n/g, '\n> ')}\n\n---\n\n` : '';
      normalized.push({
        turn_index: turnIdx++,
        user_message: pendingUser || '',
        assistant_response: prefix + resp,
        timestamp: pendingTs || m.timestamp || '',
      });
      pendingUser = null;
      pendingTs = '';
    }
  }
  if (pendingUser !== null) {
    normalized.push({ turn_index: turnIdx++, user_message: pendingUser, assistant_response: '', timestamp: pendingTs });
  }
  return normalized;
}

// ── Register / rename button ──────────────────────────────────────
function RegisterButton({ session, onRegistered }: { session: CopilotSession; onRegistered: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(session.agentName || `session-${session.id.slice(0, 8)}`);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    try {
      await api.registerSession(session.id, name.trim() || `session-${session.id.slice(0, 8)}`);
      setOpen(false);
      onRegistered();
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  if (!open) return (
    <button
      className="text-[10px] px-2 py-1 rounded-md border border-dashed border-blue-500/30 text-blue-400/60 hover:border-blue-500/50 hover:text-blue-400 transition-colors"
      onClick={e => { e.stopPropagation(); setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
    >
      {session.agentName ? 'rename' : '+ register'}
    </button>
  );

  return (
    <form onSubmit={submit} onClick={e => e.stopPropagation()} className="flex items-center gap-1">
      <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
        className="text-[10px] bg-bg-2 border border-blue-500/40 rounded-md px-2 py-1 text-fg outline-none w-28"
        placeholder="agent name" disabled={saving} />
      <button type="submit" disabled={saving}
        className="text-[10px] px-2 py-1 rounded-md bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors">
        {saving ? '…' : '✓'}
      </button>
      <button type="button" onClick={() => setOpen(false)}
        className="text-[10px] text-fg-2 hover:text-fg px-1">✕</button>
    </form>
  );
}

// ── Main unified Sessions page ───────────────────────────────────
export default function Sessions({ agents = [], initialAgent }: Props) {
  // Session list (from /sessions endpoint — has registration, plan, checkpoints)
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [orphaned, setOrphaned] = useState<CopilotSession[]>([]);
  const [filter, setFilter] = useState<'all' | 'unregistered'>('all');
  const [loading, setLoading] = useState(true);

  // Conversation data (from /conversations endpoint — has chat history)
  const [convSessions, setConvSessions] = useState<SessionEntry[]>([]);
  const [search, setSearch] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Selection & detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'pane' | 'headless' | null>(null);
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'chat' | 'plan'>('chat');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionEntry | null>(null);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turnSearch, setTurnSearch] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [turnPage, setTurnPage] = useState(0);

  // Chat input
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamBuf = useRef('');
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // Connect WebSocket for headless agent chat
  useEffect(() => {
    if (selectedType !== 'headless' || !selectedAgentName) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    const ws = new WebSocket(`ws://${window.location.host}/ws/headless?agent=${encodeURIComponent(selectedAgentName)}`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          streamBuf.current += msg.content || msg.deltaContent || '';
          setTurns(prev => {
            const last = prev[prev.length - 1];
            if (!last) return prev;
            return [...prev.slice(0, -1), { ...last, assistant_response: streamBuf.current }];
          });
        } else if (msg.type === 'response') {
          const final = msg.content || streamBuf.current;
          setTurns(prev => {
            const last = prev[prev.length - 1];
            if (!last) return prev;
            return [...prev.slice(0, -1), { ...last, assistant_response: final }];
          });
          streamBuf.current = '';
          setSending(false);
        } else if (msg.type === 'error') {
          setTurns(prev => {
            const last = prev[prev.length - 1];
            if (!last) return prev;
            return [...prev.slice(0, -1), { ...last, assistant_response: `⚠️ Error: ${msg.message}` }];
          });
          streamBuf.current = '';
          setSending(false);
        }
      } catch {}
    };

    ws.onclose = () => { wsRef.current = null; setSending(false); };
    return () => { ws.close(); wsRef.current = null; };
  }, [selectedType, selectedAgentName]);

  // Send message handler
  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || sending || !selectedAgentName) return;

    const newTurn: Turn = {
      turn_index: turns.length,
      user_message: text,
      assistant_response: '',
      timestamp: new Date().toISOString(),
    };
    setTurns(prev => [...prev, newTurn]);
    setChatInput('');
    setSending(true);

    if (selectedType === 'headless') {
      // Send via WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        streamBuf.current = '';
        wsRef.current.send(JSON.stringify({ prompt: text }));
      } else {
        setTurns(prev => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [...prev.slice(0, -1), { ...last, assistant_response: '⚠️ WebSocket not connected' }];
        });
        setSending(false);
      }
    } else {
      // Send via relay (pane agent)
      try {
        await api.sendMessage(selectedAgentName, text, 'you');
        // Pane agents don't stream back — update message to show it was sent
        setTurns(prev => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [...prev.slice(0, -1), { ...last, assistant_response: '*(message relayed via psmux — check agent pane for response)*' }];
        });
      } catch (err: any) {
        setTurns(prev => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [...prev.slice(0, -1), { ...last, assistant_response: `⚠️ Relay failed: ${err.message}` }];
        });
      }
      setSending(false);
    }
  }, [chatInput, sending, selectedAgentName, selectedType, turns.length]);

  // Load all sessions
  const loadSessions = useCallback(() => {
    Promise.all([api.getSessions(50), api.getOrphanedSessions()])
      .then(([all, orph]) => { setSessions(all); setOrphaned(orph); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Load conversation session list (separate endpoint, supports search)
  useEffect(() => {
    api.getSessionList(undefined, 100)
      .then(setConvSessions)
      .catch(() => setConvSessions([]));
  }, []);

  // Search with debounce
  const doSearch = useCallback((q: string) => {
    api.getSessionList(q || undefined, 100)
      .then(setConvSessions)
      .catch(() => setConvSessions([]));
  }, []);

  const handleSearchChange = useCallback((val: string) => {
    setSearch(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(val), 300);
  }, [doSearch]);

  // Auto-select from initialAgent
  useEffect(() => {
    if (!initialAgent || convSessions.length === 0) return;
    const agent = agents.find(a => a.id === initialAgent || a.name === initialAgent);
    const sid = agent?.sessionId;
    if (sid) {
      setSelectedId(sid);
      setSelectedType(agent?.type === 'headless' ? 'headless' : 'pane');
      setSelectedAgentName(agent?.name || null);
      setDetailTab('chat');
    }
  }, [initialAgent, agents, convSessions]);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) { setTurns([]); setSessionMeta(null); setPlanContent(null); setTurnPage(0); setLoadError(null); return; }
    setTurnPage(0);
    setDetailLoading(true);
    setLoadError(null);

    if (detailTab === 'chat') {
      if (selectedType === 'headless' && selectedAgentName) {
        // Headless agent — try live messages first, fall back to session-store.db
        api.getAgentMessages(selectedAgentName)
          .then(data => {
            const msgs = data?.messages || [];
            const normalized = normalizeHeadlessMessages(msgs);
            if (normalized.length > 0) {
              setTurns(normalized);
              setSessionMeta({ id: selectedId, summary: selectedAgentName + ' (headless)', branch: '', created_at: '', updated_at: '' });
            } else {
              // No live messages — try session-store.db as fallback
              return api.getConversation(selectedId).then(t => {
                setTurns(t);
                return api.getConversationSummary(selectedId)
                  .then(s => setSessionMeta(s))
                  .catch(() => setSessionMeta({ id: selectedId, summary: selectedAgentName, branch: '', created_at: '', updated_at: '' }));
              });
            }
          })
          .catch(() => {
            // Live agent failed — try session-store.db as fallback
            return api.getConversation(selectedId)
              .then(t => {
                setTurns(t);
                return api.getConversationSummary(selectedId)
                  .then(s => setSessionMeta(s))
                  .catch(() => setSessionMeta({ id: selectedId, summary: selectedAgentName, branch: '', created_at: '', updated_at: '' }));
              })
              .catch(() => {
                setTurns([]);
                setSessionMeta(null);
                setLoadError('Could not load conversation history');
              });
          })
          .finally(() => setDetailLoading(false));
      } else {
        // Pane agent — use existing conversation endpoint
        Promise.all([
          api.getConversation(selectedId),
          api.getConversationSummary(selectedId),
        ])
          .then(([t, s]) => { setTurns(t); setSessionMeta(s); })
          .catch(() => { setTurns([]); setSessionMeta(null); setLoadError('Could not load conversation history'); })
          .finally(() => setDetailLoading(false));
      }
    } else {
      api.getSessionPlan(selectedId)
        .then(({ plan }) => setPlanContent(plan))
        .catch(() => setPlanContent('(No plan found)'))
        .finally(() => setDetailLoading(false));
    }
  }, [selectedId, detailTab, selectedType, selectedAgentName]);

  // Scroll to bottom on new turns
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  // Auto-advance to last page when streaming (headless agent)
  useEffect(() => {
    if (selectedType === 'headless' && sending) {
      const lastPage = Math.max(0, Math.ceil(turns.length / TURNS_PER_PAGE) - 1);
      setTurnPage(lastPage);
    }
  }, [turns.length, selectedType, sending]);

  const filteredTurns = useMemo(() => turnSearch
    ? turns.filter(t =>
        t.user_message?.toLowerCase().includes(turnSearch.toLowerCase()) ||
        t.assistant_response?.toLowerCase().includes(turnSearch.toLowerCase()))
    : turns, [turns, turnSearch]);

  // Pagination
  const totalPages = Math.ceil(filteredTurns.length / TURNS_PER_PAGE);
  const paginatedTurns = useMemo(() => {
    const start = turnPage * TURNS_PER_PAGE;
    return filteredTurns.slice(start, start + TURNS_PER_PAGE);
  }, [filteredTurns, turnPage]);

  // Reset page when search filter changes
  useEffect(() => { setTurnPage(0); }, [turnSearch]);

  const truncateUser = (text: string, max = 3000) =>
    text && text.length > max ? text.slice(0, max) + '…' : text;

  // Build unified session list — merge CopilotSession metadata with conversation entries
  // Also include headless agents that aren't in the pane session list
  const headlessAgents = agents.filter(a => a.type === 'headless');
  const headlessSessionIds = new Set(headlessAgents.map(a => a.sessionId));

  // Tag existing SDK sessions that belong to headless agents
  const taggedSessions = sessions.map(s => 
    headlessSessionIds.has(s.id) ? { ...s, type: 'headless' as const } : s
  );

  const headlessAsSessions: CopilotSession[] = headlessAgents
    .filter(a => !sessions.some(s => s.id === a.sessionId))
    .map(a => ({
      id: a.sessionId,
      summary: a.summary || a.description || a.name,
      branch: '',
      created_at: '',
      updated_at: '',
      lastModified: '',
      agentName: a.name,
      cwd: '',
      checkpoints: [],
      hasPlan: false,
      isOrphaned: false,
      type: 'headless' as const,
    }));

  const allSessions = [...taggedSessions, ...headlessAsSessions];
  const displaySessions = filter === 'unregistered' ? orphaned : allSessions;

  // Lookup: session id → CopilotSession (for registration info)
  const sessionLookup = new Map<string, CopilotSession>();
  for (const s of sessions) sessionLookup.set(s.id, s);
  for (const s of orphaned) sessionLookup.set(s.id, s);

  // Lookup: session id → conversation entry (for summary, branch)
  const convLookup = new Map<string, SessionEntry>();
  for (const s of convSessions) convLookup.set(s.id, s);

  // ── Split into live agents vs history ──
  const liveAgentSessions = displaySessions.filter(s => {
    const agent = agents.find(a => a.sessionId === s.id || a.name === s.agentName);
    return agent && (agent.status === 'running' || agent.status === 'idle');
  });
  const historySessions = displaySessions.filter(s => {
    const agent = agents.find(a => a.sessionId === s.id || a.name === s.agentName);
    return !agent || agent.status === 'stopped';
  });

  // Search filter
  const filterSession = (s: CopilotSession) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (s.agentName || '').toLowerCase().includes(q) ||
      (s.summary || '').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q);
  };

  const filteredLive = liveAgentSessions.filter(filterSession);
  const filteredHistory = historySessions.filter(filterSession);

  const renderSessionItem = (s: CopilotSession) => {
    const conv = convLookup.get(s.id);
    const displaySummary = s.summary || conv?.summary;
    const agent = agents.find(a => a.sessionId === s.id || a.name === s.agentName);
    const isLive = agent && (agent.status === 'running' || agent.status === 'idle');
    const isSelected = selectedId === s.id;

    return (
      <div key={s.id}
        className="p-3 cursor-pointer relative group"
        style={{
          borderRadius: 'var(--shape-md)',
          background: isSelected ? 'var(--accent-dim)' : 'transparent',
          transition: 'all var(--duration-short) var(--ease-standard)',
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-2)'; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
        onClick={() => {
          setSelectedId(s.id);
          setSelectedType(agent?.type === 'headless' || s.type === 'headless' ? 'headless' : 'pane');
          setSelectedAgentName(agent?.name || s.agentName || null);
          setDetailTab('chat');
          setTurnPage(0);
        }}>
        {isSelected && (
          <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, borderRadius: 'var(--shape-full)', background: 'var(--accent)' }} />
        )}
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-2 min-w-0">
            {/* Status dot */}
            {isLive && (
              <span className="dot-live flex-shrink-0" style={{
                width: 7, height: 7, borderRadius: '50%',
                background: agent?.status === 'running' ? '#22c55e' : '#eab308',
              }} />
            )}
            {!isLive && (
              <span className="flex-shrink-0" style={{
                width: 7, height: 7, borderRadius: '50%',
                background: 'var(--color-fg-2)', opacity: 0.25,
              }} />
            )}
            <span className="text-[13px] font-medium truncate" style={{ color: isSelected ? 'var(--accent)' : 'var(--color-fg)' }}>
              {s.agentName || `session-${s.id.slice(0, 6)}`}
            </span>
            {s.type === 'headless' && (
              <span style={{ fontSize: 10, color: 'var(--color-fg-2)', opacity: 0.5 }}>⚡</span>
            )}
          </div>
          <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-fg-2)', opacity: 0.4 }}>
            {relativeTime(s.lastModified)}
          </span>
        </div>
        {displaySummary && displaySummary !== 'Start Conversation' && displaySummary.length > 3 && !/^[\-|─\s]+$/.test(displaySummary) && (
          <p className="text-[11px] truncate ml-[19px]" style={{ color: 'var(--color-fg-2)', lineHeight: 1.4 }}>{displaySummary}</p>
        )}
      </div>
    );
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-5.5rem)]">
      {/* Left panel — agent/session list */}
      <div className="w-[320px] shrink-0 flex flex-col pr-3" style={{ borderRight: '1px solid var(--color-border)' }}>
        <div className="mb-3">
          <input type="text" value={search} onChange={e => handleSearchChange(e.target.value)}
            placeholder="🔍 Search agents & sessions…"
            className="w-full input-m3 px-4 py-2.5 text-xs text-fg placeholder-fg-2/40 outline-none transition-colors" />
        </div>

        {loading ? (
          <div className="space-y-2 px-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="card-surface p-3" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ width: '50%', height: 12, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                <div style={{ width: '80%', height: 10, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {/* ── Live Agents section ── */}
            {filteredLive.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-2 px-3 py-1.5 mb-1">
                  <span className="dot-live" style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
                  <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-fg-2)' }}>
                    Live · {filteredLive.length}
                  </span>
                </div>
                {filteredLive.map(renderSessionItem)}
              </div>
            )}

            {/* ── Divider ── */}
            {filteredLive.length > 0 && filteredHistory.length > 0 && (
              <div style={{ height: 1, background: 'var(--color-border)', margin: '8px 12px' }} />
            )}

            {/* ── History section ── */}
            {filteredHistory.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-3 py-1.5 mb-1">
                  <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-fg-2)' }}>
                    History · {filteredHistory.length}
                  </span>
                  <div className="flex gap-1">
                    <button className="text-[10px] px-2 py-0.5" style={{
                      borderRadius: 'var(--shape-full)', border: 'none', cursor: 'pointer',
                      background: filter === 'all' ? 'var(--accent-dim)' : 'transparent',
                      color: filter === 'all' ? 'var(--accent)' : 'var(--color-fg-2)',
                      transition: 'all var(--duration-short) var(--ease-standard)',
                    }} onClick={() => setFilter('all')}>All</button>
                    <button className="text-[10px] px-2 py-0.5" style={{
                      borderRadius: 'var(--shape-full)', border: 'none', cursor: 'pointer',
                      background: filter === 'unregistered' ? 'var(--accent-dim)' : 'transparent',
                      color: filter === 'unregistered' ? 'var(--accent)' : 'var(--color-fg-2)',
                      transition: 'all var(--duration-short) var(--ease-standard)',
                    }} onClick={() => setFilter('unregistered')}>Unregistered</button>
                  </div>
                </div>
                {filteredHistory.map(renderSessionItem)}
              </div>
            )}

            {filteredLive.length === 0 && filteredHistory.length === 0 && (
              <div className="text-center py-12 text-fg-2 text-xs">
                <span className="text-2xl block mb-3 opacity-20">↻</span>
                <p>{search ? 'No matching sessions' : 'No sessions found'}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right panel — chat */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: 'var(--color-bg-1)', borderRadius: 'var(--shape-lg)', boxShadow: 'var(--elevation-1)' }}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center" style={{ maxWidth: 280 }}>
              <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: 12, opacity: 0.15 }}>💬</span>
              <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-fg-1)', marginBottom: 4 }}>
                {liveAgentSessions.length > 0 ? 'Select an agent to chat' : 'No live agents'}
              </p>
              <p style={{ fontSize: 12, color: 'var(--color-fg-2)', lineHeight: 1.5 }}>
                {liveAgentSessions.length > 0
                  ? 'Pick a live agent from the sidebar to start a conversation'
                  : 'Spawn agents from the Dashboard, then come here to chat'}
              </p>
            </div>
          </div>
        ) : (
          <div key={selectedId} className="flex-1 flex flex-col min-h-0 animate-fade-in">
            {/* Header with connection status */}
            <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <div className="min-w-0 flex-1 mr-3">
                <div className="flex items-center gap-2">
                  {/* Live indicator */}
                  {(() => {
                    const agent = agents.find(a => a.sessionId === selectedId || a.name === selectedAgentName);
                    const isLive = agent && (agent.status === 'running' || agent.status === 'idle');
                    return isLive ? (
                      <span className="dot-live flex-shrink-0" style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: agent?.status === 'running' ? '#22c55e' : '#eab308',
                      }} />
                    ) : (
                      <span className="flex-shrink-0" style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: 'var(--color-fg-2)', opacity: 0.2,
                      }} />
                    );
                  })()}
                  <h3 className="text-sm font-medium truncate" style={{ letterSpacing: '-0.01em' }}>
                    {selectedAgentName || (() => {
                      const raw = sessionMeta?.summary || sessionLookup.get(selectedId)?.summary || '';
                      const cleaned = (raw && raw.length > 3 && !/^[\-|─\s]+$/.test(raw) && raw !== 'Start Conversation') ? raw : '';
                      return cleaned || selectedId.slice(0, 24);
                    })()}
                  </h3>
                  {selectedType === 'headless' && (
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-full)', background: 'rgba(34,211,238,0.08)', color: 'rgba(34,211,238,0.7)' }}>⚡ headless</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 ml-[18px]">
                  {sessionMeta?.branch && (
                    <span className="text-[11px] font-mono" style={{ color: 'var(--color-fg-2)' }}>⎇ {sessionMeta.branch}</span>
                  )}
                  {(() => {
                    const agent = agents.find(a => a.sessionId === selectedId || a.name === selectedAgentName);
                    const isLive = agent && (agent.status === 'running' || agent.status === 'idle');
                    return isLive
                      ? <span className="text-[10px]" style={{ color: '#22c55e', opacity: 0.7 }}>Connected</span>
                      : <span className="text-[10px]" style={{ color: 'var(--color-fg-2)', opacity: 0.4 }}>History only</span>;
                  })()}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="flex bg-bg rounded-md overflow-hidden">
                  <button className={`text-xs px-3 py-1.5 transition-colors ${detailTab === 'chat' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
                    onClick={() => setDetailTab('chat')}>💬 Chat</button>
                  <button className={`text-xs px-3 py-1.5 transition-colors ${detailTab === 'plan' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
                    onClick={() => setDetailTab('plan')}>📋 Plan</button>
                </div>
                {detailTab === 'chat' && (
                  <>
                    <input type="text" value={turnSearch} onChange={e => setTurnSearch(e.target.value)}
                      placeholder="Filter…"
                      className="input-m3 px-3 py-1.5 text-xs text-fg placeholder-fg-2/40 outline-none w-32 transition-colors" />
                    <span className="text-xs text-fg-2/50 tabular-nums">{turns.length} turns</span>
                    <button
                      className="text-xs px-2.5 py-1.5 rounded-md bg-bg border border-border text-fg-2 hover:text-fg hover:border-blue-500/40 transition-colors"
                      onClick={() => {
                        const text = turns.map(t => {
                          const ts = t.timestamp ? ` (${new Date(t.timestamp).toLocaleString()})` : '';
                          const parts: string[] = [];
                          if (t.user_message) parts.push(`## User${ts}\n\n${t.user_message}`);
                          if (t.assistant_response) parts.push(`## Assistant${ts}\n\n${t.assistant_response}`);
                          return parts.join('\n\n---\n\n');
                        }).join('\n\n---\n\n');
                        const blob = new Blob([text], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `session-${selectedId}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      title="Export as Markdown"
                      aria-label="Export conversation"
                    >
                      📥 Export
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Content */}
            {detailLoading ? (
              <div className="flex-1 p-4 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} style={{
                    height: 16,
                    borderRadius: 6,
                    width: i % 2 === 0 ? '75%' : '100%',
                    marginLeft: i % 2 === 0 ? 'auto' : undefined,
                    background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)',
                    backgroundSize: '200% 100%',
                    animation: 'shimmer 1.5s ease-in-out infinite',
                  }} />
                ))}
              </div>
            ) : detailTab === 'chat' ? (
              /* Chat view — messages + input */
              <div className="flex-1 flex flex-col min-h-0">
                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
                    <button className="text-xs px-2.5 py-1 rounded-md bg-bg border border-border text-fg-2 hover:text-fg hover:border-blue-500/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed" disabled={turnPage === 0} onClick={() => setTurnPage(p => p - 1)}>
                      ← Prev
                    </button>
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-2)' }}>
                      Page {turnPage + 1} of {totalPages} ({filteredTurns.length} turns)
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={filteredTurns.length}
                      placeholder="Jump to #"
                      style={{ width: 80, fontSize: '0.7rem', padding: '4px 6px', background: 'var(--color-bg-2)', color: 'var(--color-fg)', border: '1px solid var(--color-border)', borderRadius: 4 }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const n = parseInt((e.target as HTMLInputElement).value);
                          if (n > 0 && n <= filteredTurns.length) {
                            setTurnPage(Math.floor((n - 1) / TURNS_PER_PAGE));
                          }
                        }
                      }}
                    />
                    <button className="text-xs px-2.5 py-1 rounded-md bg-bg border border-border text-fg-2 hover:text-fg hover:border-blue-500/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed" disabled={turnPage >= totalPages - 1} onClick={() => setTurnPage(p => p + 1)}>
                      Next →
                    </button>
                  </div>
                )}
                <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
                  {paginatedTurns.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                      {loadError ? (
                        <>
                          <span style={{ fontSize: '1.5rem', opacity: 0.4 }}>⚠️</span>
                          <span className="text-xs" style={{ color: 'var(--color-fg-2)' }}>{loadError}</span>
                          <button className="text-xs px-3 py-1 mt-1" style={{ borderRadius: 'var(--shape-full)', background: 'var(--color-bg-2)', border: '1px solid var(--color-border)', color: 'var(--color-fg-1)', cursor: 'pointer' }}
                            onClick={() => { setLoadError(null); setDetailLoading(true); /* re-trigger by toggling selectedId */ const id = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(id), 50); }}>
                            Retry
                          </button>
                        </>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--color-fg-2)' }}>
                          {turnSearch ? 'No matching messages' : selectedAgentName ? 'Send a message to start chatting' : 'No conversation history'}
                        </span>
                      )}
                    </div>
                  ) : (
                    paginatedTurns.map(turn => (
                      <div key={turn.turn_index} className="space-y-3">
                        {turn.user_message && (
                          <div className="flex justify-end">
                            <div className="max-w-[75%]">
                              <div className="bg-blue-500/8 border border-blue-500/15 px-4 py-2.5" style={{ borderRadius: '18px 18px 4px 18px' }}>
                                <pre className="text-xs text-fg whitespace-pre-wrap break-words font-sans leading-relaxed">
                                  {truncateUser(turn.user_message)}
                                </pre>
                              </div>
                              <p className="text-[10px] text-fg-2/30 mt-1 mb-1 text-right tabular-nums">
                                #{turn.turn_index} · {turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : ''}
                              </p>
                            </div>
                          </div>
                        )}
                        {turn.assistant_response && (
                          <div className="flex justify-start">
                            <div className="max-w-[85%]">
                              <div className="bg-bg-2/60 border border-border px-4 py-2.5" style={{ borderRadius: '4px 18px 18px 18px' }}>
                                <div className="text-xs text-fg-1 leading-relaxed prose-sm">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {turn.assistant_response}
                                  </ReactMarkdown>
                                </div>
                              </div>
                              <p className="text-[10px] text-fg-2/30 mt-1 mb-1 tabular-nums">
                                assistant · #{turn.turn_index}{turn.timestamp ? ` · ${new Date(turn.timestamp).toLocaleTimeString()}` : ''}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                  {sending && (
                    <div className="flex justify-start">
                      <div className="bg-bg-2/60 border border-border px-4 py-2.5 flex items-center gap-2" style={{ borderRadius: '4px 18px 18px 18px' }}>
                        <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                        <span className="text-xs text-fg-2">Thinking…</span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat input bar */}
                {selectedAgentName && (
                  <div className="flex-shrink-0 border-t border-border/30 px-5 py-4">
                    <div className="flex items-end gap-2">
                      <textarea
                        ref={chatInputRef}
                        className="flex-1 input-m3 px-4 py-2.5 text-xs text-fg resize-none focus:outline-none min-h-[40px] max-h-[120px] transition-all placeholder-fg-2/40"
                        placeholder={sending ? 'Waiting for response…' : `Message ${selectedAgentName}…`}
                        rows={1}
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); }
                        }}
                        disabled={sending}
                        onInput={e => {
                          const t = e.currentTarget;
                          t.style.height = 'auto';
                          t.style.height = Math.min(t.scrollHeight, 120) + 'px';
                        }}
                      />
                      <button
                        className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-90 bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 disabled:opacity-20"
                        onClick={handleSendChat}
                        disabled={sending || !chatInput.trim()}>
                        {sending ? '⏳' : '↑'}
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-fg-2/30">Enter to send · Shift+Enter for newline</span>
                      <span className="text-[10px] text-fg-2/30">
                        {selectedType === 'headless' ? '⚡ SDK headless' : '📺 psmux relay'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Plan view */
              <div className="flex-1 overflow-auto p-4">
                <pre className="text-xs font-mono text-fg-2 leading-relaxed whitespace-pre-wrap">
                  {planContent || '(No plan found)'}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
