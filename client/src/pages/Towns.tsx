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
const actBtnPrimary = 'text-[10px] px-1.5 py-0.5 rounded bg-blue/10 text-blue/70 hover:text-blue hover:bg-blue/20 transition-colors';

// Pane action menu shown on each pane card in Manage view
function PaneActions({ pane, allPanes, allSessions, onAction }: {
  pane: PsmuxPane;
  allPanes: PsmuxPane[];
  allSessions: PsmuxSession[];
  onAction: () => void;
}) {
  const [menu, setMenu] = useState<'move' | 'resize' | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try { await fn(); setMenu(null); setTimeout(onAction, 400); }
    catch (e: any) { alert(e.message); }
    finally { setBusy(false); }
  };

  // Build move targets: all windows except the current one
  const moveTargets: { label: string; target: string }[] = [];
  const grouped: Record<string, Set<number>> = {};
  for (const p of allPanes) {
    if (!grouped[p.sessionName]) grouped[p.sessionName] = new Set();
    grouped[p.sessionName].add(p.windowIndex);
  }
  for (const [sess, wins] of Object.entries(grouped)) {
    for (const wi of Array.from(wins).sort()) {
      const t = `${sess}:${wi}`;
      if (sess !== pane.sessionName || wi !== pane.windowIndex) {
        moveTargets.push({ label: `${sess}:${wi}`, target: t });
      }
    }
  }
  // Also add "new window in each session"
  for (const s of allSessions) {
    const maxWin = grouped[s.name] ? Math.max(...Array.from(grouped[s.name])) + 1 : 0;
    moveTargets.push({ label: `${s.name}:new (win ${maxWin})`, target: `${s.name}:new` });
  }

  if (busy) return <span className="text-[9px] text-fg-2 animate-pulse">…</span>;

  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {/* Swap up/down */}
      <button className={actBtn} title="Swap with pane above"
        onClick={() => run(() => api.swapPane(pane.target, 'U'))}>↑</button>
      <button className={actBtn} title="Swap with pane below"
        onClick={() => run(() => api.swapPane(pane.target, 'D'))}>↓</button>

      {/* Zoom */}
      <button className={actBtn} title="Toggle zoom (fullscreen)"
        onClick={() => run(() => api.zoomPane(pane.target))}>⤢</button>

      {/* Break to new window */}
      <button className={actBtn} title="Break pane → new window"
        onClick={() => run(() => api.breakPane(pane.target))}>⊡</button>

      {/* Rotate panes in this window */}
      <button className={actBtn} title="Rotate panes in this window"
        onClick={() => run(() => api.rotateWindow(`${pane.sessionName}:${pane.windowIndex}`))}>⟳</button>

      {/* Move to another window */}
      <span className="text-fg-2/20 mx-0.5">│</span>
      {menu === 'move' ? (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] text-fg-2">Move to:</span>
          {moveTargets.map(t => (
            <button key={t.target} className={actBtnPrimary}
              onClick={() => {
                if (t.target.endsWith(':new')) {
                  // Break to new window in target session — use break then move
                  run(() => api.breakPane(pane.target));
                } else {
                  run(() => api.joinPane(pane.target, t.target));
                }
              }}>{t.label}</button>
          ))}
          <button className="text-[9px] text-fg-2 hover:text-fg px-1" onClick={() => setMenu(null)}>✕</button>
        </div>
      ) : (
        <button className={actBtn} title="Move pane to another window"
          onClick={() => setMenu('move')}>↗ Move</button>
      )}

      {/* Resize */}
      {menu === 'resize' ? (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-fg-2">Resize:</span>
          {(['L', 'R', 'U', 'D'] as const).map(dir => (
            <button key={dir} className={actBtn} title={`Resize ${dir}`}
              onClick={() => run(() => api.resizePane(pane.target, dir, 5))}>
              {dir === 'L' ? '←' : dir === 'R' ? '→' : dir === 'U' ? '↑' : '↓'}
            </button>
          ))}
          <button className="text-[9px] text-fg-2 hover:text-fg px-1" onClick={() => setMenu(null)}>✕</button>
        </div>
      ) : (
        <button className={actBtn} title="Resize pane"
          onClick={() => setMenu('resize')}>⇔ Resize</button>
      )}
    </div>
  );
}

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
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newWindowSession, setNewWindowSession] = useState<string | null>(null);
  const [newWindowName, setNewWindowName] = useState('');

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

  const handleRenameSession = async (oldName: string) => {
    if (!renameValue.trim() || renameValue === oldName) { setRenamingSession(null); return; }
    try { await api.renamePsmuxSession(oldName, renameValue.trim()); setRenamingSession(null); setTimeout(reload, 500); }
    catch (e: any) { setError(e.message); setRenamingSession(null); }
  };

  const handleNewWindow = async (session: string) => {
    try {
      await api.createPsmuxWindow(session, newWindowName.trim() || undefined);
      setNewWindowSession(null); setNewWindowName('');
      setTimeout(reload, 500);
    } catch (e: any) { setError(e.message); }
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
            <div className={gridClass}>
              {panes.map(pane => (
                <div key={pane.target}
                  className="flex flex-col border border-border rounded-lg overflow-hidden bg-bg-1 group relative"
                  style={{ height: 'min(300px, calc((100vh - 140px) / 2))' }}
                >
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

          <div className="space-y-3">
            {sessions.map(session => {
              const windows = grouped[session.name] || {};
              const windowKeys = Object.keys(windows).map(Number).sort();

              return (
                <div key={session.name} className="bg-bg-1 border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {renamingSession === session.name ? (
                        <input className="bg-bg border border-blue/50 rounded px-2 py-0.5 text-xs text-fg outline-none w-32"
                          value={renameValue} autoFocus
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRenameSession(session.name); if (e.key === 'Escape') setRenamingSession(null); }}
                          onBlur={() => handleRenameSession(session.name)} />
                      ) : (
                        <>
                          <span className="text-xs font-semibold">{session.name}</span>
                          <button className="text-[9px] text-fg-2/40 hover:text-fg-2"
                            onClick={() => { setRenamingSession(session.name); setRenameValue(session.name); }}
                            title="Rename session">✎</button>
                        </>
                      )}
                      {session.attached && <span className="text-[9px] text-green bg-green/10 px-1.5 py-0.5 rounded font-medium">attached</span>}
                      <span className="text-[9px] text-fg-2">{session.windows} win</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {/* Add window */}
                      {newWindowSession === session.name ? (
                        <div className="flex items-center gap-1">
                          <input className="bg-bg border border-blue/50 rounded px-2 py-0.5 text-[10px] text-fg outline-none w-24"
                            placeholder="name (optional)" value={newWindowName} autoFocus
                            onChange={e => setNewWindowName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleNewWindow(session.name); if (e.key === 'Escape') setNewWindowSession(null); }} />
                          <button className={actBtnPrimary} onClick={() => handleNewWindow(session.name)}>Create</button>
                          <button className="text-[9px] text-fg-2 hover:text-fg px-1" onClick={() => setNewWindowSession(null)}>✕</button>
                        </div>
                      ) : (
                        <button className={actBtn} onClick={() => setNewWindowSession(session.name)} title="Add window">+ Win</button>
                      )}
                      <span className="text-fg-2/20">│</span>
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

                        <div className="grid grid-cols-1 gap-1.5">
                          {windowPanes.map(pane => (
                            <div key={pane.target} className="bg-bg-2 border border-border rounded px-2.5 py-2 text-[10px]">
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-fg-1">{pane.target}</span>
                                  <span className="text-fg-2/50">{pane.width}×{pane.height}</span>
                                  <span className="text-fg-2 truncate font-mono">{pane.command}</span>
                                </div>
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
                              {/* Pane actions: swap, zoom, break, move, resize */}
                              <PaneActions pane={pane} allPanes={panes} allSessions={sessions} onAction={reload} />
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
