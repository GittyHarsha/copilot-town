import { useState, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import type { AgentData } from '../lib/api';
import { api } from '../lib/api';
import { LaunchConfigPanel } from './LaunchConfigPanel';
import { useTerminalPanel } from './TerminalPanel';
import ChatPanel from './ChatPanel';
import HeadlessChatPanel from './HeadlessChatPanel';
import AgentEditPanel from './AgentEditPanel';

interface Props {
  agent: AgentData;
  onRefresh?: () => void;
  onViewHistory?: (name: string) => void;
  onOpenChat?: (agentName: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  selected?: boolean;
  onSelect?: () => void;
}

const DOT: Record<string, string> = {
  running: 'bg-emerald-500', idle: 'bg-amber-400', stopped: 'bg-fg-2',
  stopping: 'bg-fg-2', starting: 'bg-blue-400',
};
const DOT_GLOW: Record<string, string> = {
  running: '0 0 8px 2px rgba(34, 197, 94, 0.35)',
  idle: '0 0 8px 2px rgba(234, 179, 8, 0.3)',
  starting: '0 0 8px 2px rgba(96, 165, 250, 0.3)',
};
const GLOW: Record<string, string> = {
  running: 'glow-green', idle: 'glow-yellow',
};

function AgentCard({ agent, onRefresh, onViewHistory, onOpenChat, pinned, onTogglePin, selected, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<'stopping' | 'starting' | 'movingToPane' | 'movingToHeadless' | 'restarting' | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [showLaunchConfig, setShowLaunchConfig] = useState<'resume' | 'start' | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [effortInput, setEffortInput] = useState('');
  const prevStatus = useRef(agent.status);
  const moreRef = useRef<HTMLDivElement>(null);
  const { openTerminal } = useTerminalPanel();

  useEffect(() => {
    if (agent.status !== prevStatus.current) {
      prevStatus.current = agent.status;
      setPendingAction(null);
      setResumeError('');
    }
  }, [agent.status]);

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMoreMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMoreMenu]);

  const status = pendingAction || agent.status;

  const handleStop = async () => {
    setPendingAction('stopping');
    try { await api.stopAgent(agent.id); setTimeout(() => onRefresh?.(), 2000); }
    catch (e: any) { setPendingAction(null); setError(e?.message || 'Action failed'); setTimeout(() => setError(null), 3000); }
  };

  const handleResume = async (cmdOverride?: string) => {
    setPendingAction('starting');
    setResumeError('');
    try {
      await api.resumeAgent(agent.id, undefined, undefined, undefined, cmdOverride);
      setTimeout(() => onRefresh?.(), 2000);
    } catch (err: any) {
      setPendingAction(null);
      try {
        const body = JSON.parse(err.message || '{}');
        setResumeError(body.error || err.message || 'Resume failed');
      } catch {
        setResumeError(err.message || 'Resume failed');
      }
    }
  };

  const handleMoveToPane = async () => {
    setPendingAction('movingToPane');
    try { await api.moveToPaneAgent(agent.name); setTimeout(() => onRefresh?.(), 3000); }
    catch (e: any) { setPendingAction(null); setError(e?.message || 'Action failed'); setTimeout(() => setError(null), 3000); }
  };

  const handleMoveToHeadless = async () => {
    setPendingAction('movingToHeadless');
    try { await api.moveToHeadlessAgent(agent.name); setTimeout(() => onRefresh?.(), 3000); }
    catch (e: any) { setPendingAction(null); setError(e?.message || 'Action failed'); setTimeout(() => setError(null), 3000); }
  };

  const handleModelSwitch = async () => {
    if (!modelInput) return;
    try {
      await api.setAgentModel(agent.name, modelInput, effortInput || undefined);
      setShowModelPicker(false);
      setModelInput('');
      setEffortInput('');
      onRefresh?.();
    } catch {}
  };

  const handleModeSwitch = async (mode: string) => {
    try { await api.setAgentMode(agent.name, mode); onRefresh?.(); } catch {}
  };

  const isHeadless = agent.type === 'headless';
  const isAlive = status === 'running' || status === 'idle';
  const isStopped = status === 'stopped';

  const desc = agent.description || agent.template?.description || 'Copilot session';
  const displayModel = agent.model || agent.template?.model;

  return (
    <div className={`card-surface overflow-hidden group/card ${GLOW[status] || ''} ${isStopped ? 'saturate-50 hover:saturate-100' : ''}`}>
      {/* Header row */}
      <button
        className="w-full flex items-center gap-4 px-5 py-4 text-left transition-all"
        style={{ position: 'relative', zIndex: 2 }}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Selection checkbox */}
        {onSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${agent.name}`}
            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#3b82f6' }}
          />
        )}

        {/* Status dot with glow */}
        <span
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${DOT[status] || 'bg-fg-2/30'} ${
            status === 'running' ? 'dot-live' : ''
          }`}
          style={{ boxShadow: DOT_GLOW[status] || 'none' }}
        />

        {/* Pin */}
        {onTogglePin && (
          <button
            className={`text-xs flex-shrink-0 transition-all duration-200 ${pinned ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover/card:opacity-40 hover:!opacity-100 hover:!scale-110'}`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            title={pinned ? 'Unpin' : 'Pin'}
          >
            {pinned ? '⭐' : '☆'}
          </button>
        )}

        {/* Name + model + badges */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="text-[15px] font-semibold truncate tracking-tight">{agent.name}</span>
          {displayModel && (
            <span className="text-[11px] truncate hidden sm:inline" style={{ color: 'var(--color-fg-2)' }}>{displayModel}</span>
          )}
          {isHeadless && (
            <span className="badge text-cyan-400/80 bg-cyan-400/[0.08] border border-cyan-400/10">⚡ headless</span>
          )}
          {agent.template && (
            <span className="badge text-violet-400/70 bg-violet-400/[0.08] border border-violet-400/10">{agent.template.name}</span>
          )}
          <span className="text-[11px] text-fg-2/70 truncate hidden lg:inline">{desc !== 'Copilot session' ? desc : ''}</span>
        </div>

        {/* Status label */}
        <span className={`text-[11px] font-medium flex-shrink-0 tracking-wide ${
          isAlive ? (status === 'running' ? 'text-emerald-400' : 'text-amber-400') : 'text-fg-2/60'
        }`}>{status}</span>
        <span className="text-fg-2/30 text-[10px] flex-shrink-0 transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>▸</span>
      </button>

      {/* Expanded panel */}
      <div
        className="overflow-hidden"
        style={{
          maxHeight: expanded ? 600 : 0,
          opacity: expanded ? 1 : 0,
          transition: `max-height var(--duration-long) var(--ease-emphasized), opacity var(--duration-medium) var(--ease-standard)`,
          position: 'relative',
          zIndex: 2,
        }}
      >
        <div className="px-5 py-4 border-t border-border/60 space-y-4 animate-slide-down">
          {/* Description */}
          <p className="text-xs text-fg-2 leading-relaxed">{desc}</p>

          {/* Metadata row */}
          {(displayModel || (agent.flags && agent.flags.length > 0)) && (
            <div className="flex items-center gap-2 flex-wrap">
              {displayModel && <span className="badge text-emerald-400/70 bg-emerald-400/8">{displayModel}</span>}
              {agent.reasoningEffort && <span className="badge text-orange-400/70 bg-orange-400/8">effort: {agent.reasoningEffort}</span>}
              {agent.agentMode && agent.agentMode !== 'interactive' && (
                <span className="badge text-violet-400/70 bg-violet-400/8">mode: {agent.agentMode}</span>
              )}
              {agent.flags?.map(f => <span key={f} className="badge text-amber-400/70 bg-amber-400/8">{f}</span>)}
            </div>
          )}

          {/* Session ID */}
          {agent.sessionId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: 'var(--color-fg-2)' }}>
              <span>Session:</span>
              <code style={{ background: 'var(--color-bg-3)', padding: '1px 4px', borderRadius: 3, fontSize: '0.7rem', fontFamily: 'monospace' }}>
                {agent.sessionId.slice(0, 8)}
              </code>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(agent.sessionId);
                }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-fg-2)', fontSize: '0.7rem', padding: 0 }}
                title="Copy full session ID"
              >
                📋
              </button>
            </div>
          )}

          {/* Task */}
          {agent.task && (
            <div className="flex items-center gap-2 text-xs text-blue-400/90 bg-blue-400/[0.05] rounded-lg px-3 py-2.5 border border-blue-400/[0.08]">
              <span>📋</span>
              <span className="truncate">{agent.task}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2.5 flex-wrap">
            {pendingAction ? (
              <div className="flex items-center gap-2 text-xs text-fg-2">
                <span className="spinner" />
                <span>{pendingAction === 'stopping' ? 'Stopping…' : pendingAction === 'starting' ? 'Starting…'
                  : pendingAction === 'movingToPane' ? 'Moving to pane…' : pendingAction === 'restarting' ? 'Restarting…' : 'Moving to headless…'}</span>
              </div>
            ) : isAlive ? (
              <>
                <button className="btn btn-primary" aria-label="Open chat"
                  onClick={(e) => { e.stopPropagation(); if (isHeadless && onOpenChat) onOpenChat(agent.name); else setShowChat(true); }}>💬 Chat</button>
                <button className="btn btn-danger" aria-label="Stop agent"
                  onClick={(e) => { e.stopPropagation(); handleStop(); }}>Stop</button>

                {/* Overflow menu for secondary actions */}
                <div className="relative" ref={moreRef}>
                  <button className="btn" aria-label="More actions" onClick={(e) => { e.stopPropagation(); setShowMoreMenu(!showMoreMenu); }}>⋯</button>
                  {showMoreMenu && (
                    <div className="absolute top-full left-0 mt-1.5 z-50 bg-bg-1 border border-border-1 rounded-xl py-1.5 min-w-[170px] animate-slide-down"
                      style={{ boxShadow: 'var(--card-shadow-hover)' }}>
                      {isHeadless ? (
                        <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                          style={{ width: 'calc(100% - 4px)' }}
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); handleMoveToPane(); }}>📺 Move to pane</button>
                      ) : agent.pane && agent.sessionId ? (
                        <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                          style={{ width: 'calc(100% - 4px)' }}
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); handleMoveToHeadless(); }}>⚡ Move to headless</button>
                      ) : null}
                      {isHeadless && (
                        <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                          style={{ width: 'calc(100% - 4px)' }}
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); setShowModelPicker(!showModelPicker); }}>🔄 Switch model</button>
                      )}
                      {agent.pane && (
                        <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                          style={{ width: 'calc(100% - 4px)' }}
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); openTerminal(agent.name, agent.pane!.target); }}>📺 View output</button>
                      )}
                      {agent.sessionId && !agent.sessionId.startsWith('pane-') && onViewHistory && (
                        <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                          style={{ width: 'calc(100% - 4px)' }}
                          onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); onViewHistory(agent.id); }}>📜 History</button>
                      )}
                      <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                        style={{ width: 'calc(100% - 4px)' }}
                        aria-label="Restart agent"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setShowMoreMenu(false);
                          setPendingAction('restarting');
                          try {
                            await api.stopAgent(agent.id);
                            await new Promise(r => setTimeout(r, 2000));
                            await api.resumeAgent(agent.id);
                            setTimeout(() => onRefresh?.(), 1500);
                          } catch (e: any) {
                            setError(e?.message || 'Restart failed');
                            setTimeout(() => setError(null), 3000);
                          }
                          setPendingAction(null);
                        }}>🔄 Restart</button>
                      <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                        style={{ width: 'calc(100% - 4px)' }}
                        onClick={(e) => { e.stopPropagation(); setShowMoreMenu(false); setShowEdit(true); }}>✏️ Edit</button>
                      <button className="w-full text-left px-3.5 py-2 text-[11px] text-fg-1 hover:bg-bg-2 transition-colors rounded-lg mx-0.5"
                        style={{ width: 'calc(100% - 4px)' }}
                        aria-label="Clone agent"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setShowMoreMenu(false);
                          try {
                            await api.spawnAgent({
                              name: `${agent.name}-copy`,
                              model: agent.model,
                              flags: agent.flags,
                              headless: agent.type === 'headless',
                            });
                            setTimeout(() => onRefresh?.(), 1500);
                          } catch (e: any) {
                            console.error('Clone failed:', e);
                          }
                        }}>📋 Clone agent</button>
                    </div>
                  )}
                </div>
              </>
            ) : isStopped ? (
              <>
                {/* Headless agents: Chat auto-revives the session */}
                {isHeadless && agent.sessionId && (
                  <button className="btn btn-primary" aria-label="Open chat"
                    onClick={(e) => { e.stopPropagation(); if (onOpenChat) onOpenChat(agent.name); else setShowChat(true); }}>💬 Chat</button>
                )}
                {agent.sessionId && !agent.sessionId.startsWith('pane-') && !isHeadless && (
                  <button className="btn btn-success"
                    onClick={(e) => { e.stopPropagation(); handleResume(); }}>▶ Resume</button>
                )}
                {agent.sessionId && !agent.sessionId.startsWith('pane-') && onViewHistory && (
                  <button className="btn"
                    onClick={(e) => { e.stopPropagation(); onViewHistory(agent.id); }}>📜 History</button>
                )}
                <button className="btn"
                  onClick={(e) => { e.stopPropagation(); setShowEdit(true); }}>✏️ Edit</button>
              </>
            ) : null}
          </div>

          {/* Model picker (inline) */}
          {showModelPicker && isHeadless && (
            <div className="flex items-center gap-2 p-3 bg-bg/60 rounded-xl border border-border/60 backdrop-blur-sm">
              <input type="text" className="flex-1 bg-bg-1 border border-border rounded-lg px-3 py-2 text-xs text-fg placeholder-fg-2/40 focus:border-border-1 transition-colors"
                placeholder="Model (e.g. claude-haiku-4.5)" value={modelInput} onChange={e => setModelInput(e.target.value)} />
              <select className="bg-bg-1 border border-border rounded-lg px-2 py-2 text-xs text-fg"
                value={effortInput} onChange={e => setEffortInput(e.target.value)}>
                <option value="">effort</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <button className="btn btn-success" aria-label="Apply model change" onClick={handleModelSwitch}>Apply</button>
            </div>
          )}

          {/* Type switcher: headless ↔ pane — always visible */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-fg-2/60 mr-1">Type:</span>
            <div style={{ display: 'flex', borderRadius: 9999, overflow: 'hidden', border: '1px solid var(--color-border-1)' }}>
              <button
                className={`text-[10px] px-3 py-1.5 transition-all duration-150 ${
                  !isHeadless
                    ? 'bg-emerald-500/15 text-emerald-400 font-medium'
                    : 'text-fg-2 hover:text-fg-1 hover:bg-bg-3'
                }`}
                style={{ border: 'none', cursor: isHeadless ? 'pointer' : 'default', background: !isHeadless ? 'rgba(34,197,94,0.12)' : 'transparent' }}
                disabled={!isHeadless || !!pendingAction}
                onClick={(e) => { e.stopPropagation(); if (isHeadless) handleMoveToPane(); }}
                title={isHeadless ? 'Switch to terminal pane mode' : 'Currently in pane mode'}
              >
                📺 Pane
              </button>
              <button
                className={`text-[10px] px-3 py-1.5 transition-all duration-150 ${
                  isHeadless
                    ? 'bg-cyan-500/15 text-cyan-400 font-medium'
                    : agent.sessionId ? 'text-fg-2 hover:text-fg-1 hover:bg-bg-3' : 'text-fg-2/40'
                }`}
                style={{ border: 'none', borderLeft: '1px solid var(--color-border)', cursor: !isHeadless && agent.sessionId ? 'pointer' : isHeadless ? 'default' : 'not-allowed', background: isHeadless ? 'rgba(34,211,238,0.12)' : 'transparent' }}
                disabled={isHeadless || !agent.sessionId || !!pendingAction}
                onClick={(e) => { e.stopPropagation(); if (!isHeadless && agent.sessionId) handleMoveToHeadless(); }}
                title={isHeadless ? 'Currently in headless mode' : agent.sessionId ? 'Switch to headless SDK mode' : 'No session ID — cannot switch to headless (agent needs an active Copilot session)'}
              >
                ⚡ Headless
              </button>
            </div>
            {!isHeadless && !agent.sessionId && (
              <span className="text-[9px] text-amber-400/70" title="This agent has no Copilot session attached. Start a Copilot session in the pane first to enable headless mode.">
                ⚠ no session
              </span>
            )}
          </div>

          {/* Agent mode switcher (headless only) */}
          {isHeadless && isAlive && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-fg-2/60 mr-1">Mode:</span>
              {['interactive', 'plan', 'autopilot'].map(m => (
                <button key={m} className={`text-[10px] px-3 py-1.5 border transition-all duration-150 ${
                  agent.agentMode === m ? 'bg-violet-500/10 text-violet-400 border-violet-500/20 font-medium' : 'border-border text-fg-2 hover:text-fg-1 hover:border-border-1'
                }`} style={{ borderRadius: 9999 }} onClick={(e) => { e.stopPropagation(); handleModeSwitch(m); }}>{m}</button>
              ))}
            </div>
          )}

          {/* Resume error */}
          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/15 mt-2">
              ⚠ {error}
            </div>
          )}

          {resumeError && (
            <div className="text-xs text-red-400 bg-red-400/[0.05] rounded-lg px-3 py-2.5 border border-red-400/[0.08]">
              ⚠ {resumeError}
            </div>
          )}
        </div>
      </div>

      {showLaunchConfig && createPortal(
        <LaunchConfigPanel agentName={agent.template?.name || agent.name} sessionId={agent.sessionId}
          isResume={showLaunchConfig === 'resume'} onCancel={() => setShowLaunchConfig(null)}
          onLaunch={(cmd) => { setShowLaunchConfig(null); handleResume(cmd); }} />,
        document.body
      )}

      {showChat && createPortal(
        isHeadless
          ? <HeadlessChatPanel agentName={agent.name} onClose={() => setShowChat(false)} />
          : <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40 backdrop-blur-sm"
              onClick={e => { if (e.target === e.currentTarget) setShowChat(false); }}>
              <div className="w-[620px] max-w-[92vw] bg-bg-1 border-l border-border/50 flex flex-col animate-slide-in-right"
                style={{ boxShadow: '-12px 0 60px rgba(0,0,0,0.5)' }}>
                <ChatPanel agentName={agent.id} onClose={() => setShowChat(false)} />
              </div>
            </div>,
        document.body
      )}

      {showEdit && createPortal(
        <AgentEditPanel agent={agent} onClose={() => setShowEdit(false)} onSaved={onRefresh} />,
        document.body
      )}
    </div>
  );
}

export const AgentCardMemo = memo(AgentCard, (prev, next) =>
  prev.agent.id === next.agent.id &&
  prev.agent.status === next.agent.status &&
  prev.agent.pane?.target === next.agent.pane?.target &&
  prev.agent.sessionId === next.agent.sessionId &&
  prev.agent.task === next.agent.task &&
  prev.agent.agentMode === next.agent.agentMode &&
  prev.agent.model === next.agent.model &&
  prev.agent.description === next.agent.description &&
  prev.agent.type === next.agent.type &&
  prev.agent.reasoningEffort === next.agent.reasoningEffort &&
  prev.pinned === next.pinned &&
  prev.selected === next.selected
);

export default AgentCard;
