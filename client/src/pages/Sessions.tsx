import { useState, useEffect, useRef } from 'react';
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
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
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
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value)}
        className="text-[10px] bg-bg-2 border border-blue/50 rounded px-1.5 py-0.5 text-fg outline-none w-32"
        placeholder="agent name"
        disabled={saving}
      />
      <button type="submit" disabled={saving}
        className="text-[10px] px-1.5 py-0.5 rounded bg-blue/20 text-blue hover:bg-blue/30 transition-colors">
        {saving ? '…' : '✓'}
      </button>
      <button type="button" onClick={() => setOpen(false)}
        className="text-[10px] text-fg-2 hover:text-fg px-1">✕</button>
    </form>
  );
}

export default function Sessions() {
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [orphaned, setOrphaned] = useState<CopilotSession[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<{ id: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'orphaned'>('all');

  const load = () => {
    Promise.all([api.getSessions(50), api.getOrphanedSessions()])
      .then(([all, orph]) => { setSessions(all); setOrphaned(orph); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

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
            onClick={() => setTab('orphaned')}>Unregistered ({orphaned.length})</button>
        </div>
        <div className="space-y-1.5">
          {displaySessions.map(s => (
            <div key={s.id}
              className={`bg-bg-1 border rounded-lg p-3 cursor-pointer card-hover ${
                selectedPlan?.id === s.id ? 'border-border-1' : 'border-border hover:border-border-1'}`}
              onClick={() => loadPlan(s.id)}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {s.agentName
                    ? <span className="text-[10px] bg-blue/10 text-blue px-1.5 py-0.5 rounded font-medium">{s.agentName}</span>
                    : <span className="text-[10px] text-fg-2/40 px-1.5 py-0.5 rounded border border-dashed border-border">unregistered</span>
                  }
                  {s.checkpoints.length > 0 && (
                    <span className="text-[10px] text-fg-2/50">{s.checkpoints.length} ckpt{s.checkpoints.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <RegisterButton session={s} onRegistered={load} />
                  <span className="text-[10px] text-fg-2" title={new Date(s.lastModified).toLocaleString()}>
                    {relativeTime(s.lastModified)}
                  </span>
                </div>
              </div>
              {s.summary && s.summary !== 'Start Conversation' && (
                <p className="text-[11px] text-fg-1 truncate">{s.summary}</p>
              )}
              {s.cwd && <p className="text-[10px] font-mono text-fg-2/50 truncate mt-0.5">{s.cwd}</p>}
              <div className="text-[10px] font-mono text-fg-2/30 truncate mt-0.5">{s.id}</div>
            </div>
          ))}
          {displaySessions.length === 0 && (
            <div className="text-center py-12 text-fg-2 text-xs">
              <span className="text-2xl block mb-3 opacity-30">↻</span>
              <p>{tab === 'orphaned' ? 'No unregistered sessions' : 'No sessions found'}</p>
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



