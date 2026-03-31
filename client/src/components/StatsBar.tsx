import { useState, useEffect, useMemo } from 'react';
import { api, type AgentData } from '../lib/api';

interface Props {
  agents: AgentData[];
}

export default function StatsBar({ agents }: Props) {
  const [relayCount, setRelayCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [activeWorkflows, setActiveWorkflows] = useState(0);

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

  useEffect(() => {
    const fetch = () => api.getWorkflowRuns().then(runs => {
      setActiveWorkflows(runs.filter((r: any) => r.status === 'running').length);
    }).catch(() => {});
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, []);

  const running = agents.filter(a => a.status === 'running').length;
  const idle = agents.filter(a => a.status === 'idle').length;
  const stopped = agents.filter(a => a.status === 'stopped').length;
  const headlessCount = agents.filter(a => a.type === 'headless').length;

  const topModel = useMemo(() => {
    const counts: Record<string, number> = {};
    agents.forEach(a => { if (a.model) counts[a.model] = (counts[a.model] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries[0] ? `${entries[0][0].split('-').pop()} ×${entries[0][1]}` : null;
  }, [agents]);

  const stats = [
    { label: 'active', value: running, color: 'bg-emerald-500', textColor: 'text-emerald-400', bgTint: 'rgba(34, 197, 94, 0.04)' },
    { label: 'idle', value: idle, color: 'bg-amber-400', textColor: 'text-amber-400', bgTint: 'rgba(234, 179, 8, 0.04)' },
    { label: 'stopped', value: stopped, color: 'bg-fg-2', textColor: 'text-fg-1', bgTint: undefined },
  ];

  return (
    <div className="flex items-center gap-4 py-2.5 mb-1 flex-wrap">
      {/* Agent status counts */}
      {stats.map(s => (
        <div key={s.label} className="flex items-center gap-3 px-5 py-3 bg-bg-1 border border-border"
          style={{ borderRadius: 'var(--shape-xl)', boxShadow: 'var(--card-shadow)', background: s.bgTint || undefined, transition: 'box-shadow var(--duration-short) var(--ease-standard)' }}>
          <span className={`w-2 h-2 rounded-full ${s.color} ${s.label === 'active' ? 'dot-live' : ''}`} />
          <span className={`text-xl font-extrabold tabular-nums ${s.textColor}`}>{s.value}</span>
          <span className="text-[11px] text-fg-2 font-medium">{s.label}</span>
        </div>
      ))}

      {/* Activity */}
      <div className="flex items-center gap-4 text-[11px] text-fg-2 font-medium px-4 py-3"
        style={{ borderRadius: 'var(--shape-xl)', background: 'var(--color-bg-1)', border: '1px solid var(--color-border)' }}>
        <span>{relayCount} relay{relayCount !== 1 ? 's' : ''} today</span>
        <span className="w-px h-3.5 bg-border" />
        <span>{sessionCount} pane{sessionCount !== 1 ? 's' : ''}</span>
        <span className="w-px h-3.5 bg-border" />
        <span>{headlessCount} headless</span>
        <span className="w-px h-3.5 bg-border" />
        <span>{activeWorkflows} workflow{activeWorkflows !== 1 ? 's' : ''}</span>
        {topModel && (
          <>
            <span className="w-px h-3.5 bg-border" />
            <span>🤖 {topModel}</span>
          </>
        )}
      </div>
    </div>
  );
}
