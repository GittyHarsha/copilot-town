import { useState, useEffect, useRef, useCallback } from 'react';
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
      className="text-[10px] px-2 py-0.5 rounded border border-dashed border-blue/40 text-blue/70 hover:border-blue hover:text-blue transition-colors"
      onClick={e => { e.stopPropagation(); setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
    >
      {session.agentName ? 'rename' : '+ register'}
    </button>
  );

  return (
    <form onSubmit={submit} onClick={e => e.stopPropagation()} className="flex items-center gap-1">
      <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
        className="text-[10px] bg-bg-2 border border-blue/50 rounded px-1.5 py-0.5 text-fg outline-none w-32"
        placeholder="agent name" disabled={saving} />
      <button type="submit" disabled={saving}
        className="text-[10px] px-1.5 py-0.5 rounded bg-blue/20 text-blue hover:bg-blue/30 transition-colors">
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
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Selection & detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'chat' | 'plan'>('chat');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionEntry | null>(null);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [turnSearch, setTurnSearch] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

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
    if (sid) { setSelectedId(sid); setDetailTab('chat'); }
  }, [initialAgent, agents, convSessions]);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) { setTurns([]); setSessionMeta(null); setPlanContent(null); return; }
    setDetailLoading(true);

    if (detailTab === 'chat') {
      Promise.all([
        api.getConversation(selectedId),
        api.getConversationSummary(selectedId),
      ])
        .then(([t, s]) => { setTurns(t); setSessionMeta(s); })
        .catch(() => { setTurns([]); setSessionMeta(null); })
        .finally(() => setDetailLoading(false));
    } else {
      api.getSessionPlan(selectedId)
        .then(({ plan }) => setPlanContent(plan))
        .catch(() => setPlanContent('(No plan found)'))
        .finally(() => setDetailLoading(false));
    }
  }, [selectedId, detailTab]);

  // Scroll to bottom on new turns
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const filteredTurns = turnSearch
    ? turns.filter(t =>
        t.user_message?.toLowerCase().includes(turnSearch.toLowerCase()) ||
        t.assistant_response?.toLowerCase().includes(turnSearch.toLowerCase()))
    : turns;

  const truncateUser = (text: string, max = 3000) =>
    text && text.length > max ? text.slice(0, max) + '…' : text;

  // Build unified session list — merge CopilotSession metadata with conversation entries
  const displaySessions = filter === 'unregistered' ? orphaned : sessions;

  // Lookup: session id → CopilotSession (for registration info)
  const sessionLookup = new Map<string, CopilotSession>();
  for (const s of sessions) sessionLookup.set(s.id, s);
  for (const s of orphaned) sessionLookup.set(s.id, s);

  // Lookup: session id → conversation entry (for summary, branch)
  const convLookup = new Map<string, SessionEntry>();
  for (const s of convSessions) convLookup.set(s.id, s);

  return (
    <div className="flex gap-4 h-[calc(100vh-5rem)]">
      {/* Left panel — session list */}
      <div className="w-[300px] shrink-0 flex flex-col border-r border-border pr-3">
        <div className="mb-3">
          <input type="text" value={search} onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search sessions…"
            className="w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-xs text-fg placeholder-fg-2/40 outline-none focus:border-border-1" />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-4 mb-3 border-b border-border pb-2">
          <button className={`text-[10px] pb-0.5 transition-colors ${filter === 'all' ? 'text-fg border-b border-blue' : 'text-fg-2 hover:text-fg-1'}`}
            onClick={() => setFilter('all')}>All ({sessions.length})</button>
          <button className={`text-[10px] pb-0.5 transition-colors ${filter === 'unregistered' ? 'text-fg border-b border-blue' : 'text-fg-2 hover:text-fg-1'}`}
            onClick={() => setFilter('unregistered')}>Unregistered ({orphaned.length})</button>
        </div>

        {loading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-bg-1 rounded animate-pulse" />
          ))}</div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1">
            {displaySessions.map(s => {
              const conv = convLookup.get(s.id);
              const displaySummary = s.summary || conv?.summary;
              return (
                <div key={s.id}
                  className={`bg-bg-1 border rounded-lg p-2.5 cursor-pointer transition-colors ${
                    selectedId === s.id ? 'border-blue/50 bg-blue/5' : 'border-border hover:border-border-1'}`}
                  onClick={() => { setSelectedId(s.id); setDetailTab('chat'); }}>
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {s.agentName
                        ? <span className="text-[10px] bg-blue/10 text-blue px-1.5 py-0.5 rounded font-medium truncate">{s.agentName}</span>
                        : <span className="text-[10px] text-fg-2/40 px-1 py-0.5 rounded border border-dashed border-border">anon</span>}
                      {s.checkpoints.length > 0 && (
                        <span className="text-[9px] text-fg-2/50 flex-shrink-0">{s.checkpoints.length} ckpt</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <RegisterButton session={s} onRegistered={loadSessions} />
                      <span className="text-[9px] text-fg-2/40" title={new Date(s.lastModified).toLocaleString()}>
                        {relativeTime(s.lastModified)}
                      </span>
                    </div>
                  </div>
                  {displaySummary && displaySummary !== 'Start Conversation' && (
                    <p className="text-[10px] text-fg-1 truncate leading-snug">{displaySummary}</p>
                  )}
                  {s.cwd && <p className="text-[9px] font-mono text-fg-2/40 truncate mt-0.5">{s.cwd}</p>}
                  <div className="text-[9px] font-mono text-fg-2/25 truncate mt-0.5">{s.id}</div>
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
      <div className="flex-1 flex flex-col min-w-0 bg-bg-1 border border-border rounded-lg overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-fg-2 text-xs">
            <div className="text-center">
              <span className="text-2xl block mb-2 opacity-30">💬</span>
              <p>Select a session to view conversation or plan</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header with chat/plan toggle */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
              <div className="min-w-0 flex-1 mr-3">
                <h3 className="text-xs font-medium truncate">
                  {sessionMeta?.summary || sessionLookup.get(selectedId)?.summary || selectedId.slice(0, 24)}
                </h3>
                <div className="flex items-center gap-3 mt-0.5">
                  {sessionMeta?.branch && (
                    <span className="text-[10px] text-fg-2 font-mono">⎇ {sessionMeta.branch}</span>
                  )}
                  {sessionMeta?.created_at && (
                    <span className="text-[10px] text-fg-2">{new Date(sessionMeta.created_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Chat / Plan toggle */}
                <div className="flex bg-bg rounded border border-border overflow-hidden">
                  <button className={`text-[10px] px-2.5 py-1 transition-colors ${detailTab === 'chat' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
                    onClick={() => setDetailTab('chat')}>💬 Chat</button>
                  <button className={`text-[10px] px-2.5 py-1 transition-colors ${detailTab === 'plan' ? 'bg-bg-2 text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
                    onClick={() => setDetailTab('plan')}>📋 Plan</button>
                </div>
                {detailTab === 'chat' && (
                  <>
                    <input type="text" value={turnSearch} onChange={e => setTurnSearch(e.target.value)}
                      placeholder="Filter…"
                      className="bg-bg border border-border rounded px-2 py-1 text-[10px] text-fg placeholder-fg-2/40 outline-none focus:border-border-1 w-28" />
                    <span className="text-[10px] text-fg-2 tabular-nums">{filteredTurns.length}t</span>
                  </>
                )}
              </div>
            </div>

            {/* Content */}
            {detailLoading ? (
              <div className="flex-1 p-4 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className={`h-16 rounded-lg animate-pulse ${i % 2 === 0 ? 'bg-blue/5 ml-auto w-3/4' : 'bg-bg-2 w-3/4'}`} />
                ))}
              </div>
            ) : detailTab === 'chat' ? (
              /* Chat view */
              <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
                {filteredTurns.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-xs text-fg-2">
                    {turnSearch ? 'No matching messages' : 'No conversation history'}
                  </div>
                ) : (
                  filteredTurns.map(turn => (
                    <div key={turn.turn_index} className="space-y-2">
                      {turn.user_message && (
                        <div className="flex justify-end">
                          <div className="max-w-[75%]">
                            <div className="bg-blue/10 border border-blue/20 rounded-lg px-3 py-2">
                              <pre className="text-[11px] text-fg whitespace-pre-wrap break-words font-sans leading-relaxed">
                                {truncateUser(turn.user_message)}
                              </pre>
                            </div>
                            <p className="text-[9px] text-fg-2/40 mt-0.5 text-right tabular-nums">
                              #{turn.turn_index} · {turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : ''}
                            </p>
                          </div>
                        </div>
                      )}
                      {turn.assistant_response && (
                        <div className="flex justify-start">
                          <div className="max-w-[80%]">
                            <div className="bg-bg-2 border border-border rounded-lg px-3 py-2">
                              <div className="text-[11px] text-fg-1 leading-relaxed">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {turn.assistant_response}
                                </ReactMarkdown>
                              </div>
                            </div>
                            <p className="text-[9px] text-fg-2/40 mt-0.5 tabular-nums">
                              assistant · #{turn.turn_index}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
            ) : (
              /* Plan view */
              <div className="flex-1 overflow-auto p-4">
                <pre className="text-[11px] font-mono text-fg-2 leading-relaxed whitespace-pre-wrap">
                  {planContent || '(No plan found)'}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
