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

  return (
    <div className="flex items-center gap-4 h-8 px-3 bg-bg-1 border-b border-border rounded-lg mb-2">
      {/* Agent counts */}
      <div className="flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green" />
          <span className="text-fg-1">{running} active</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow" />
          <span className="text-fg-1">{idle} idle</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red/50" />
          <span className="text-fg-1">{stopped} stopped</span>
        </span>
      </div>

      <span className="text-border-1">·</span>

      {/* Relay count */}
      <span className="text-[11px] text-fg-2">{relayCount} relay{relayCount !== 1 ? 's' : ''} today</span>

      <span className="text-border-1">·</span>

      {/* Session count */}
      <span className="text-[11px] text-fg-2">{sessionCount} session{sessionCount !== 1 ? 's' : ''}</span>
    </div>
  );
}
