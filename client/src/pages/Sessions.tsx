import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type CopilotSession, type AgentData } from '../lib/api';
import { MarkdownContent } from '../components/ChatMarkdown';
import { ThinkingBlock, ToolTimeline } from '../components/ChatWidgets';
import { useHeadlessChat, type ChatMessage } from '../hooks/useHeadlessChat';

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
export default function Sessions({ agents = [] }: Props) {
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
  const msgContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [turnPage, setTurnPage] = useState(0);

  // Headless chat via shared hook (connects only when selectedType === 'headless')
  const headlessAgent = selectedType === 'headless' ? selectedAgentName : null;
  const chat = useHeadlessChat(headlessAgent);

  // Bridge hook state to rendering variables used by the template
  const richMessages: ChatMessage[] | null = headlessAgent ? chat.messages : null;
  const liveIntent = chat.liveIntent;
  const wsConnected = chat.connected;
  const sending = chat.sending;

  // Chat input
  const [chatInput, setChatInput] = useState('');
  const chatInputRef = useRef<HTMLTextAreaElement>(null);


  // Send message handler
  const handleSendChat = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || !selectedAgentName) return;

    setChatInput('');

    if (selectedType === 'headless') {
      // Hook handles user message creation, WS send, and streaming
      chat.send(text);
    } else {
      // Pane agent — add Turn entry and relay via REST
      const newTurn: Turn = {
        turn_index: turns.length,
        user_message: text,
        assistant_response: '',
        timestamp: new Date().toISOString(),
      };
      setTurns(prev => [...prev, newTurn]);

      try {
        await api.sendMessage(selectedAgentName, text, 'you');
        setTurns(prev => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [...prev.slice(0, -1), { ...last, assistant_response: '*(message relayed via psmux \u2014 check agent pane for response)*' }];
        });
      } catch (err: any) {
        setTurns(prev => {
          const last = prev[prev.length - 1];
          if (!last) return prev;
          return [...prev.slice(0, -1), { ...last, assistant_response: `\u26a0\ufe0f Relay failed: ${err.message}` }];
        });
      }
    }
  }, [chatInput, selectedAgentName, selectedType, turns.length, chat]);

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

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) { setTurns([]); setSessionMeta(null); setPlanContent(null); setTurnPage(0); setLoadError(null); return; }
    setTurnPage(0);
    setDetailLoading(true);
    setLoadError(null);

    if (detailTab === 'chat') {
      if (selectedType === 'headless' && selectedAgentName) {
        // Headless agent — hook handles live WS + history loading.
        // Also load normalized Turn[] as fallback, and try session-store.db for old sessions.
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

  // Scroll to bottom on new turns or rich messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, richMessages]);

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
    <div className="flex gap-4 -mx-4 md:-mx-8 -mt-6 md:-mt-8 -mb-6 md:-mb-8 px-4 md:px-8 pt-6 md:pt-8" style={{ height: 'calc(100vh - 57px)' }}>
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
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: 'var(--color-bg)', borderRadius: 'var(--shape-lg)' }}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center" style={{ maxWidth: 320 }}>
              <div style={{ fontSize: '3rem', marginBottom: 16, opacity: 0.12 }}>💬</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-fg)', marginBottom: 6 }}>
                {liveAgentSessions.length > 0 ? 'Select an agent to chat' : 'Select a session'}
              </p>
              <p style={{ fontSize: 13, color: 'var(--color-fg-2)', lineHeight: 1.6 }}>
                {liveAgentSessions.length > 0
                  ? 'Pick a live agent from the sidebar to start a conversation'
                  : 'Pick a session from the sidebar to view its history, or spawn agents from the Dashboard'}
              </p>
            </div>
          </div>
        ) : (
          <div key={selectedId} className="flex-1 flex flex-col min-h-0 animate-fade-in">
            {/* ── Minimal Header ── */}
            <div className="flex items-center justify-between px-6 shrink-0" style={{ height: 52, borderBottom: '1px solid var(--color-border)' }}>
              <div className="flex items-center gap-3 min-w-0">
                {(() => {
                  const agent = agents.find(a => a.sessionId === selectedId || a.name === selectedAgentName);
                  const isLive = agent && (agent.status === 'running' || agent.status === 'idle');
                  const dotColor = !agent ? 'var(--color-fg-2)' : agent.status === 'running' ? '#22c55e' : agent.status === 'idle' ? '#eab308' : 'var(--color-fg-2)';
                  return (
                    <>
                      <span style={{
                        width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                        background: dotColor, opacity: isLive ? 1 : 0.25,
                        boxShadow: isLive ? `0 0 6px ${dotColor}` : 'none',
                        animation: agent?.status === 'running' ? 'pulse 2s infinite' : 'none',
                      }} />
                      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-fg)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedAgentName || (() => {
                          const raw = sessionMeta?.summary || sessionLookup.get(selectedId)?.summary || '';
                          const cleaned = (raw && raw.length > 3 && !/^[\-|─\s]+$/.test(raw) && raw !== 'Start Conversation') ? raw : '';
                          return cleaned || selectedId.slice(0, 24);
                        })()}
                      </h3>
                      {selectedType === 'headless' && (
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-full)', background: 'rgba(34,211,238,0.06)', color: 'rgba(34,211,238,0.6)', fontWeight: 500, flexShrink: 0 }}>headless</span>
                      )}
                      {selectedType === 'headless' ? (
                        wsConnected
                          ? <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-full)', background: 'rgba(34,197,94,0.06)', color: 'rgba(34,197,94,0.7)', fontWeight: 500, flexShrink: 0 }}>connected</span>
                          : <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-full)', background: 'rgba(245,158,11,0.08)', color: 'rgba(245,158,11,0.7)', fontWeight: 500, flexShrink: 0 }}>reconnecting…</span>
                      ) : isLive && (
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--shape-full)', background: 'rgba(34,197,94,0.06)', color: 'rgba(34,197,94,0.7)', fontWeight: 500, flexShrink: 0 }}>connected</span>
                      )}
                      {sessionMeta?.branch && (
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-fg-2)', opacity: 0.5, flexShrink: 0 }}>⎇ {sessionMeta.branch}</span>
                      )}
                    </>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Chat / Plan segmented control */}
                <div style={{ display: 'inline-flex', borderRadius: 'var(--shape-full)', background: 'var(--color-bg-2)', padding: 2 }}>
                  {(['chat', 'plan'] as const).map(tab => (
                    <button key={tab} onClick={() => setDetailTab(tab)} style={{
                      fontSize: 12, fontWeight: detailTab === tab ? 600 : 400, padding: '5px 14px',
                      borderRadius: 'var(--shape-full)', border: 'none', cursor: 'pointer',
                      background: detailTab === tab ? 'var(--color-bg)' : 'transparent',
                      color: detailTab === tab ? 'var(--color-fg)' : 'var(--color-fg-2)',
                      boxShadow: detailTab === tab ? 'var(--elevation-1)' : 'none',
                      transition: 'all var(--duration-short) var(--ease-standard)',
                    }}>
                      {tab === 'chat' ? '💬 Chat' : '📋 Plan'}
                    </button>
                  ))}
                </div>
                {detailTab === 'chat' && (
                  <>
                    <span style={{ fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.5 }}>{turns.length} turns</span>
                    <button
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
                        a.href = url; a.download = `session-${selectedId}.md`; a.click();
                        URL.revokeObjectURL(url);
                      }}
                      title="Export as Markdown"
                      aria-label="Export conversation"
                      style={{ width: 32, height: 32, borderRadius: 'var(--shape-full)', border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-fg-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, transition: 'all var(--duration-short) var(--ease-standard)' }}
                    >📥</button>
                  </>
                )}
              </div>
            </div>

            {/* ── Content ── */}
            {detailLoading ? (
              <div className="flex-1 flex flex-col gap-6 p-8" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ width: '30%', height: 12, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                      <div style={{ width: i % 2 === 0 ? '85%' : '60%', height: 12, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : detailTab === 'chat' ? (
              /* ── Chat View ── */
              <div className="flex-1 flex flex-col min-h-0" style={{ position: 'relative' }}>
                {/* Pagination */}
                {totalPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '6px 16px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
                    <button disabled={turnPage === 0} onClick={() => setTurnPage(p => p - 1)}
                      style={{ fontSize: 12, padding: '4px 12px', borderRadius: 'var(--shape-full)', border: '1px solid var(--color-border)', background: 'var(--color-bg-2)', color: 'var(--color-fg-2)', cursor: turnPage === 0 ? 'not-allowed' : 'pointer', opacity: turnPage === 0 ? 0.3 : 1, transition: 'all var(--duration-short) var(--ease-standard)' }}>
                      ← Prev
                    </button>
                    <span style={{ fontSize: 12, color: 'var(--color-fg-2)', opacity: 0.6 }}>
                      {turnPage + 1} / {totalPages}
                    </span>
                    <button disabled={turnPage >= totalPages - 1} onClick={() => setTurnPage(p => p + 1)}
                      style={{ fontSize: 12, padding: '4px 12px', borderRadius: 'var(--shape-full)', border: '1px solid var(--color-border)', background: 'var(--color-bg-2)', color: 'var(--color-fg-2)', cursor: turnPage >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: turnPage >= totalPages - 1 ? 0.3 : 1, transition: 'all var(--duration-short) var(--ease-standard)' }}>
                      Next →
                    </button>
                  </div>
                )}

                {/* Messages */}
                <div
                  ref={msgContainerRef}
                  className="flex-1 overflow-y-auto"
                  style={{ scrollBehavior: 'smooth' }}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                    setShowScrollBtn(fromBottom > 200);
                  }}
                >
                  <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 24px 16px' }}>
                    {paginatedTurns.length === 0 && (!richMessages || richMessages.length === 0) ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 8 }}>
                        {loadError ? (
                          <>
                            <span style={{ fontSize: '2rem', opacity: 0.3 }}>⚠️</span>
                            <span style={{ fontSize: 13, color: 'var(--color-fg-2)' }}>{loadError}</span>
                            <button
                              onClick={() => { setLoadError(null); setDetailLoading(true); const id = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(id), 50); }}
                              style={{ fontSize: 12, padding: '6px 16px', marginTop: 4, borderRadius: 'var(--shape-full)', background: 'var(--accent-dim)', color: 'var(--accent)', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
                              Retry
                            </button>
                          </>
                        ) : (
                          <>
                            <span style={{ fontSize: '2.5rem', opacity: 0.1 }}>💬</span>
                            <span style={{ fontSize: 13, color: 'var(--color-fg-2)', opacity: 0.6 }}>
                              {turnSearch ? 'No matching messages' : selectedAgentName ? 'Send a message to start chatting' : 'No conversation history'}
                            </span>
                          </>
                        )}
                      </div>
                    ) : richMessages ? (
                      /* ── Rich message rendering (headless agents) ── */
                      <>
                        {richMessages.map((msg, i) => (
                          <div key={msg.id}>
                            {msg.role === 'user' && (
                              <div style={{
                                display: 'flex', gap: 14, padding: '20px 0',
                                borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)' : 'none',
                              }}>
                                <div style={{
                                  width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                                  background: 'var(--accent-dim)', color: 'var(--accent)',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 14, fontWeight: 700, marginTop: 2,
                                }}>Y</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-fg)' }}>You</span>
                                    <span style={{ fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.5 }}>
                                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                  <pre style={{
                                    fontSize: 14, lineHeight: 1.65, color: 'var(--color-fg)',
                                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                    fontFamily: 'inherit', margin: 0,
                                  }}>
                                    {truncateUser(msg.text)}
                                  </pre>
                                </div>
                              </div>
                            )}

                            {msg.role === 'agent' && (
                              <div style={{
                                display: 'flex', gap: 14,
                                borderTop: '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)',
                                background: 'color-mix(in srgb, var(--color-bg-2) 30%, transparent)',
                                margin: '0 -24px', padding: '20px 24px',
                                borderRadius: 'var(--shape-md)',
                              }}>
                                <div style={{
                                  width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                                  background: 'color-mix(in srgb, var(--color-fg-2) 12%, transparent)',
                                  color: 'var(--color-fg-2)',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 14, marginTop: 2,
                                }}>✦</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-fg)' }}>
                                      {selectedAgentName || 'Assistant'}
                                    </span>
                                    <span style={{ fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.5 }}>
                                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    {msg.intent && (
                                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 'var(--shape-full)', background: 'rgba(99,102,241,0.08)', color: 'rgba(99,102,241,0.7)', fontWeight: 500 }}>
                                        {msg.intent}
                                      </span>
                                    )}
                                  </div>
                                  {msg.thinking && (
                                    <ThinkingBlock text={msg.thinking} isStreaming={!!msg.streaming && !msg.text} hasResponse={!!msg.text} />
                                  )}
                                  {msg.tools && msg.tools.length > 0 && (
                                    <ToolTimeline tools={msg.tools} />
                                  )}
                                  {msg.text && (
                                    <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-fg)' }} className="prose-chat">
                                      <MarkdownContent content={msg.text} />
                                    </div>
                                  )}
                                  {(msg.tokens || msg.usage) && (
                                    <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 10, color: 'var(--color-fg-2)', opacity: 0.4 }}>
                                      {msg.tokens && <span>{msg.tokens.toLocaleString()} tokens</span>}
                                      {msg.usage?.model && <span>· {msg.usage.model}</span>}
                                      {msg.usage?.cost != null && <span>· ${msg.usage.cost.toFixed(4)}</span>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                        {/* Live intent indicator */}
                        {sending && liveIntent && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12, color: 'var(--color-fg-2)', opacity: 0.6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1.4s ease-in-out infinite' }} />
                            {liveIntent}
                          </div>
                        )}
                      </>
                    ) : (
                      paginatedTurns.map((turn, i) => (
                        <div key={turn.turn_index}>
                          {/* ── User message ── */}
                          {turn.user_message && (
                            <div style={{
                              display: 'flex', gap: 14, padding: '20px 0',
                              borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)' : 'none',
                            }}>
                              {/* Avatar */}
                              <div style={{
                                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                                background: 'var(--accent-dim)', color: 'var(--accent)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 14, fontWeight: 700, marginTop: 2,
                              }}>Y</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-fg)' }}>You</span>
                                  <span style={{ fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.5 }}>
                                    {turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                  </span>
                                </div>
                                <pre style={{
                                  fontSize: 14, lineHeight: 1.65, color: 'var(--color-fg)',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                  fontFamily: 'inherit', margin: 0,
                                }}>
                                  {truncateUser(turn.user_message)}
                                </pre>
                              </div>
                            </div>
                          )}

                          {/* ── Assistant message ── */}
                          {turn.assistant_response && (
                            <div style={{
                              display: 'flex', gap: 14,
                              borderTop: turn.user_message ? '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)' : (i > 0 ? '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)' : 'none'),
                              background: 'color-mix(in srgb, var(--color-bg-2) 30%, transparent)',
                              margin: '0 -24px', padding: '20px 24px',
                              borderRadius: 'var(--shape-md)',
                            }}>
                              {/* Avatar */}
                              <div style={{
                                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                                background: 'color-mix(in srgb, var(--color-fg-2) 12%, transparent)',
                                color: 'var(--color-fg-2)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 14, marginTop: 2,
                              }}>✦</div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-fg)' }}>
                                    {selectedAgentName || 'Assistant'}
                                  </span>
                                  <span style={{ fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.5 }}>
                                    {turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                  </span>
                                </div>
                                {/* Thinking section (collapsible) */}
                                {turn.assistant_response.startsWith('> 💭 **thinking**') && (() => {
                                  const thinkEnd = turn.assistant_response.indexOf('\n\n---\n\n');
                                  if (thinkEnd === -1) return null;
                                  const thinkingRaw = turn.assistant_response.slice(0, thinkEnd).replace(/^> 💭 \*\*thinking\*\*\n>\n/m, '').replace(/^> /gm, '');
                                  const rest = turn.assistant_response.slice(thinkEnd + 7);
                                  return (
                                    <>
                                      <details style={{ marginBottom: 12 }}>
                                        <summary style={{
                                          fontSize: 12, color: 'var(--color-fg-2)', cursor: 'pointer',
                                          padding: '6px 10px', borderRadius: 'var(--shape-sm)',
                                          background: 'color-mix(in srgb, var(--color-fg-2) 5%, transparent)',
                                          display: 'inline-flex', alignItems: 'center', gap: 6,
                                          userSelect: 'none', listStyle: 'none',
                                        }}>
                                          <span style={{ fontSize: 13 }}>🧠</span> Thinking…
                                        </summary>
                                        <div style={{
                                          fontSize: 13, lineHeight: 1.6, color: 'var(--color-fg-2)',
                                          padding: '10px 12px', marginTop: 6,
                                          borderLeft: '2px solid color-mix(in srgb, var(--color-fg-2) 15%, transparent)',
                                          whiteSpace: 'pre-wrap', fontStyle: 'italic',
                                        }}>
                                          {thinkingRaw}
                                        </div>
                                      </details>
                                      <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-fg)' }} className="prose-chat">
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rest}</ReactMarkdown>
                                      </div>
                                    </>
                                  );
                                })() || (
                                  <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-fg)' }} className="prose-chat">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.assistant_response}</ReactMarkdown>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      ))
                    )}

                    {/* Streaming indicator */}
                    {sending && (
                      <div style={{
                        display: 'flex', gap: 14,
                        borderTop: '1px solid color-mix(in srgb, var(--color-border) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--color-bg-2) 30%, transparent)',
                        margin: '0 -24px', padding: '20px 24px',
                        borderRadius: 'var(--shape-md)',
                      }}>
                        <div style={{
                          width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                          background: 'color-mix(in srgb, var(--color-fg-2) 12%, transparent)',
                          color: 'var(--color-fg-2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 14,
                        }}>✦</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6 }}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {[0, 1, 2].map(j => (
                              <span key={j} style={{
                                width: 6, height: 6, borderRadius: '50%',
                                background: 'var(--accent)',
                                opacity: 0.5,
                                animation: `pulse 1.4s ease-in-out ${j * 0.2}s infinite`,
                              }} />
                            ))}
                          </div>
                          <span style={{ fontSize: 13, color: 'var(--color-fg-2)' }}>Thinking…</span>
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </div>

                {/* Scroll-to-bottom FAB */}
                {showScrollBtn && (
                  <button
                    onClick={() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
                    aria-label="Scroll to bottom"
                    style={{
                      position: 'absolute', bottom: selectedAgentName ? 100 : 20, right: 24,
                      width: 36, height: 36, borderRadius: '50%',
                      background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                      boxShadow: 'var(--elevation-2)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 16, color: 'var(--color-fg-2)',
                      transition: 'all var(--duration-medium) var(--ease-emphasized-decel)',
                      zIndex: 10,
                    }}
                  >↓</button>
                )}

                {/* ── Chat Input ── */}
                {selectedAgentName && (
                  <div style={{
                    flexShrink: 0, padding: '12px 24px 16px',
                    background: 'var(--color-bg)',
                  }}>
                    <div style={{ maxWidth: 720, margin: '0 auto' }}>
                      <div style={{
                        display: 'flex', alignItems: 'flex-end', gap: 0,
                        background: 'var(--color-bg-2)', border: '1px solid var(--color-border)',
                        borderRadius: 'var(--shape-xl)',
                        padding: '4px 4px 4px 16px',
                        boxShadow: 'var(--elevation-1)',
                        transition: 'border-color var(--duration-short) var(--ease-standard), box-shadow var(--duration-short) var(--ease-standard)',
                      }}>
                        <textarea
                          ref={chatInputRef}
                          style={{
                            flex: 1, background: 'transparent', border: 'none', outline: 'none',
                            fontSize: 14, lineHeight: 1.5, color: 'var(--color-fg)',
                            resize: 'none', minHeight: 24, maxHeight: 140,
                            padding: '8px 0', fontFamily: 'inherit',
                          }}
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
                            t.style.height = Math.min(t.scrollHeight, 140) + 'px';
                          }}
                          onFocus={() => {
                            const container = chatInputRef.current?.parentElement;
                            if (container) container.style.borderColor = 'var(--accent)';
                          }}
                          onBlur={() => {
                            const container = chatInputRef.current?.parentElement;
                            if (container) container.style.borderColor = 'var(--color-border)';
                          }}
                        />
                        <button
                          onClick={handleSendChat}
                          disabled={sending || !chatInput.trim()}
                          aria-label="Send message"
                          style={{
                            width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
                            flexShrink: 0,
                            background: chatInput.trim() ? 'var(--accent)' : 'transparent',
                            color: chatInput.trim() ? '#fff' : 'var(--color-fg-2)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 16, fontWeight: 700,
                            opacity: sending ? 0.4 : 1,
                            transition: 'all var(--duration-medium) var(--ease-emphasized-decel)',
                          }}
                        >
                          {sending ? '⏳' : '↑'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 8px 0', fontSize: 11, color: 'var(--color-fg-2)', opacity: 0.35 }}>
                        <span>Enter to send · Shift+Enter for newline</span>
                        <span>{selectedType === 'headless' ? '⚡ headless' : '📺 relay'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Plan view */
              <div className="flex-1 overflow-auto" style={{ padding: '24px 32px' }}>
                <div style={{ maxWidth: 720, margin: '0 auto' }}>
                  <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-fg-1)' }} className="prose-chat">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent || '(No plan found)'}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
