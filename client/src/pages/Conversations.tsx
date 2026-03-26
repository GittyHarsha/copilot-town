import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentData } from '../lib/api';
import { api } from '../lib/api';

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

export default function Conversations({ agents, initialAgent }: Props) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionMeta, setSessionMeta] = useState<SessionEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [turnSearch, setTurnSearch] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Load sessions on mount
  useEffect(() => {
    api.getSessionList(undefined, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

  // Auto-select from initialAgent (can be agent id or name)
  useEffect(() => {
    if (!initialAgent || sessions.length === 0) return;
    const agent = agents.find(a => a.id === initialAgent || a.name === initialAgent);
    const sid = agent?.sessionId;
    if (sid && sessions.some(s => s.id === sid)) {
      setSelectedSession(sid);
    }
  }, [initialAgent, agents, sessions]);

  // Search sessions with debounce
  const doSearch = useCallback((q: string) => {
    setLoading(true);
    api.getSessionList(q || undefined, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

  const handleSearchChange = useCallback((val: string) => {
    setSearch(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(val), 300);
  }, [doSearch]);

  // Load turns when session selected
  useEffect(() => {
    if (!selectedSession) { setTurns([]); setSessionMeta(null); return; }
    setTurnsLoading(true);
    Promise.all([
      api.getConversation(selectedSession),
      api.getConversationSummary(selectedSession),
    ])
      .then(([t, s]) => {
        setTurns(t);
        setSessionMeta(s);
      })
      .catch(() => { setTurns([]); setSessionMeta(null); })
      .finally(() => setTurnsLoading(false));
  }, [selectedSession]);

  // Scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const filteredTurns = turnSearch
    ? turns.filter(t =>
        t.user_message?.toLowerCase().includes(turnSearch.toLowerCase()) ||
        t.assistant_response?.toLowerCase().includes(turnSearch.toLowerCase())
      )
    : turns;

  const truncateUser = (text: string, max = 3000) =>
    text && text.length > max ? text.slice(0, max) + '…' : text;

  return (
    <div className="flex gap-4 h-[calc(100vh-5rem)]">
      {/* Left panel — session list */}
      <div className="w-[280px] shrink-0 flex flex-col border-r border-border pr-3">
        <div className="mb-3">
          <input
            type="text"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search sessions…"
            className="w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-xs text-fg placeholder-fg-2/40 outline-none focus:border-border-1"
          />
        </div>
        <p className="text-[10px] text-fg-2 uppercase tracking-wider mb-2 px-1">
          {loading ? 'Loading…' : `${sessions.length} sessions`}
        </p>

        <div className="flex-1 overflow-y-auto space-y-0.5">
          {sessions.map(s => (
            <button
              key={s.id}
              className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors ${
                selectedSession === s.id
                  ? 'bg-bg-2 text-fg border border-border-1'
                  : 'text-fg-1 hover:bg-bg-1 border border-transparent'
              }`}
              onClick={() => setSelectedSession(s.id)}
            >
              <p className="font-medium line-clamp-2 leading-snug">
                {s.summary || s.id.slice(0, 20)}
              </p>
              <div className="flex items-center gap-2 mt-1">
                {s.branch && (
                  <span className="text-[9px] text-fg-2/60 font-mono truncate max-w-[120px]">
                    ⎇ {s.branch}
                  </span>
                )}
                <span className="text-[9px] text-fg-2/40 ml-auto flex-shrink-0">
                  {relativeTime(s.updated_at || s.created_at)}
                </span>
              </div>
            </button>
          ))}
          {!loading && sessions.length === 0 && (
            <div className="text-center text-fg-2 py-8 text-xs">
              {search ? 'No matching sessions' : 'No sessions found'}
            </div>
          )}
        </div>
      </div>

      {/* Right panel — conversation viewer */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg-1 border border-border rounded-lg overflow-hidden">
        {!selectedSession ? (
          <div className="flex-1 flex items-center justify-center text-fg-2 text-xs">
            <div className="text-center">
              <span className="text-2xl block mb-2 opacity-30">💬</span>
              <p>Select a session to view conversation</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
              <div className="min-w-0 flex-1 mr-3">
                <h3 className="text-xs font-medium truncate">
                  {sessionMeta?.summary || selectedSession.slice(0, 24)}
                </h3>
                <div className="flex items-center gap-3 mt-0.5">
                  {sessionMeta?.branch && (
                    <span className="text-[10px] text-fg-2 font-mono">⎇ {sessionMeta.branch}</span>
                  )}
                  {sessionMeta?.created_at && (
                    <span className="text-[10px] text-fg-2">
                      {new Date(sessionMeta.created_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="text"
                  value={turnSearch}
                  onChange={e => setTurnSearch(e.target.value)}
                  placeholder="Filter turns…"
                  className="bg-bg border border-border rounded px-2 py-1 text-[11px] text-fg placeholder-fg-2/40 outline-none focus:border-border-1 w-36"
                />
                <span className="text-[10px] text-fg-2 tabular-nums">{filteredTurns.length} turns</span>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
              {turnsLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`h-16 rounded-lg animate-pulse ${i % 2 === 0 ? 'bg-blue/5 ml-auto w-3/4' : 'bg-bg-2 w-3/4'}`} />
                  ))}
                </div>
              ) : filteredTurns.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-fg-2">
                  {turnSearch ? 'No matching messages' : 'No conversation history'}
                </div>
              ) : (
                filteredTurns.map(turn => (
                  <div key={turn.turn_index} className="space-y-2">
                    {/* User message — right-aligned, blue */}
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
                    {/* Assistant response — left-aligned, gray, rendered as markdown */}
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
          </>
        )}
      </div>
    </div>
  );
}
