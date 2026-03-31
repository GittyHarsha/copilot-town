import { useState, useEffect } from 'react';
import { api, type AgentData } from '../lib/api';

interface Props {
  agents: AgentData[];
}

export default function StatsBar({ agents }: Props) {
  const [relayCount, setRelayCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    const load = () => {
      api.getRelays(200).then(relays => {
        const today = new Date().toDateString();
        const todayRelays = relays.filter(r => {
          try { return new Date(r.timestamp).toDateString() === today; }
          catch { return false; }
        });
        setRelayCount(todayRelays.length);
      }).catch(() => {});

      api.getPsmuxSessions().then(sessions => {
        setSessionCount(sessions.length);
      }).catch(() => {});
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  const running = agents.filter(a => a.status === 'running').length;
  const idle = agents.filter(a => a.status === 'idle').length;
  const stopped = agents.filter(a => a.status === 'stopped').length;

  const stats = [
    { label: 'active', value: running, color: 'bg-emerald-500', textColor: 'text-emerald-400', bgTint: 'rgba(34, 197, 94, 0.04)' },
    { label: 'idle', value: idle, color: 'bg-amber-400', textColor: 'text-amber-400', bgTint: 'rgba(234, 179, 8, 0.04)' },
    { label: 'stopped', value: stopped, color: 'bg-fg-2', textColor: 'text-fg-1', bgTint: undefined },
  ];

  return (
    <div className="flex items-center gap-3 py-2 mb-1 flex-wrap">
      {/* Agent status counts */}
      {stats.map(s => (
        <div key={s.label} className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-bg-1 border border-border"
          style={{ boxShadow: 'var(--card-shadow)', background: s.bgTint || undefined }}>
          <span className={`w-2 h-2 rounded-full ${s.color} ${s.label === 'active' ? 'dot-live' : ''}`} />
          <span className={`text-lg font-bold tabular-nums ${s.textColor}`}>{s.value}</span>
          <span className="text-[11px] text-fg-2 font-medium">{s.label}</span>
        </div>
      ))}

      {/* Activity */}
      <div className="flex items-center gap-4 text-[11px] text-fg-2 font-medium px-3 py-2.5">
        <span>{relayCount} relay{relayCount !== 1 ? 's' : ''} today</span>
        <span className="w-px h-3.5 bg-border" />
        <span>{sessionCount} pane{sessionCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}
