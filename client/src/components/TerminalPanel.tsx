import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { TerminalView } from './TerminalView';

// ── Context for opening terminals from anywhere ──

interface TerminalTab {
  agentName: string;
  paneTarget: string;
}

interface TerminalContextValue {
  openTerminal: (agentName: string, paneTarget: string) => void;
  panelHeight: number;
  isCollapsed: boolean;
  hasOpenTabs: boolean;
}

const TerminalContext = createContext<TerminalContextValue>({
  openTerminal: () => {},
  panelHeight: 0,
  isCollapsed: true,
  hasOpenTabs: false,
});

export const useTerminalPanel = () => useContext(TerminalContext);

// ── Provider wraps the app ──

export function TerminalPanelProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [height, setHeight] = useState(280);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const openTerminal = useCallback((agentName: string, paneTarget: string) => {
    setTabs(prev => {
      const exists = prev.find(t => t.agentName === agentName);
      if (exists) {
        // Update target if changed, switch to tab
        if (exists.paneTarget !== paneTarget) {
          return prev.map(t => t.agentName === agentName ? { ...t, paneTarget } : t);
        }
        return prev;
      }
      return [...prev, { agentName, paneTarget }];
    });
    setActiveTab(agentName);
    setCollapsed(false);
  }, []);

  const closeTab = useCallback((agentName: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.agentName !== agentName);
      if (next.length === 0) setCollapsed(true);
      return next;
    });
    setActiveTab(prev => prev === agentName ? null : prev);
  }, []);

  // Auto-select first tab if active is removed
  useEffect(() => {
    if (!activeTab && tabs.length > 0) setActiveTab(tabs[0].agentName);
  }, [tabs, activeTab]);

  // ── Drag resize ──
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - ev.clientY;
      const newH = Math.min(Math.max(startH.current + delta, 150), window.innerHeight * 0.6);
      setHeight(newH);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height]);

  const effectiveHeight = collapsed || tabs.length === 0 ? 0 : height;
  const activeTarget = tabs.find(t => t.agentName === activeTab);

  const ctx: TerminalContextValue = {
    openTerminal,
    panelHeight: effectiveHeight,
    isCollapsed: collapsed || tabs.length === 0,
    hasOpenTabs: tabs.length > 0,
  };

  return (
    <TerminalContext.Provider value={ctx}>
      {children}

      {/* Bottom panel */}
      {tabs.length > 0 && (
        <div
          className="fixed bottom-0 left-0 right-0 bg-bg-1 border-t border-border z-40 flex flex-col"
          style={{ height: collapsed ? 32 : height }}
        >
          {/* Drag handle */}
          {!collapsed && (
            <div
              className="h-1 bg-border hover:bg-blue cursor-row-resize flex-shrink-0 transition-colors"
              onMouseDown={onMouseDown}
            />
          )}

          {/* Tab bar */}
          <div className="flex items-center h-8 px-2 border-b border-border bg-bg shrink-0 gap-0.5">
            <button
              className="text-[10px] text-fg-2 hover:text-fg px-1.5 py-0.5 rounded hover:bg-bg-2 mr-1"
              onClick={() => setCollapsed(c => !c)}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▲' : '▼'}
            </button>

            {tabs.map(tab => (
              <div
                key={tab.agentName}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-t text-[11px] cursor-pointer transition-colors ${
                  activeTab === tab.agentName
                    ? 'bg-bg-1 border-b-2 border-blue text-fg'
                    : 'bg-bg text-fg-2 hover:text-fg-1 hover:bg-bg-1'
                }`}
                onClick={() => { setActiveTab(tab.agentName); setCollapsed(false); }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green dot-live" />
                <span className="truncate max-w-[120px]">{tab.agentName}</span>
                <button
                  className="text-fg-2/40 hover:text-fg text-[9px] ml-0.5"
                  onClick={e => { e.stopPropagation(); closeTab(tab.agentName); }}
                >
                  ✕
                </button>
              </div>
            ))}

            <span className="text-[9px] text-fg-2/40 ml-auto font-mono tabular-nums">
              TERMINAL
            </span>
          </div>

          {/* Content */}
          {!collapsed && (
            <div className="flex-1 min-h-0">
              {activeTarget ? (
                <TerminalView
                  key={activeTarget.paneTarget}
                  target={activeTarget.paneTarget}
                  agentName={activeTarget.agentName}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-fg-2">
                  No terminal open
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </TerminalContext.Provider>
  );
}
