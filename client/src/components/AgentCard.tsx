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
  pinned?: boolean;
  onTogglePin?: () => void;
}

const DOT: Record<string, string> = {
  running: 'bg-green', idle: 'bg-yellow', stopped: 'bg-red/50',
  stopping: 'bg-red/30', starting: 'bg-blue/50',
};
const TEXT_COLOR: Record<string, string> = {
  running: 'text-green', idle: 'text-yellow', stopped: 'text-fg-2',
  stopping: 'text-fg-2', starting: 'text-blue',
};
const GLOW: Record<string, string> = {
  running: 'glow-green', idle: 'glow-yellow',
};

function AgentCard({ agent, onRefresh, onViewHistory, pinned, onTogglePin }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<'stopping' | 'starting' | 'promoting' | 'demoting' | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [showLaunchConfig, setShowLaunchConfig] = useState<'resume' | 'start' | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelInput, setModelInput] = useState('');
  const [effortInput, setEffortInput] = useState('');
  const prevStatus = useRef(agent.status);
  const { openTerminal } = useTerminalPanel();

  useEffect(() => {
    if (agent.status !== prevStatus.current) {
      prevStatus.current = agent.status;
      setPendingAction(null);
      setResumeError('');
    }
  }, [agent.status]);

  const status = pendingAction || agent.status;

  const handleStop = async () => {
    setPendingAction('stopping');
    try { await api.stopAgent(agent.id); setTimeout(() => onRefresh?.(), 2000); }
    catch { setPendingAction(null); }
  };

  const handleResume = async (cmdOverride?: string) => {
    setPendingAction('starting');
    setResumeError('');
    try {
      // Just call resume — backend auto-provisions a pane
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

  const handlePromote = async () => {
    setPendingAction('promoting');
    try { await api.promoteAgent(agent.name); setTimeout(() => onRefresh?.(), 3000); }
    catch { setPendingAction(null); }
  };

  const handleDemote = async () => {
    setPendingAction('demoting');
    try { await api.demoteAgent(agent.name); setTimeout(() => onRefresh?.(), 3000); }
    catch { setPendingAction(null); }
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

  const desc = agent.description || agent.template?.description || 'Copilot session';
  const truncDesc = desc.length > 45 ? desc.slice(0, 42) + '…' : desc;
  const paneLabel = agent.pane?.target;
  const displayModel = agent.model || agent.template?.model;

  return (
    <div className={`group/card border border-border rounded-lg overflow-hidden transition-colors hover:border-border-1 ${GLOW[status] || ''}`}>
      {/* Collapsed row — 52px */}
      <button
        className="w-full flex items-center gap-2.5 px-3 h-[52px] text-left bg-bg-1 hover:bg-bg-2/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[status] || 'bg-fg-2/30'} ${status === 'running' ? 'dot-live' : ''}`} />
        {onTogglePin && (
          <button
            className={`text-[11px] flex-shrink-0 transition-opacity ${pinned ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-50 hover:!opacity-100'}`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            title={pinned ? 'Unpin agent' : 'Pin agent'}
          >
            {pinned ? '⭐' : '☆'}
          </button>
        )}
        <span className="text-sm font-medium truncate min-w-0">{agent.name}</span>
        {isHeadless && (
          <span className="text-[9px] font-mono text-cyan/70 bg-cyan/5 px-1.5 py-0.5 rounded flex-shrink-0">⚡ headless</span>
        )}
        {agent.template && (
          <span className="text-[9px] font-mono text-purple/70 bg-purple/5 px-1.5 py-0.5 rounded flex-shrink-0">{agent.template.name}</span>
        )}
        <span className="text-[10px] text-fg-2 truncate hidden sm:inline">{truncDesc}</span>
        {paneLabel && (
          <span className="text-[9px] font-mono text-blue/70 bg-blue/5 px-1.5 py-0.5 rounded flex-shrink-0">{paneLabel}</span>
        )}
        <span className={`ml-auto text-[10px] font-medium flex-shrink-0 ${TEXT_COLOR[status] || 'text-fg-2'}`}>{status}</span>
        <span className="text-fg-2/40 text-[10px] flex-shrink-0 transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}>▸</span>
      </button>

      {/* Expanded panel — CSS max-height transition */}
      <div
        className="transition-[max-height,opacity] duration-200 ease-out overflow-hidden"
        style={{ maxHeight: expanded ? 300 : 0, opacity: expanded ? 1 : 0 }}
      >
        <div className="px-3 py-2.5 border-t border-border bg-bg-1/50 space-y-2">
          {/* Description */}
          <p className="text-[11px] text-fg-2 leading-relaxed">{desc}</p>

          {/* Metadata badges */}
          {(displayModel || (agent.flags && agent.flags.length > 0) || isHeadless) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {displayModel && (
                <span className="text-[9px] font-mono text-green/70 bg-green/5 px-1.5 py-0.5 rounded">{displayModel}</span>
              )}
              {agent.reasoningEffort && (
                <span className="text-[9px] font-mono text-orange/70 bg-orange/5 px-1.5 py-0.5 rounded">effort: {agent.reasoningEffort}</span>
              )}
              {agent.agentMode && agent.agentMode !== 'interactive' && (
                <span className="text-[9px] font-mono text-purple/70 bg-purple/5 px-1.5 py-0.5 rounded">mode: {agent.agentMode}</span>
              )}
              {agent.flags?.map(f => (
                <span key={f} className="text-[9px] font-mono text-yellow/70 bg-yellow/5 px-1.5 py-0.5 rounded">{f}</span>
              ))}
            </div>
          )}

          {/* Task status */}
          {agent.task && (
            <p className="text-[10px] text-blue italic">📋 {agent.task}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {pendingAction ? (
              <span className="text-[10px] text-fg-2 italic">
                {pendingAction === 'stopping' ? 'Stopping…' : pendingAction === 'starting' ? 'Starting…'
                  : pendingAction === 'promoting' ? 'Promoting…' : 'Demoting…'}
              </span>
            ) : status === 'running' || status === 'idle' ? (
              <>
                <button className="text-[10px] px-2.5 py-1 rounded bg-bg-2 text-fg-1 border border-border hover:border-border-1"
                  onClick={(e) => { e.stopPropagation(); setShowChat(true); }}>Chat</button>
                <button className="text-[10px] px-2.5 py-1 rounded bg-bg-2 text-red border border-border hover:border-red/30"
                  onClick={(e) => { e.stopPropagation(); handleStop(); }}>Stop</button>
                {/* Promote/Demote */}
                {isHeadless ? (
                  <button className="text-[10px] px-2.5 py-1 rounded bg-blue/10 text-blue border border-blue/20"
                    onClick={(e) => { e.stopPropagation(); handlePromote(); }} title="Promote to terminal pane">⬆ Pane</button>
                ) : agent.pane && agent.sessionId && !agent.sessionId.startsWith('pane-') ? (
                  <button className="text-[10px] px-2.5 py-1 rounded bg-cyan/10 text-cyan border border-cyan/20"
                    onClick={(e) => { e.stopPropagation(); handleDemote(); }} title="Demote to headless (SDK)">⬇ Headless</button>
                ) : null}
                {/* Model switch (headless only) */}
                {isHeadless && (
                  <button className="text-[10px] px-2.5 py-1 rounded border border-border bg-bg-2 text-fg-2 hover:text-fg-1"
                    onClick={(e) => { e.stopPropagation(); setShowModelPicker(!showModelPicker); }}>🔄 Model</button>
                )}
              </>
            ) : status === 'stopped' ? (
              <>
                {agent.sessionId && !agent.sessionId.startsWith('pane-') && (
                  <button className="text-[10px] px-2.5 py-1 rounded bg-green/10 text-green border border-green/20 font-medium"
                    onClick={(e) => { e.stopPropagation(); handleResume(); }}>Resume</button>
                )}
                {agent.template && (
                  <button className="text-[10px] px-2.5 py-1 rounded bg-blue/10 text-blue border border-blue/20 font-medium"
                    onClick={(e) => { e.stopPropagation(); setShowLaunchConfig(agent.sessionId && !agent.sessionId.startsWith('pane-') ? 'resume' : 'start'); }}>⚙</button>
                )}
              </>
            ) : null}

            {agent.pane && (status === 'running' || status === 'idle') && (
              <button className="text-[10px] px-2.5 py-1 rounded border border-border bg-bg-2 text-fg-2 hover:text-fg-1"
                onClick={(e) => { e.stopPropagation(); openTerminal(agent.name, agent.pane!.target); }}>Output</button>
            )}

            {agent.sessionId && !agent.sessionId.startsWith('pane-') && onViewHistory && (
              <button className="text-[10px] px-2.5 py-1 rounded border border-border bg-bg-2 text-fg-2 hover:text-fg-1"
                onClick={(e) => { e.stopPropagation(); onViewHistory(agent.id); }}>History</button>
            )}

            <button className="text-[10px] px-2.5 py-1 rounded border border-border bg-bg-2 text-fg-2 hover:text-fg-1"
              onClick={(e) => { e.stopPropagation(); setShowEdit(true); }}>Edit</button>
          </div>

          {/* Model picker (inline) */}
          {showModelPicker && isHeadless && (
            <div className="flex items-center gap-1.5 p-2 bg-bg rounded border border-border">
              <input type="text" className="flex-1 bg-bg-1 border border-border rounded px-2 py-1 text-[10px] text-fg"
                placeholder="Model (e.g. claude-haiku-4.5)" value={modelInput} onChange={e => setModelInput(e.target.value)} />
              <select className="bg-bg-1 border border-border rounded px-1.5 py-1 text-[10px] text-fg"
                value={effortInput} onChange={e => setEffortInput(e.target.value)}>
                <option value="">effort</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <button className="text-[10px] px-2 py-1 rounded bg-green/10 text-green border border-green/20"
                onClick={handleModelSwitch}>Apply</button>
            </div>
          )}

          {/* Mode switcher (headless only) */}
          {isHeadless && (status === 'running' || status === 'idle') && (
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-fg-2 mr-1">Mode:</span>
              {['interactive', 'plan', 'autopilot'].map(m => (
                <button key={m} className={`text-[9px] px-2 py-0.5 rounded border ${
                  agent.agentMode === m ? 'bg-purple/10 text-purple border-purple/30 font-medium' : 'border-border text-fg-2 hover:text-fg-1'
                }`} onClick={(e) => { e.stopPropagation(); handleModeSwitch(m); }}>{m}</button>
              ))}
            </div>
          )}

          {/* Resume error */}
          {resumeError && <p className="text-[10px] text-red">⚠ {resumeError}</p>}
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
          : <ChatPanel agentName={agent.id} onClose={() => setShowChat(false)} />,
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
  prev.pinned === next.pinned
);

export default AgentCard;
