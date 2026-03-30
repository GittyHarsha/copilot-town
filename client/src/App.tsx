import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import Dashboard from './pages/Dashboard';
import CommandPalette, { type Command } from './components/CommandPalette';
import { api, type AgentData } from './lib/api';
import { useAgentStatus } from './hooks/useAgentStatus';
import { useTheme } from './hooks/useTheme';
import { useToast } from './hooks/useToast';
import { ThemeToggle } from './components/ThemeToggle';
import { TerminalPanelProvider, useTerminalPanel } from './components/TerminalPanel';
import ToastContainer from './components/ToastContainer';

const Towns = lazy(() => import('./pages/Towns'));
const Sessions = lazy(() => import('./pages/Sessions'));
const Graph = lazy(() => import('./pages/Graph'));
const Settings = lazy(() => import('./pages/Settings'));
const Workflows = lazy(() => import('./pages/Workflows'));
const LiveGrid = lazy(() => import('./pages/LiveGrid'));

type Page = 'dashboard' | 'live' | 'panes' | 'sessions' | 'graph' | 'workflows' | 'settings';

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '🏘️' },
  { id: 'live', label: 'Live', icon: '⚡' },
  { id: 'panes', label: 'Panes', icon: '▦' },
  { id: 'sessions', label: 'Sessions', icon: '💬' },
  { id: 'graph', label: 'Graph', icon: '⊙' },
  { id: 'workflows', label: 'Workflows', icon: '⛓' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

function AppInner() {
  const [page, setPage] = useState<Page>('dashboard');
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [conversationAgent, setConversationAgent] = useState<string | null>(null);
  const { status: wsStatus, connected, latestEvent } = useAgentStatus();
  const { theme, toggleTheme } = useTheme();
  const { panelHeight, isCollapsed } = useTerminalPanel();
  const { toast } = useToast();
  const prevEventRef = useRef<string | null>(null);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  // Sync agent status from WebSocket
  useEffect(() => {
    if (!wsStatus?.agents) return;
    setAgents(prev => {
      let changed = false;
      const next = prev.map(agent => {
        const ws = wsStatus.agents.find(a => a.id === agent.id || a.name === agent.name);
        if (ws && ws.status !== agent.status) {
          changed = true;
          return { ...agent, status: ws.status as AgentData['status'] };
        }
        return agent;
      });
      return changed ? next : prev;
    });
  }, [wsStatus]);

  // Toast on events (no sounds)
  useEffect(() => {
    if (!latestEvent || latestEvent.id === prevEventRef.current) return;
    prevEventRef.current = latestEvent.id;
    const { type, agent, message, severity } = latestEvent;
    if (severity === 'error') toast('error', message);
    else if (type === 'agent_started' || type === 'agent_resumed') toast('success', agent ? `${agent} started` : message);
    else if (type === 'agent_stopped') toast('info', agent ? `${agent} stopped` : message);
  }, [latestEvent, toast]);

  const refreshAgents = useCallback(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  // Keyboard shortcuts — inline, no separate hook
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        return;
      }
      if (isInputFocused()) return;
      const pageMap: Record<string, Page> = { '1': 'dashboard', '2': 'live', '3': 'panes', '4': 'sessions', '5': 'graph', '6': 'workflows', '7': 'settings' };
      if (pageMap[e.key]) { e.preventDefault(); setPage(pageMap[e.key]); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refreshAgents(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [refreshAgents]);

  // Command palette commands
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    // Navigation
    NAV.forEach((n, i) => cmds.push({
      id: `nav-${n.id}`, label: `Go to ${n.label}`, shortcut: `${i + 1}`, category: 'Navigation',
      action: () => setPage(n.id),
    }));

    // Agent actions
    for (const agent of agents) {
      const isActive = agent.status === 'running' || agent.status === 'idle';
      if (isActive) {
        cmds.push({ id: `stop-${agent.id}`, label: `Stop ${agent.name}`, icon: '⏹', category: 'Agents', action: () => { api.stopAgent(agent.id).then(refreshAgents); } });
        cmds.push({ id: `msg-${agent.id}`, label: `Message ${agent.name}`, icon: '💬', category: 'Agents', action: () => setPage('dashboard') });
      }
      if (agent.status === 'stopped') {
        cmds.push({ id: `resume-${agent.id}`, label: `Resume ${agent.name}`, icon: '▶', category: 'Agents', action: () => { api.resumeAgent(agent.id).then(refreshAgents); } });
      }
    }

    // Bulk actions
    const running = agents.filter(a => a.status === 'running' || a.status === 'idle');
    if (running.length > 0) {
      cmds.push({
        id: 'stop-all', label: `Stop all agents (${running.length})`, icon: '⏹', category: 'Bulk',
        action: () => { Promise.all(running.map(a => api.stopAgent(a.id))).then(refreshAgents); },
      });
    }

    // Relay
    cmds.push({ id: 'relay', label: 'Relay message between agents', icon: '↗', category: 'Agents', action: () => setPage('dashboard') });

    // UI
    cmds.push({ id: 'refresh', label: 'Refresh agents', shortcut: 'R', category: 'UI', action: refreshAgents });
    cmds.push({ id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, category: 'UI', action: toggleTheme });

    return cmds;
  }, [agents, theme, toggleTheme, refreshAgents]);

  const handlePaletteExecute = useCallback((cmd: Command) => {
    setPaletteOpen(false);
    cmd.action();
  }, []);

  const LazyFallback = <div className="flex items-center justify-center h-40 text-xs text-fg-2">Loading…</div>;

  return (
    <div className="min-h-screen bg-bg">
      {paletteOpen && (
        <CommandPalette commands={commands} onExecute={handlePaletteExecute} onClose={() => setPaletteOpen(false)} />
      )}

      {/* Header — 48px */}
      <header className="border-b border-border sticky top-0 z-50 bg-bg/80 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-5 md:gap-7">
            <div className="flex items-center gap-2.5">
              <span className="text-base" aria-hidden>🏘️</span>
              <span className="text-sm font-bold tracking-tight hidden sm:inline">Copilot Town</span>
            </div>
            <nav className="flex items-center gap-0.5 bg-bg-1/50 rounded-xl p-0.5 border border-border/50">
              {NAV.map(item => (
                <button
                  key={item.id}
                  className={`relative px-3 md:px-3.5 py-1.5 text-[11px] font-medium transition-all duration-200 rounded-lg ${
                    page === item.id ? 'text-fg bg-bg-3/80 shadow-sm' : 'text-fg-2 hover:text-fg-1'
                  }`}
                  onClick={() => setPage(item.id)}
                  title={item.label}
                >
                  <span className="md:hidden">{item.icon}</span>
                  <span className="hidden md:inline">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 dot-live' : 'bg-red-500'}`}
              title={connected ? 'Connected' : 'Disconnected'} />
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-6 py-5" style={{ paddingBottom: isCollapsed ? undefined : panelHeight + 16 }}>
        {page === 'dashboard' && (
          <Dashboard
            agents={agents} setAgents={setAgents} connected={connected} onRefresh={refreshAgents}
            onViewHistory={(id) => { setConversationAgent(id); setPage('sessions'); }}
          />
        )}
        <Suspense fallback={LazyFallback}>
          {page === 'live' && <LiveGrid />}
          {page === 'panes' && <Towns />}
          {page === 'sessions' && <Sessions agents={agents} initialAgent={conversationAgent} />}
          {page === 'graph' && <Graph />}
          {page === 'workflows' && <Workflows />}
          {page === 'settings' && <Settings />}
        </Suspense>
      </main>

      {/* Footer hint */}
      <div className="fixed bottom-2 left-1/2 -translate-x-1/2 z-30 pointer-events-none"
        style={{ display: isCollapsed ? undefined : 'none' }}>
        <span className="text-[10px] text-fg-2/40">⌘K for commands · ? for help</span>
      </div>

      <ToastContainer />
    </div>
  );
}

export default function App() {
  return (
    <TerminalPanelProvider>
      <AppInner />
    </TerminalPanelProvider>
  );
}
