import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { TerminalView } from '../components/TerminalView';

interface PsmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  command: string;
  pid: number;
  active: boolean;
  width: number;
  height: number;
  target: string;
}

interface PsmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

type LayoutName = 'even-horizontal' | 'even-vertical' | 'tiled' | 'main-horizontal' | 'main-vertical';
type ViewMode = 'grid' | 'manage';

const LAYOUTS: { value: LayoutName; label: string; desc: string }[] = [
  { value: 'even-horizontal', label: '⬜⬜', desc: 'Side by side' },
  { value: 'even-vertical', label: '⬜/⬜', desc: 'Stacked' },
  { value: 'tiled', label: '⊞', desc: 'Tiled grid' },
  { value: 'main-horizontal', label: '▬', desc: 'Main horizontal' },
  { value: 'main-vertical', label: '▮', desc: 'Main vertical' },
];

const actBtn = 'text-[10px] px-1 py-0.5 rounded hover:bg-bg-3 text-fg-2/50 hover:text-fg-1 transition-colors';
const actBtnDanger = 'text-[10px] px-1 py-0.5 rounded hover:bg-red/10 text-red/40 hover:text-red transition-colors';

export default function Towns() {
  const [sessions, setSessions] = useState<PsmuxSession[]>([]);
  const [panes, setPanes] = useState<PsmuxPane[]>([]);
  const [loading, setLoading] = useState(true);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [layoutBusy, setLayoutBusy] = useState<string | null>(null);
  const [killConfirm, setKillConfirm] = useState<string | null>(null);
  const [killPaneConfirm, setKillPaneConfirm] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [focusedPane, setFocusedPane] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([api.getPsmuxSessions(), api.getPsmuxPanes()])
      .then(([s, p]) => { setSessions(s); setPanes(p); setError(''); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleCreateSession = async () => {
    if (!newSessionName.trim()) return;
    setCreating(true);
    try { await api.createPsmuxSession(newSessionName.trim()); setNewSessionName(''); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); }
    finally { setCreating(false); }
  };

  const handleKillSession = async (name: string) => {
    try { await api.killPsmuxSession(name); setKillConfirm(null); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); setKillConfirm(null); }
  };

  const handleSplit = async (target: string, stacked: boolean) => {
    setSplitting(target);
    try { await api.splitPsmuxPane(target, stacked); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); }
    finally { setSplitting(null); }
  };

  const handleLayout = async (windowTarget: string, layout: LayoutName) => {
    setLayoutBusy(windowTarget);
    try { await api.selectLayout(windowTarget, layout); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); }
    finally { setLayoutBusy(null); }
  };

  const handleKillPane = async (target: string) => {
    try { await api.killPane(target); setKillPaneConfirm(null); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); setKillPaneConfirm(null); }
  };

  // Group panes by session → window
  const grouped: Record<string, Record<number, PsmuxPane[]>> = {};
  for (const p of panes) {
    if (!grouped[p.sessionName]) grouped[p.sessionName] = {};
    if (!grouped[p.sessionName][p.windowIndex]) grouped[p.sessionName][p.windowIndex] = [];
    grouped[p.sessionName][p.windowIndex].push(p);
  }

  // Grid columns based on pane count
  const gridCols = panes.length <= 1 ? 1 : panes.length <= 4 ? 2 : 3;
  // Responsive: use CSS class for grid on larger screens, single-col on mobile
  const gridClass = `grid gap-2 grid-cols-1 ${
    gridCols >= 2 ? 'md:grid-cols-2' : ''
  } ${gridCols >= 3 ? 'lg:grid-cols-3' : ''}`;

  if (loading) return (
    <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-20 bg-bg-1 rounded animate-pulse" />
    ))}</div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold">Terminals</h2>
          <p className="text-[11px] text-fg-2 mt-0.5">{sessions.length} sessions · {panes.length} panes</p>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center bg-bg-2 border border-border rounded overflow-hidden">
            <button
              className={`text-[10px] px-2.5 py-1 transition-colors ${viewMode === 'grid' ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg-1'}`}
              onClick={() => setViewMode('grid')} title="Terminal grid">⊞ Grid</button>
            <button
              className={`text-[10px] px-2.5 py-1 transition-colors ${viewMode === 'manage' ? 'bg-bg-3 text-fg' : 'text-fg-2 hover:text-fg-1'}`}
              onClick={() => setViewMode('manage')} title="Manage sessions">⚙ Manage</button>
          </div>
          <button className="text-[10px] px-2 py-1 rounded bg-bg-2 text-fg-1 border border-border hover:text-fg hover:border-border-1"
            onClick={reload}>↻</button>
        </div>
      </div>

      {error && <p className="text-[11px] text-red bg-red/5 border border-red/20 rounded px-3 py-2 mb-3">⚠ {error}</p>}

      {/* ═══ GRID VIEW — Live terminal wall ═══ */}
      {viewMode === 'grid' && (
        <>
          {panes.length === 0 ? (
            <div className="text-center py-16 text-fg-2 text-xs">
              <span className="text-3xl block mb-3 opacity-20">⊟</span>
              <p className="mb-2">No live panes</p>
              <button className="text-[10px] px-3 py-1.5 rounded bg-fg text-bg font-medium hover:opacity-90"
                onClick={() => setViewMode('manage')}>Create a session →</button>
            </div>
          ) : focusedPane ? (
            /* Single pane maximized */
            <div className="flex flex-col" style={{ height: 'calc(100vh - 140px)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <button className="text-[10px] px-2 py-1 rounded bg-bg-2 border border-border text-fg-1 hover:text-fg"
                    onClick={() => setFocusedPane(null)}>← Back to grid</button>
                  <span className="text-[11px] font-mono text-fg-2">{focusedPane}</span>
                  <span className="text-[10px] text-fg-2/50 font-mono">
                    {panes.find(p => p.target === focusedPane)?.command}
                  </span>
                </div>
              </div>
              <div className="flex-1 border border-border rounded-lg overflow-hidden">
                <TerminalView key={focusedPane} target={focusedPane} />
              </div>
            </div>
          ) : (
            /* Multi-pane grid */
            <div
              className={gridClass}
              style={{ height: undefined }}
            >
              {panes.map(pane => (
                <div key={pane.target}
                  className="flex flex-col border border-border rounded-lg overflow-hidden bg-bg-1 group relative"
                  style={{ height: 'min(300px, calc((100vh - 140px) / 2))' }}
                >
                  {/* Pane header */}
                  <div className="flex items-center justify-between px-2 h-6 bg-bg-2 border-b border-border shrink-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-green dot-live shrink-0" />
                      <span className="text-[10px] font-mono text-fg-1 truncate">{pane.target}</span>
                      <span className="text-[9px] text-fg-2/40 truncate hidden sm:inline">{pane.command}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="text-[9px] text-fg-2 hover:text-fg px-1" title="Maximize"
                        onClick={() => setFocusedPane(pane.target)}>⤢</button>
                      <button className={actBtnDanger} title="Kill pane"
                        onClick={() => handleKillPane(pane.target)}>✕</button>
                    </div>
                  </div>
                  {/* Live terminal */}
                  <div className="flex-1 min-h-0 cursor-pointer" onClick={() => setFocusedPane(pane.target)}>
                    <TerminalView key={pane.target} target={pane.target} hideHeader />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══ MANAGE VIEW — Session/pane management ═══ */}
      {viewMode === 'manage' && (
        <>
          {/* Create session */}
          <div className="flex items-center gap-2 mb-4">
            <input
              className="bg-bg border border-border rounded px-2.5 py-1.5 text-xs text-fg placeholder-fg-2/40 focus:border-border-1 outline-none w-48"
              placeholder="New session name…" value={newSessionName}
              onChange={e => setNewSessionName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateSession()}
            />
            <button className="text-[10px] px-3 py-1.5 rounded bg-fg text-bg font-medium hover:opacity-90 disabled:opacity-30"
              onClick={handleCreateSession} disabled={creating || !newSessionName.trim()}>+ Session</button>
          </div>

          {/* Sessions */}
          <div className="space-y-3">
            {sessions.map(session => {
              const windows = grouped[session.name] || {};
              const windowKeys = Object.keys(windows).map(Number).sort();

              return (
                <div key={session.name} className="bg-bg-1 border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">{session.name}</span>
                      {session.attached && <span className="text-[9px] text-green bg-green/10 px-1.5 py-0.5 rounded font-medium">attached</span>}
                      <span className="text-[9px] text-fg-2">{session.windows} win</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {killConfirm === session.name ? (
                        <div className="flex items-center gap-1">
                          <button className="text-[10px] px-2 py-1 rounded bg-red/10 text-red border border-red/30 font-medium"
                            onClick={() => handleKillSession(session.name)}>Confirm</button>
                          <button className="text-[10px] px-1.5 py-1 text-fg-2 hover:text-fg"
                            onClick={() => setKillConfirm(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button className="text-[10px] px-2 py-1 rounded bg-bg-2 text-red/60 border border-border hover:text-red"
                          onClick={() => setKillConfirm(session.name)}>Kill</button>
                      )}
                    </div>
                  </div>

                  {windowKeys.map(wi => {
                    const windowPanes = windows[wi] || [];
                    const windowTarget = `${session.name}:${wi}`;

                    return (
                      <div key={wi} className="mb-2 last:mb-0">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[9px] text-fg-2 uppercase tracking-wider">Window {wi} · {windowPanes.length} pane{windowPanes.length !== 1 ? 's' : ''}</p>
                          <div className="flex items-center gap-0.5">
                            <button className={actBtn} onClick={() => handleSplit(windowTarget, false)}
                              disabled={splitting === windowTarget} title="Split horizontal">+ ↔</button>
                            <button className={actBtn} onClick={() => handleSplit(windowTarget, true)}
                              disabled={splitting === windowTarget} title="Split vertical">+ ↕</button>
                            {windowPanes.length > 1 && (
                              <>
                                <span className="text-fg-2/20 mx-0.5">│</span>
                                {LAYOUTS.map(l => (
                                  <button key={l.value} className={actBtn} title={l.desc}
                                    disabled={layoutBusy === windowTarget}
                                    onClick={() => handleLayout(windowTarget, l.value)}>{l.label}</button>
                                ))}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                          {windowPanes.map(pane => (
                            <div key={pane.target} className="bg-bg-2 border border-border rounded px-2.5 py-2 text-[10px]">
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-mono text-fg-1">{pane.target}</span>
                                <span className="text-fg-2/50">{pane.width}×{pane.height}</span>
                              </div>
                              <p className="text-fg-2 truncate mb-1.5 font-mono">{pane.command}</p>
                              <div className="flex items-center gap-1">
                                <button className={actBtn} onClick={() => { setFocusedPane(pane.target); setViewMode('grid'); }}
                                  title="Open terminal">▶ Terminal</button>
                                {killPaneConfirm === pane.target ? (
                                  <div className="flex items-center gap-1">
                                    <button className="text-[9px] px-1.5 py-0.5 rounded bg-red/10 text-red font-medium"
                                      onClick={() => handleKillPane(pane.target)}>Kill</button>
                                    <button className="text-[9px] px-1 py-0.5 text-fg-2 hover:text-fg"
                                      onClick={() => setKillPaneConfirm(null)}>✗</button>
                                  </div>
                                ) : (
                                  <button className={actBtnDanger} onClick={() => setKillPaneConfirm(pane.target)} title="Kill pane">✕</button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {sessions.length === 0 && (
              <div className="text-center py-12 text-fg-2 text-xs">
                <span className="text-2xl block mb-3 opacity-30">⊟</span>
                <p>No psmux sessions. Create one above.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
