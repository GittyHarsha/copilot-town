import { useState, useEffect } from 'react';
import { api, type CopilotSession } from '../lib/api';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function Sessions() {
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [orphaned, setOrphaned] = useState<CopilotSession[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<{ id: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'orphaned'>('all');

  useEffect(() => {
    Promise.all([api.getSessions(50), api.getOrphanedSessions()])
      .then(([all, orph]) => { setSessions(all); setOrphaned(orph); })
      .finally(() => setLoading(false));
  }, []);

  const loadPlan = async (id: string) => {
    try {
      const { plan } = await api.getSessionPlan(id);
      setSelectedPlan({ id, content: plan });
    } catch {
      setSelectedPlan({ id, content: '(No plan found)' });
    }
  };

  const displaySessions = tab === 'orphaned' ? orphaned : sessions;

  if (loading) return (
    <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="h-14 bg-bg-1 rounded animate-pulse" />
    ))}</div>
  );

  return (
    <div className="flex gap-5 h-full">
      <div className="flex-1 min-w-0">
        <div className="flex gap-4 mb-4 border-b border-border pb-2">
          <button className={`text-xs pb-1 transition-colors ${tab === 'all' ? 'text-fg border-b-2 border-blue' : 'text-fg-2 hover:text-fg-1'}`}
            onClick={() => setTab('all')}>All ({sessions.length})</button>
          <button className={`text-xs pb-1 transition-colors ${tab === 'orphaned' ? 'text-fg border-b-2 border-blue' : 'text-fg-2 hover:text-fg-1'}`}
            onClick={() => setTab('orphaned')}>Orphaned ({orphaned.length})</button>
        </div>
        <div className="space-y-1.5">
          {displaySessions.map(s => (
            <div key={s.id}
              className={`bg-bg-1 border rounded-lg p-3 cursor-pointer card-hover ${
                selectedPlan?.id === s.id ? 'border-border-1' : 'border-border hover:border-border-1'}`}
              onClick={() => loadPlan(s.id)}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {s.agentName && <span className="text-[10px] bg-bg-2 text-fg-1 px-1.5 py-0.5 rounded">{s.agentName}</span>}
                  {s.isOrphaned && <span className="text-[10px] text-red/60 bg-red/5 px-1.5 py-0.5 rounded">orphaned</span>}
                </div>
                <span className="text-[10px] text-fg-2" title={new Date(s.lastModified).toLocaleString()}>
                  {relativeTime(s.lastModified)}
                </span>
              </div>
              <div className="text-[10px] font-mono text-fg-2/60 truncate">{s.id}</div>
              {s.planSnippet && <p className="text-[11px] text-fg-2 mt-1 line-clamp-1">{s.planSnippet}</p>}
              {s.checkpoints.length > 0 && (
                <p className="text-[10px] text-fg-2/60 mt-1">{s.checkpoints.length} checkpoint{s.checkpoints.length !== 1 ? 's' : ''}</p>
              )}
            </div>
          ))}
          {displaySessions.length === 0 && (
            <div className="text-center py-12 text-fg-2 text-xs">
              <span className="text-2xl block mb-3 opacity-30">↻</span>
              <p>{tab === 'orphaned' ? 'No orphaned sessions' : 'No sessions found'}</p>
            </div>
          )}
        </div>
      </div>

      {selectedPlan && (
        <div className="w-[480px] shrink-0">
          <div className="bg-bg-1 border border-border rounded-lg overflow-hidden sticky top-16">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-[10px] font-mono text-fg-2 truncate">{selectedPlan.id}</span>
              <button className="text-fg-2 hover:text-fg text-xs" onClick={() => setSelectedPlan(null)}>✕</button>
            </div>
            <pre className="p-3 max-h-[600px] overflow-auto text-[11px] font-mono text-fg-2 leading-relaxed whitespace-pre-wrap">
              {selectedPlan.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
