import { useState, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import type { AgentData } from '../lib/api';
import { api } from '../lib/api';
import { LaunchConfigPanel } from './LaunchConfigPanel';
import { useTerminalPanel } from './TerminalPanel';
import ChatPanel from './ChatPanel';
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
  const [pendingAction, setPendingAction] = useState<'stopping' | 'starting' | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [showLaunchConfig, setShowLaunchConfig] = useState<'resume' | 'start' | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
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

  const desc = agent.template?.description || 'Copilot session';
  const truncDesc = desc.length > 45 ? desc.slice(0, 42) + '…' : desc;
  const paneLabel = agent.pane?.target;

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

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {pendingAction ? (
              <span className="text-[10px] text-fg-2 italic">{pendingAction === 'stopping' ? 'Stopping…' : 'Starting…'}</span>
            ) : status === 'running' || status === 'idle' ? (
              <>
                <button className="text-[10px] px-2.5 py-1 rounded bg-bg-2 text-fg-1 border border-border hover:border-border-1"
                  onClick={(e) => { e.stopPropagation(); setShowChat(true); }}>Chat</button>
                <button className="text-[10px] px-2.5 py-1 rounded bg-bg-2 text-red border border-border hover:border-red/30"
                  onClick={(e) => { e.stopPropagation(); handleStop(); }}>Stop</button>
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
        <ChatPanel agentName={agent.id} onClose={() => setShowChat(false)} />,
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
