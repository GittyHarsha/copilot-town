import { useState, useEffect, useCallback } from 'react';
import { api, type AgentData } from '../lib/api';

interface Relay {
  from: string;
  to: string;
  message: string;
  timestamp: string;
}

interface Props {
  agents: AgentData[];
}

export default function RelayPanel({ agents }: Props) {
  const [relays, setRelays] = useState<Relay[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const activeAgents = agents.filter(a => a.status === 'running' || a.status === 'idle');

  const loadRelays = useCallback(() => {
    api.getRelays(50).then(setRelays).catch(() => {});
  }, []);

  useEffect(() => { loadRelays(); }, [loadRelays]);

  const handleSend = async () => {
    if (!from || !to || !message.trim()) return;
    if (from === to) { setError('From and To must be different'); return; }
    setSending(true);
    setError('');
    try {
      await api.relayMessage(from, to, message.trim());
      setMessage('');
      loadRelays();
    } catch (err: any) {
      setError(err.message || 'Relay failed');
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      if (diffMs < 60_000) return 'just now';
      if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
      if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return ts; }
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 bg-bg-1 border-b border-border">
        <span className="text-[10px]">↗</span>
        <span className="text-[11px] font-medium">Relay Messages</span>
        <span className="text-[10px] text-fg-2 ml-auto">{relays.length} relays</span>
      </div>

      {/* Composer */}
      <div className="px-3 py-2.5 bg-bg-1/50 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <select
            className="flex-1 bg-bg text-xs border border-border rounded px-2 py-1.5 text-fg outline-none focus:border-blue/40"
            value={from}
            onChange={e => setFrom(e.target.value)}
          >
            <option value="">From…</option>
            {activeAgents.map(a => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
          <span className="text-fg-2 text-[10px]">→</span>
          <select
            className="flex-1 bg-bg text-xs border border-border rounded px-2 py-1.5 text-fg outline-none focus:border-blue/40"
            value={to}
            onChange={e => setTo(e.target.value)}
          >
            <option value="">To…</option>
            {activeAgents.map(a => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-1.5">
          <textarea
            className="flex-1 bg-bg text-xs border border-border rounded px-2.5 py-1.5 text-fg placeholder-fg-2/40 focus:border-blue/40 outline-none resize-none"
            placeholder="Relay message…"
            rows={2}
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }}
          />
          <button
            className="self-end text-xs px-3 py-1.5 rounded bg-fg text-bg hover:opacity-90 disabled:opacity-30 font-medium flex-shrink-0"
            onClick={handleSend}
            disabled={sending || !from || !to || !message.trim()}
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
        {error && <p className="text-[10px] text-red">⚠ {error}</p>}
        <p className="text-[9px] text-fg-2/30">⌘↵ to send</p>
      </div>

      {/* History */}
      <div className="max-h-[280px] overflow-y-auto">
        {relays.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-fg-2/40">No relays yet</div>
        ) : (
          relays.map((r, i) => (
            <div key={`${r.timestamp}-${i}`} className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-0 hover:bg-bg-1/30">
              <div className="flex-shrink-0 mt-0.5">
                <span className="text-[10px] font-mono text-green">{r.from}</span>
                <span className="text-[10px] text-fg-2 mx-1">→</span>
                <span className="text-[10px] font-mono text-blue">{r.to}</span>
              </div>
              <p className="flex-1 text-[11px] text-fg-1 truncate min-w-0">{r.message}</p>
              <span className="text-[9px] text-fg-2/40 flex-shrink-0 whitespace-nowrap">{formatTime(r.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
