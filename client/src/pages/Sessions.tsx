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
    if (!selectedId) { setTurns([]); setSessionMeta(null); setPlanContent(null); setTurnPage(0); return; }
    setTurnPage(0);
    setDetailLoading(true);

    if (detailTab === 'chat') {
      if (selectedType === 'headless' && selectedAgentName) {
        // Headless agent — use /api/agents/:id/messages and normalize to Turn[]
        api.getAgentMessages(selectedAgentName)
          .then(data => {
            const msgs = data?.messages || [];
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
            setTurns(normalized);
            setSessionMeta({ id: selectedId, summary: selectedAgentName + ' (headless)', branch: '', created_at: '', updated_at: '' });
          })
          .catch(() => { setTurns([]); setSessionMeta(null); })
          .finally(() => setDetailLoading(false));
      } else {
        // Pane agent — use existing conversation endpoint
        Promise.all([
          api.getConversation(selectedId),
          api.getConversationSummary(selectedId),
        ])
          .then(([t, s]) => { setTurns(t); setSessionMeta(s); })
          .catch(() => { setTurns([]); setSessionMeta(null); })
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

  return (
    <div className="flex gap-4 h-[calc(100vh-5.5rem)]">
      {/* Left panel — session list */}
      <div className="w-[320px] shrink-0 flex flex-col border-r border-border pr-3">
        <div className="mb-3">
          <input type="text" value={search} onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search sessions…"
            className="w-full input-m3 px-4 py-2.5 text-xs text-fg placeholder-fg-2/40 outline-none transition-colors" />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 mb-3">
          <button className={`text-xs px-3 py-1.5 rounded-md transition-colors ${filter === 'all' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg-1 hover:bg-bg-1'}`}
            onClick={() => setFilter('all')}>All ({allSessions.length})</button>
          <button className={`text-xs px-3 py-1.5 rounded-md transition-colors ${filter === 'unregistered' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg-1 hover:bg-bg-1'}`}
            onClick={() => setFilter('unregistered')}>Unregistered ({orphaned.length})</button>
        </div>

        {loading ? (
          <div className="space-y-2 px-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="card-surface p-3" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ width: '50%', height: 12, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                <div style={{ width: '80%', height: 10, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                <div style={{ width: '35%', height: 10, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {displaySessions.map(s => {
              const conv = convLookup.get(s.id);
              const displaySummary = s.summary || conv?.summary;
              return (
                <div key={s.id}
                  className="p-3 cursor-pointer rounded-lg transition-all relative hover:bg-bg-1"
                  style={{
                    background: selectedId === s.id ? 'rgba(59,130,246,0.08)' : undefined,
                  }}
                  onClick={() => {
                    setSelectedId(s.id);
                    const matchAgent = agents.find(a => a.sessionId === s.id);
                    setSelectedType(matchAgent?.type === 'headless' || s.type === 'headless' ? 'headless' : 'pane');
                    setSelectedAgentName(matchAgent?.name || s.agentName || null);
                    setDetailTab('chat');
                    setTurnPage(0);
                  }}>
                  <div className="flex items-center justify-between mb-1">
                    {selectedId === s.id && (
                      <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, borderRadius: 99, background: '#3b82f6' }} />
                    )}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {s.agentName
                        ? <span className="badge text-blue-400/80 bg-blue-400/8 font-medium truncate">{s.agentName}</span>
                        : <span className="text-[10px] text-fg-2/30 px-1.5 py-0.5 rounded border border-dashed border-border">anon</span>}
                      {s.type === 'headless' && (
                        <span className="badge text-cyan-400/70 bg-cyan-400/8">⚡</span>
                      )}
                      {s.checkpoints.length > 0 && (
                        <span className="text-[10px] text-fg-2/40 flex-shrink-0">{s.checkpoints.length} ckpt</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <RegisterButton session={s} onRegistered={loadSessions} />
                      <span className="text-[10px] text-fg-2/30" title={new Date(s.lastModified).toLocaleString()}>
                        {relativeTime(s.lastModified)}
                      </span>
                    </div>
                  </div>
                  {displaySummary && displaySummary !== 'Start Conversation' && displaySummary.length > 3 && !/^[\-|─\s]+$/.test(displaySummary) && (
                    <p className="text-xs text-fg-1 truncate leading-snug">{displaySummary}</p>
                  )}
                </div>
              );
            })}
            {displaySessions.length === 0 && (
              <div className="text-center py-12 text-fg-2 text-xs">
                <span className="text-2xl block mb-3 opacity-30">↻</span>
                <p>{filter === 'unregistered' ? 'No unregistered sessions' : 'No sessions found'}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right panel — detail (chat or plan) */}
      <div className="flex-1 flex flex-col min-w-0 card-surface overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-fg-2 text-xs">
            <div className="text-center">
              <span className="text-3xl block mb-3 opacity-20">💬</span>
              <p>Select a session to view conversation</p>
            </div>
          </div>
        ) : (
          <div key={selectedId} className="flex-1 flex flex-col min-h-0 animate-fade-in">
            {/* Header with chat/plan toggle */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="min-w-0 flex-1 mr-3">
                <button
                  onClick={() => { setSelectedId(null); setSelectedType(null); setSelectedAgentName(null); }}
                  style={{ background: 'none', border: 'none', color: 'var(--color-fg-1)', cursor: 'pointer', fontSize: '0.75rem', padding: '0 0 0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                >
                  ← Back to sessions
                </button>
                <h3 className="text-sm font-medium truncate">
                  {(() => {
                    const raw = sessionMeta?.summary || sessionLookup.get(selectedId)?.summary || '';
                    const cleaned = (raw && raw.length > 3 && !/^[\-|─\s]+$/.test(raw) && raw !== 'Start Conversation') ? raw : '';
                    return cleaned || selectedAgentName || selectedId.slice(0, 24);
                  })()}
                  {selectedType === 'headless' && (
                    <span className="badge text-cyan-400/70 bg-cyan-400/8 ml-2">⚡ headless</span>
                  )}
                </h3>
                <div className="flex items-center gap-3 mt-1">
                  {sessionMeta?.branch && (
                    <span className="text-[11px] text-fg-2 font-mono">⎇ {sessionMeta.branch}</span>
                  )}
                  {sessionMeta?.created_at && (
                    <span className="text-[11px] text-fg-2/60">{new Date(sessionMeta.created_at).toLocaleString()}</span>
                  )}
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
                    <div className="flex items-center justify-center h-full text-xs text-fg-2">
                      {turnSearch ? 'No matching messages' : selectedAgentName ? 'Send a message to start chatting' : 'No conversation history'}
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
