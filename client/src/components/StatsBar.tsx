import { useState, useEffect } from 'react';
import { api, type AgentData } from '../lib/api';

interface Props {
  agents: AgentData[];
}

export default function StatsBar({ agents }: Props) {
  const [relayCount, setRelayCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
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
  }, [agents]);

  const running = agents.filter(a => a.status === 'running').length;
  const idle = agents.filter(a => a.status === 'idle').length;
  const stopped = agents.filter(a => a.status === 'stopped').length;

  const stats = [
    { label: 'active', value: running, color: 'bg-emerald-500', textColor: 'text-emerald-400' },
    { label: 'idle', value: idle, color: 'bg-amber-400', textColor: 'text-amber-400' },
    { label: 'stopped', value: stopped, color: 'bg-zinc-500', textColor: 'text-zinc-500' },
  ];

  return (
    <div className="flex items-center gap-6 py-3 mb-1">
      {/* Agent status counts */}
      <div className="flex items-center gap-5">
        {stats.map(s => (
          <div key={s.label} className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${s.color} ${s.label === 'active' ? 'dot-live' : ''}`} />
            <span className={`text-lg font-semibold tabular-nums ${s.textColor}`}>{s.value}</span>
            <span className="text-xs text-fg-2">{s.label}</span>
          </div>
        ))}
      </div>

      <span className="w-px h-5 bg-border" />

      {/* Activity */}
      <div className="flex items-center gap-4 text-xs text-fg-2">
        <span>{relayCount} relay{relayCount !== 1 ? 's' : ''} today</span>
        <span>{sessionCount} pane{sessionCount !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}
