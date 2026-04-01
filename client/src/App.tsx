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
import HeadlessChatPanel from './components/HeadlessChatPanel';
import ErrorBoundary from './components/ErrorBoundary';
import ShortcutsModal from './components/ShortcutsModal';
import { fetchModels } from './lib/models';

// Preload models so the New dialog opens instantly
fetchModels();

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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const { status: wsStatus, connected, events, latestEvent } = useAgentStatus();
  const { theme, toggleTheme } = useTheme();
  const { panelHeight, isCollapsed } = useTerminalPanel();
  const { toast } = useToast();
  const prevEventRef = useRef<string | null>(null);

  // Dynamic page title
  useEffect(() => {
    const pageName = NAV.find(n => n.id === page)?.label || 'Dashboard';
    document.title = `Copilot Town — ${pageName}`;
  }, [page]);

  // Cross-page navigation handler
  const handleNavigate = useCallback((target: string, context?: { agent?: string; session?: string }) => {
    setPage(target as Page);
    // If navigating to chat with a specific agent, open the chat
    if (context?.agent && target === 'dashboard') {
      // just navigate, the agent name is for future use
    }
  }, []);

  const [chatWidth, setChatWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('chat-panel-width') || '480');
    return Math.max(320, Math.min(saved, window.innerWidth * 0.6));
  });

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

  // Nav badge counts
  const navBadges = useMemo(() => {
    const badges: Record<string, number> = {};
    const running = agents.filter(a => a.status === 'running').length;
    if (running > 0) badges['dashboard'] = running;
    return badges;
  }, [agents, events]);

  const refreshAgents = useCallback(() => {
    api.getAgents().then(setAgents).catch(() => {});
  }, []);

  const openChat = useCallback((agentName: string | null) => {
    setActiveChat(agentName);
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
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }
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
      // Searchable agent finder
      cmds.push({
        id: `find-${agent.id}`,
        label: `${agent.name}`,
        icon: agent.type === 'headless' ? '⚡' : '▦',
        category: 'Agents',
        action: () => { setPage('dashboard'); },
      });

      // Chat shortcut for headless agents
      if (agent.type === 'headless') {
        cmds.push({
          id: `chat-${agent.id}`,
          label: `Chat with ${agent.name}`,
          icon: '💬',
          category: 'Chat',
          action: () => openChat(agent.name),
        });
      }

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

    // Quick navigation with context
    cmds.push({
      id: 'new-agent',
      label: 'Create new agent',
      icon: '➕',
      category: 'Actions',
      action: () => { setPage('dashboard'); },
    });

    // UI
    cmds.push({ id: 'refresh', label: 'Refresh agents', shortcut: 'R', category: 'UI', action: refreshAgents });
    cmds.push({ id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, category: 'UI', action: toggleTheme });

    // Help
    cmds.push({
      id: 'shortcuts',
      label: 'Keyboard shortcuts: 1-9 pages, R refresh, ⌘K palette',
      icon: '⌨️',
      category: 'Help',
      action: () => setShowShortcuts(true),
    });

    return cmds;
  }, [agents, theme, toggleTheme, refreshAgents, openChat]);

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

      {/* Header — glass surface, no hard border */}
      <header className="glass sticky top-0 z-50" style={{
        borderBottom: '1px solid var(--color-border)',
      }}>
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6 md:gap-8">
            <div className="flex items-center gap-2.5">
              <span className="text-base" aria-hidden>🏘️</span>
              <span className="text-sm font-semibold tracking-tight hidden sm:inline" style={{ letterSpacing: '-0.02em' }}>Copilot Town</span>
            </div>
            <nav className="flex items-center gap-1 p-1" role="navigation" aria-label="Main navigation">
              {NAV.map(item => (
                <button
                  key={item.id}
                  className="relative px-3.5 py-1.5 text-[11.5px] font-medium"
                  onClick={() => setPage(item.id)}
                  title={item.label}
                  aria-current={page === item.id ? 'page' : undefined}
                  style={{
                    borderRadius: 'var(--shape-full)',
                    background: page === item.id ? 'var(--accent-dim)' : 'transparent',
                    color: page === item.id ? 'var(--accent)' : 'var(--color-fg-2)',
                    transition: 'all var(--duration-medium) var(--ease-standard)',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span className="md:hidden">{item.icon}</span>
                  <span className="hidden md:inline">{item.label}</span>
                  {navBadges[item.id] && (
                    <span style={{
                      position: 'absolute', top: -4, right: -6,
                      minWidth: 16, height: 16, borderRadius: 'var(--shape-full)',
                      background: 'var(--accent)',
                      color: '#fff', fontSize: '0.6rem', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 4px', lineHeight: 1,
                      boxShadow: `0 0 0 2px var(--color-bg)`,
                    }}>
                      {navBadges[item.id] > 99 ? '99+' : navBadges[item.id]}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPaletteOpen(true)}
              className="btn"
              style={{ fontSize: 11, padding: '5px 12px', opacity: 0.6 }}
              title="Command palette (⌘K)"
            >⌘K</button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 dot-live' : 'bg-red-500'}`}
              role="status"
              title={connected ? 'Connected' : 'Disconnected'}
              aria-label={connected ? 'Connected' : 'Disconnected'} />
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 57px)' }}>
        <main className="flex-1 overflow-y-auto px-4 md:px-8 py-6 md:py-8" style={{ paddingBottom: isCollapsed ? undefined : panelHeight + 16 }}>
          <div className="max-w-[1400px] mx-auto animate-fade-in" key={page}>
            {page === 'dashboard' && (
              <ErrorBoundary>
                <Dashboard
                  agents={agents} setAgents={setAgents} connected={connected} onRefresh={refreshAgents}
                  onOpenChat={openChat}
                />
              </ErrorBoundary>
            )}
            <Suspense fallback={LazyFallback}>
              <ErrorBoundary>
                {page === 'live' && <LiveGrid onOpenChat={openChat} />}
                {page === 'panes' && <Towns />}
                {page === 'sessions' && <Sessions agents={agents} />}
                {page === 'graph' && <Graph onNavigate={handleNavigate} />}
                {page === 'workflows' && <Workflows />}

                {page === 'settings' && <Settings />}
              </ErrorBoundary>
            </Suspense>
          </div>
        </main>

        {/* ── Chat Sidebar ── */}
        {activeChat && (
          <aside className="flex-shrink-0 animate-slide-in-right bg-bg" style={{ width: chatWidth, maxWidth: '60vw' }}>
            <HeadlessChatPanel
              key={activeChat}
              agentName={activeChat}
              onClose={() => setActiveChat(null)}
              onResize={(w) => { setChatWidth(w); localStorage.setItem('chat-panel-width', String(w)); }}
            />
          </aside>
        )}
      </div>

      {/* Footer hint */}
      <div className="fixed bottom-2 left-1/2 -translate-x-1/2 z-30 pointer-events-none"
        style={{ display: isCollapsed ? undefined : 'none' }}>
        <span className="text-[10px] text-fg-2/40">⌘K for commands · ? for help</span>
      </div>

      <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
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
