import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, type CopilotSession } from '../lib/api';
import { MarkdownContent, relativeTime } from '../components/ChatMarkdown';

/* ─── Types ───────────────────────────────────────────────── */

interface CheckpointDetail {
  number: number;
  title: string;
  filename: string;
  content: string;
}

interface SessionDetails {
  session: CopilotSession;
  plan: string | null;
  checkpoints: CheckpointDetail[];
}

/* ─── Helpers ─────────────────────────────────────────────── */

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  return relativeTime(new Date(dateStr).getTime());
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max).trimEnd() + '…';
}

/* ─── Component ───────────────────────────────────────────── */

export default function PlanViewer() {
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [planExpanded, setPlanExpanded] = useState(true);
  const [expandedCps, setExpandedCps] = useState<Set<number>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);

  // Load session list
  useEffect(() => {
    setListLoading(true);
    api.getSessions(100)
      .then(list => {
        setSessions(list);
        // Auto-select first session with a plan
        const first = list.find(s => s.hasPlan);
        if (first) setSelectedId(first.id);
      })
      .catch(() => {})
      .finally(() => setListLoading(false));
  }, []);

  // Load selected session details
  useEffect(() => {
    if (!selectedId) { setDetails(null); return; }
    setLoading(true);
    api.getSessionDetails(selectedId)
      .then((d: SessionDetails) => {
        setDetails(d);
        setExpandedCps(new Set());
        setAllExpanded(false);
        setPlanExpanded(true);
      })
      .catch(() => setDetails(null))
      .finally(() => setLoading(false));
  }, [selectedId]);

  // Filter sessions by search
  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(s =>
      (s.agentName?.toLowerCase().includes(q)) ||
      (s.summary?.toLowerCase().includes(q)) ||
      s.id.toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const toggleCheckpoint = useCallback((num: number) => {
    setExpandedCps(prev => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  }, []);

  const toggleAllCheckpoints = useCallback(() => {
    if (!details) return;
    if (allExpanded) {
      setExpandedCps(new Set());
      setAllExpanded(false);
    } else {
      setExpandedCps(new Set(details.checkpoints.map(c => c.number)));
      setAllExpanded(true);
    }
  }, [details, allExpanded]);

  return (
    <div className="flex h-[calc(100vh-60px)] overflow-hidden">
      {/* ── Left Panel: Session List ── */}
      <div className="w-[300px] min-w-[300px] bg-bg-1 border-r border-border flex flex-col">
        {/* Header */}
        <div className="px-3 py-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-fg">Sessions</h2>
            <span className="text-[10px] text-fg-2 bg-bg-2 px-1.5 py-0.5 rounded-md">
              {filtered.length}
            </span>
          </div>
          <input
            type="text"
            placeholder="Search sessions…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-[11px] bg-bg-2 border border-border rounded-lg px-2.5 py-1.5 text-fg placeholder:text-fg-2 outline-none focus:border-blue-500/40 transition-colors"
          />
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="flex items-center justify-center py-12 text-fg-2 text-[11px]">
              Loading sessions…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-fg-2 text-[11px]">
              {search ? 'No matching sessions' : 'No sessions found'}
            </div>
          ) : (
            filtered.map(s => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left px-3 py-2.5 border-l-2 transition-colors ${
                  selectedId === s.id
                    ? 'border-l-blue-500 bg-bg-2/50'
                    : 'border-l-transparent hover:bg-bg-2/30'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[11px] font-medium text-fg truncate">
                    {s.agentName || s.id.slice(0, 8)}
                  </span>
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    {s.hasPlan && (
                      <span className="text-[10px]" title="Has plan">📋</span>
                    )}
                    {s.checkpoints.length > 0 && (
                      <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded-full font-medium">
                        {s.checkpoints.length}
                      </span>
                    )}
                  </span>
                </div>
                <div className="text-[10px] text-fg-2 truncate leading-relaxed">
                  {truncate(s.summary || s.planSnippet || 'No summary', 80)}
                </div>
                <div className="text-[9px] text-fg-2/60 mt-0.5">
                  {timeAgo(s.lastModified)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right Panel: Detail View ── */}
      <div className="flex-1 overflow-y-auto bg-bg">
        {loading ? (
          <div className="flex items-center justify-center h-full text-fg-2 text-sm">
            <div className="flex flex-col items-center gap-2">
              <div className="w-5 h-5 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-[11px]">Loading session…</span>
            </div>
          </div>
        ) : !selectedId || !details ? (
          <div className="flex items-center justify-center h-full text-fg-2">
            <div className="text-center space-y-2">
              <div className="text-3xl opacity-40">📋</div>
              <p className="text-sm">Select a session to view its plan</p>
              <p className="text-[11px] text-fg-2/60">
                Choose from the list on the left
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-[900px] mx-auto px-6 py-5 space-y-6">
            {/* Header */}
            <div className="space-y-1">
              <h1 className="text-sm font-semibold text-fg">
                {details.session.agentName || details.session.id.slice(0, 12)}
              </h1>
              {details.session.summary && (
                <p className="text-[12px] text-fg-1 leading-relaxed">
                  {details.session.summary}
                </p>
              )}
              <div className="flex items-center gap-3 text-[10px] text-fg-2 pt-1">
                {details.session.cwd && (
                  <span className="flex items-center gap-1" title="Working directory">
                    <span className="opacity-60">📂</span>
                    <span className="font-mono truncate max-w-[300px]">{details.session.cwd}</span>
                  </span>
                )}
                <span className="opacity-40">·</span>
                <span>{timeAgo(details.session.lastModified)}</span>
                {details.session.isOrphaned && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="text-amber-400/80">orphaned</span>
                  </>
                )}
              </div>
            </div>

            <hr className="border-border" />

            {/* Plan Section */}
            {details.plan && (
              <div className="bg-bg-1 border border-border rounded-xl overflow-hidden">
                <button
                  onClick={() => setPlanExpanded(!planExpanded)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-2/30 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px]">📋</span>
                    <span className="text-xs font-semibold text-fg">Plan</span>
                  </div>
                  <span className={`text-fg-2 text-[10px] transition-transform ${planExpanded ? 'rotate-180' : ''}`}>
                    ▼
                  </span>
                </button>
                {planExpanded && (
                  <div className="px-4 pb-4 border-t border-border">
                    <div className="pt-3 prose-sm">
                      <MarkdownContent content={details.plan} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Checkpoints Section */}
            {details.checkpoints.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-fg">Checkpoints</span>
                    <span className="text-[10px] text-fg-2 bg-bg-2 px-1.5 py-0.5 rounded-md">
                      {details.checkpoints.length}
                    </span>
                  </div>
                  <button
                    onClick={toggleAllCheckpoints}
                    className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    {allExpanded ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>

                {/* Timeline */}
                <div className="relative pl-6">
                  {details.checkpoints.map((cp, i) => {
                    const isLast = i === details.checkpoints.length - 1;
                    const isExpanded = expandedCps.has(cp.number);
                    const isCurrent = isLast;
                    const dotColor = isCurrent
                      ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                      : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';

                    return (
                      <div key={cp.number} className="relative pb-4 last:pb-0">
                        {/* Vertical line */}
                        {!isLast && (
                          <div className="absolute left-[15px] top-8 bottom-0 w-0.5 bg-border" />
                        )}

                        {/* Dot + content */}
                        <div className="flex gap-3">
                          <div
                            className={`w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 text-[11px] font-semibold ${dotColor}`}
                          >
                            {cp.number}
                          </div>
                          <div className="flex-1 min-w-0">
                            <button
                              onClick={() => toggleCheckpoint(cp.number)}
                              className="w-full text-left bg-bg-1 border border-border rounded-xl px-4 py-2.5 hover:border-blue-500/20 transition-colors"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium text-fg">
                                  {cp.title}
                                </span>
                                <span className={`text-fg-2 text-[10px] transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                                  ▼
                                </span>
                              </div>
                            </button>
                            {isExpanded && cp.content && (
                              <div className="mt-2 bg-bg-1 border border-border rounded-xl px-4 py-3">
                                <MarkdownContent content={cp.content} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No plan and no checkpoints */}
            {!details.plan && details.checkpoints.length === 0 && (
              <div className="flex items-center justify-center py-16 text-fg-2">
                <div className="text-center space-y-2">
                  <div className="text-2xl opacity-40">📭</div>
                  <p className="text-[11px]">No plan or checkpoints for this session</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
