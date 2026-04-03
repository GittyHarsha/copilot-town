import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { MarkdownContent, relativeTime } from './ChatMarkdown';
import { ThinkingBlock, InlineToolCall, ToolTimeline, type ToolCall, type UsageInfo } from './ChatWidgets';
import { useHeadlessChat, type ChatMessage, type UseHeadlessChatReturn } from '../hooks/useHeadlessChat';
import { api } from '../lib/api';
import { getCachedModels, fetchModels, type ModelInfo } from '../lib/models';

export type { ChatMessage, UseHeadlessChatReturn } from '../hooks/useHeadlessChat';

interface Props {
  agentName: string;
  onClose: () => void;
  onResize?: (width: number) => void;
  /** When true, panel fills parent width (no resize handle, no fixed width) */
  embedded?: boolean;
  /** When true, hides the built-in header (agent name, close, toolbar). Parent provides its own. */
  headerless?: boolean;
  /** Pass a pre-created useHeadlessChat return to share state with the parent. */
  externalChat?: UseHeadlessChatReturn;
}

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */

const SLASH_COMMANDS = [
  { cmd: 'compact', icon: '🗜️', label: 'Compress context', desc: 'Reduce token usage by summarizing history' },
  { cmd: 'clear',   icon: '🗑️', label: 'Clear chat',       desc: 'Remove all messages from view' },
  { cmd: 'abort',   icon: '⏹️', label: 'Stop response',    desc: 'Cancel the current generation' },
  { cmd: 'mode',    icon: '🎛️', label: 'Change mode',      desc: 'interactive / plan / autopilot', suffix: ' ' },
  { cmd: 'model',   icon: '🧠', label: 'Switch model',     desc: 'e.g. claude-sonnet-4', suffix: ' ' },
  { cmd: 'help',    icon: '📖', label: 'Show help',        desc: 'List all available commands' },
] as const;

const MODE_OPTIONS = [
  { value: 'interactive', icon: '💬', desc: 'You approve each action' },
  { value: 'plan',        icon: '📋', desc: 'Agent plans, you approve execution' },
  { value: 'autopilot',   icon: '🚀', desc: 'Agent works autonomously' },
] as const;

const TIER_ICONS: Record<string, string> = { premium: '💎', standard: '⚡', fast: '🏎️' };

/** Parses the current input to determine what slash menu to show */
function parseSlashInput(input: string) {
  if (!input.startsWith('/')) return { phase: 'none' as const };
  const rest = input.slice(1);
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx === -1) return { phase: 'command' as const, query: rest.toLowerCase() };
  const cmd = rest.slice(0, spaceIdx).toLowerCase();
  const arg = rest.slice(spaceIdx + 1).toLowerCase();
  if (cmd === 'model') return { phase: 'model' as const, query: arg };
  if (cmd === 'mode')  return { phase: 'mode' as const, query: arg };
  return { phase: 'none' as const };
}


/* ═══════════════════════════════════════════════════════════════════
   Sub-components (panel-specific)
   ═══════════════════════════════════════════════════════════════════ */

/** Empty state with quick suggestions */
function EmptyState({ onSend, compact }: { onSend: (text: string) => void; compact?: boolean }) {
  const suggestions = [
    { label: 'Status check', prompt: 'What are you currently working on?' },
    { label: 'Explore codebase', prompt: 'Give me an overview of this codebase' },
    { label: 'Run tests', prompt: 'Run the test suite and report results' },
    { label: 'Review changes', prompt: 'Review the current git diff' },
  ];
  if (compact) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-3">
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-border/30 flex items-center justify-center mb-2">
          <span className="text-xs opacity-40">⚡</span>
        </div>
        <p className="text-[10px] text-fg-2/40 mb-3">Send a message to start</p>
        <div className="flex flex-wrap gap-1 justify-center">
          {suggestions.slice(0, 2).map(s => (
            <button key={s.label} onClick={() => onSend(s.prompt)}
              className="text-[9px] px-2 py-1 rounded-md bg-bg-1 text-fg-2/60 hover:text-fg hover:bg-bg-2 border border-border/40 transition-all"
            >{s.label}</button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/10 to-violet-500/10 border border-border/40 flex items-center justify-center mb-4">
        <span className="text-xl opacity-40">⚡</span>
      </div>
      <p className="text-sm text-fg/60 mb-1">Start a conversation</p>
      <p className="text-[11px] text-fg-2/40 mb-5 max-w-[280px]">Send a message, relay from another agent, or try a quick action below.</p>
      <div className="grid grid-cols-2 gap-2 w-full max-w-[320px]">
        {suggestions.map(s => (
          <button
            key={s.label}
            onClick={() => onSend(s.prompt)}
            className="text-[11px] text-left px-3 py-2 rounded-lg bg-bg-1 text-fg-2 hover:text-fg hover:bg-bg-2 border border-border hover:border-border-1 transition-all"
          >{s.label}</button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════════ */

export default function HeadlessChatPanel({ agentName, onClose, onResize, embedded, headerless, externalChat }: Props) {
  const compact = !!headerless; // compact mode for grid cells
  /* ── Shared chat hook (WS, streaming, messages, actions) ── */
  const ownChat = useHeadlessChat(externalChat ? null : agentName);
  const chat = externalChat || ownChat;
  const { messages, connected, sending, historyLoaded, liveIntent, liveUsage, agentMode, pendingPermission, reconnectCountdown, turnStartedAt } = chat;

  const [input, setInput] = useState('');
  /* ── Search state ── */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  /* ── Bookmarks ── */
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`chat-bookmarks-${agentName}`);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [showBookmarksOnly, setShowBookmarksOnly] = useState(false);
  /* ── Resizable width ── */
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('chat-panel-width') || '480');
    return Math.max(320, Math.min(saved, window.innerWidth * 0.6));
  });
  /* ── Streaming elapsed ── */
  const [elapsedDisplay, setElapsedDisplay] = useState('');
  /* ── Scroll-to-bottom visibility ── */
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [modeConfirmed, setModeConfirmed] = useState(false);

  const [slashIdx, setSlashIdx] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>(() => getCachedModels());

  // Fetch models on mount so they're ready for /model sub-menu
  useEffect(() => { fetchModels().then(setModels); }, []);

  const slashParsed = useMemo(() => parseSlashInput(input), [input]);

  // Build the unified options list for the slash menu
  const slashOptions = useMemo(() => {
    if (slashParsed.phase === 'command') {
      return SLASH_COMMANDS
        .filter(c => c.cmd.startsWith(slashParsed.query))
        .map(c => ({ key: c.cmd, icon: c.icon, label: `/${c.cmd}`, desc: c.desc, fill: `/${c.cmd}${c.suffix ?? ''}`, execute: !c.suffix }));
    }
    if (slashParsed.phase === 'mode') {
      return MODE_OPTIONS
        .filter(m => m.value.startsWith(slashParsed.query))
        .map(m => ({ key: m.value, icon: m.icon, label: m.value, desc: m.desc, fill: `/mode ${m.value}`, execute: true }));
    }
    if (slashParsed.phase === 'model') {
      return models
        .filter(m => m.value.includes(slashParsed.query) || m.label.toLowerCase().includes(slashParsed.query))
        .map(m => ({ key: m.value, icon: TIER_ICONS[m.tier] || '⚡', label: m.label, desc: m.value, fill: `/model ${m.value}`, execute: true }));
    }
    return [];
  }, [slashParsed, models]);

  const showSlashMenu = slashOptions.length > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const resizeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ── Auto-scroll: follow content if user is at the bottom, stop if they scrolled up ── */
  const isNearBottom = useRef(true);
  const isUserScrolled = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If user is at/near the bottom, keep following all updates (new messages + streaming deltas)
    // If user scrolled up intentionally, leave them alone
    if (isNearBottom.current && !isUserScrolled.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  /* ── Scroll listener — tracks position for auto-scroll + scroll-to-bottom button ── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottom.current = gap <= 200;
      setIsScrolledUp(gap > 200);
      // Track intentional user scroll-up to prevent auto-scroll yanking
      isUserScrolled.current = gap > 200;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  /* ── Auto-focus input ── */
  useEffect(() => {
    if (compact) return; // Don't steal focus in compact/grid mode
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  /* ── Escape to close / Ctrl+F search ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }
      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery('');
          setSearchIndex(0);
          inputRef.current?.focus();
          return;
        }
        const tag = document.activeElement?.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          (document.activeElement as HTMLElement).blur();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, searchOpen]);

  /* ── Search matches ── */
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .filter(m => m.role !== 'system' && m.text.toLowerCase().includes(q))
      .map(m => m.id);
  }, [messages, searchQuery]);

  /* ── Scroll to current search match ── */
  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const matchId = searchMatches[searchIndex];
    if (!matchId) return;
    const el = document.getElementById(`msg-${matchId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [searchOpen, searchIndex, searchMatches]);

  /* ── Elapsed time counter — starts from turn_start, not send click ── */
  useEffect(() => {
    if (!sending) {
      setElapsedDisplay('');
      return;
    }
    if (!turnStartedAt) {
      // Sending but turn hasn't started yet — show "…"
      setElapsedDisplay('…');
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      setElapsedDisplay(mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`);
    }, 1000);
    // Set initial value immediately
    const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000);
    setElapsedDisplay(elapsed > 0 ? `${elapsed}s` : '0s');
    return () => clearInterval(interval);
  }, [sending, turnStartedAt]);

  /* ── Persist bookmarks ── */
  useEffect(() => {
    try { localStorage.setItem(`chat-bookmarks-${agentName}`, JSON.stringify([...bookmarks])); } catch {}
  }, [bookmarks, agentName]);

  /* ── Persist panel width ── */
  useEffect(() => {
    localStorage.setItem('chat-panel-width', String(panelWidth));
    onResize?.(panelWidth);
  }, [panelWidth, onResize]);

  /* ── Drag resize handlers ── */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = dragStartX.current - e.clientX;
      const w = Math.max(320, Math.min(dragStartWidth.current + delta, window.innerWidth * 0.6));
      setPanelWidth(w);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  /* ── Visible messages (bookmark filter) ── */
  const visibleMessages = useMemo(() => {
    if (showBookmarksOnly) return messages.filter(m => bookmarks.has(m.id) || m.role === 'system');
    return messages;
  }, [messages, bookmarks, showBookmarksOnly]);

  const toggleBookmark = useCallback((id: string) => {
    setBookmarks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const renderHighlightedText = (text: string) => {
    if (!searchOpen || !searchQuery.trim()) return text;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    if (parts.length === 1) return text;
    return parts.map((part, i) =>
      part.toLowerCase() === searchQuery.toLowerCase()
        ? <mark key={i} className="bg-yellow-400/30 text-inherit rounded-sm px-0.5">{part}</mark>
        : part
    );
  };

  /* ── Slash command handler ── */
  const handleSlashCommand = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;

    const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
    const arg = args.join(' ');
    const sysMsg = (msg: string) => {
      chat.setMessages(prev => [...prev, { id: `sys-${Date.now()}`, role: 'system' as const, text: msg, timestamp: Date.now() }]);
    };

    switch (cmd.toLowerCase()) {
      case 'compact':
        chat.compact();
        sysMsg('🗜️ Compacting context…');
        return true;
      case 'clear':
        chat.setMessages([]);
        sysMsg('🗑️ Chat cleared');
        return true;
      case 'abort':
      case 'stop':
        chat.abort();
        return true;
      case 'mode':
        if (['plan', 'autopilot', 'interactive'].includes(arg.toLowerCase())) {
          chat.changeMode(arg.toLowerCase());
          sysMsg(`Mode → ${arg.toLowerCase()}`);
        } else {
          sysMsg(`Current mode: ${agentMode}. Usage: /mode [plan|autopilot|interactive]`);
        }
        return true;
      case 'model':
        if (arg) {
          api.setAgentModel(agentName, arg).then(() => sysMsg(`Model → ${arg}`)).catch(e => sysMsg(`⚠ ${e.message}`));
        } else {
          sysMsg('Usage: /model <model-id>  (e.g. /model claude-sonnet-4)');
        }
        return true;
      case 'help':
        sysMsg([
          '📖 Slash commands:',
          '  /compact — compress context',
          '  /clear — clear chat history',
          '  /abort — stop current response',
          '  /mode [plan|autopilot|interactive]',
          '  /model <model-id>',
          '  /help — show this',
        ].join('\n'));
        return true;
      default:
        sysMsg(`Unknown command: /${cmd}. Type /help for available commands.`);
        return true;
    }
  }, [chat, agentName, agentMode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    /* ── Slash menu navigation ── */
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => (i + 1) % slashOptions.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => (i - 1 + slashOptions.length) % slashOptions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const picked = slashOptions[slashIdx];
        if (picked) {
          if (picked.execute) { handleSlashCommand(picked.fill); setInput(''); }
          else { setInput(picked.fill); }
          setSlashIdx(0);
        }
        return;
      }
      if (e.key === 'Escape') { setInput(''); setSlashIdx(0); return; }
    }

    /* ── Input history navigation ── */
    if (e.key === 'ArrowUp' && !input && !e.shiftKey) {
      e.preventDefault();
      const hist = chat.inputHistory.current;
      if (hist.length === 0) return;
      const idx = Math.min(chat.historyIndex.current + 1, hist.length - 1);
      chat.historyIndex.current = idx;
      setInput(hist[hist.length - 1 - idx]);
      return;
    }
    if (e.key === 'ArrowDown' && chat.historyIndex.current >= 0) {
      e.preventDefault();
      const hist = chat.inputHistory.current;
      const idx = chat.historyIndex.current - 1;
      chat.historyIndex.current = idx;
      if (idx < 0) { setInput(''); return; }
      setInput(hist[hist.length - 1 - idx]);
      return;
    }
    if (e.key === 'q' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (input.trim()) chat.send(input, 'enqueue');
      setInput('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim().startsWith('/')) {
        handleSlashCommand(input);
        setInput('');
        return;
      }
      if (sending) { if (input.trim()) { chat.send(input, 'steer'); setInput(''); } }
      else { chat.send(input); setInput(''); }
    }
  };

  /* ═══════════════════════════════════════════════════════════════════
     Render
     ═══════════════════════════════════════════════════════════════════ */

  return (
    <div className={`${embedded ? 'flex-1 min-h-0' : 'h-full'} flex flex-col relative ${headerless ? 'bg-transparent' : 'bg-bg border-l border-border/50'}`} style={embedded ? undefined : { width: panelWidth }}>

      {/* ── Resize handle ── */}
      {!embedded && (
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:w-1.5 hover:bg-blue-500/30 active:bg-blue-500/40 z-10"
        style={{ transition: 'all var(--duration-medium) var(--ease-standard)' }}
        onMouseDown={startDrag}
      />
      )}

      {/* ── Header ── */}
      {!headerless && (
        <div className="flex-shrink-0 border-b border-border/40">
          {/* Top row: agent name + close */}
          <div className="flex items-center justify-between px-5 pt-3.5 pb-2">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full flex-shrink-0 dot-live"
                style={{ background: connected ? '#4ade80' : '#f87171' }} />
              <span className="text-sm font-semibold tracking-tight text-fg">{agentName}</span>
            </div>
            <button onClick={onClose} aria-label="Close chat"
              className="text-fg-2/40 hover:text-fg w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-2 transition-all">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {/* Toolbar row: mode + controls */}
          <div className="flex items-center justify-between px-5 pb-2.5">
            <div className="flex items-center gap-2">
              {/* Mode segmented control — no "interactive" */}
              <div className="flex items-center bg-bg-1 rounded-lg border border-border p-0.5">
                {(['plan', 'autopilot'] as const).map(m => (
                  <button
                    key={m}
                    onClick={async () => {
                      await chat.changeMode(m);
                      setModeConfirmed(true);
                      setTimeout(() => setModeConfirmed(false), 600);
                    }}
                    disabled={!connected}
                    aria-label={`Set mode to ${m}`}
                    aria-pressed={agentMode === m}
                    className={`text-[10px] px-2.5 py-1 rounded-md transition-all font-medium ${
                      agentMode === m
                        ? `bg-bg-3 text-fg shadow-sm border border-border/40 ${modeConfirmed ? 'ring-1 ring-emerald-400/40' : ''}`
                        : 'text-fg-2/50 hover:text-fg-2 border border-transparent'
                    } disabled:opacity-30`}
                  >{m}</button>
                ))}
              </div>
              {/* Live intent */}
              {liveIntent && (
                <span className="text-[10px] text-blue-400/60 truncate max-w-[180px] flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-blue-400/50 animate-pulse flex-shrink-0" />
                  {liveIntent}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowBookmarksOnly(b => !b)}
                aria-label={showBookmarksOnly ? 'Show all messages' : 'Show bookmarks only'}
                aria-pressed={showBookmarksOnly}
                className={`text-[11px] w-7 h-7 flex items-center justify-center rounded-lg transition-all ${
                  showBookmarksOnly ? 'bg-amber-500/10 text-amber-400' : 'text-fg-2/30 hover:text-fg-2 hover:bg-bg-2'
                }`}
                title={showBookmarksOnly ? 'Show all messages' : 'Show bookmarks only'}
              >🔖</button>
              {sending && (
                <button onClick={chat.abort}
                  className="text-[10px] px-2.5 py-1 rounded-lg bg-red-500/8 text-red-400 hover:bg-red-500/15 border border-red-500/12 transition-all font-medium">
                  ⏹ Abort
                </button>
              )}
              <button onClick={chat.compact}
                className="text-fg-2/30 hover:text-fg-2 text-[11px] w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-2 transition-all" title="Compact context">
                🗜️
              </button>
            </div>
          </div>
        </div>
      )}

        {/* ── Streaming status bar — shows immediately when sending, not just after turn_start ── */}
        {sending && (
          <div className={`flex items-center gap-2 bg-blue-500/[0.03] border-b border-blue-500/10 flex-shrink-0 ${compact ? 'px-2.5 py-1 text-[10px]' : 'px-5 py-2 text-[11px]'}`}>
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <span className="text-blue-400/70 truncate">{liveIntent || 'Responding…'}</span>
            <span className="ml-auto text-fg-2/30 tabular-nums">{elapsedDisplay}</span>
            {!compact && liveUsage?.outputTokens && <span className="text-fg-2/30 tabular-nums">{liveUsage.outputTokens.toLocaleString()} tok</span>}
          </div>
        )}

        {/* ── Disconnected banner with countdown ── */}
        {!connected && !sending && historyLoaded && (
          <div className={`flex items-center gap-2 bg-amber-500/[0.06] border-b border-amber-500/15 flex-shrink-0 ${compact ? 'px-2.5 py-1 text-[10px]' : 'px-5 py-1.5 text-[11px]'}`}>
            <span className="w-2 h-2 rounded-full bg-amber-400/70 animate-pulse flex-shrink-0" />
            <span className="text-amber-400/70">
              {reconnectCountdown ? `Reconnecting in ${reconnectCountdown}s…` : 'Reconnecting…'}
            </span>
          </div>
        )}

        {/* ── Search overlay ── */}
        {searchOpen && (
          <div className="flex items-center gap-2 px-4 py-2 bg-bg-1 border-b border-border/40 flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-fg-2/40 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={searchInputRef}
              className="flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-2/30"
              placeholder="Search messages…"
              aria-label="Search messages"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchIndex(0); }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSearchIndex(i => searchMatches.length > 0 ? (i + 1) % searchMatches.length : 0);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSearchIndex(i => searchMatches.length > 0 ? (i - 1 + searchMatches.length) % searchMatches.length : 0);
                } else if (e.key === 'Escape') {
                  setSearchOpen(false);
                  setSearchQuery('');
                  setSearchIndex(0);
                  inputRef.current?.focus();
                }
              }}
            />
            {searchQuery && (
              <span className="text-[10px] text-fg-2/40 tabular-nums flex-shrink-0">
                {searchMatches.length > 0 ? `${searchIndex + 1} of ${searchMatches.length}` : 'No matches'}
              </span>
            )}
            <button
              onClick={() => setSearchIndex(i => searchMatches.length > 0 ? (i - 1 + searchMatches.length) % searchMatches.length : 0)}
              disabled={searchMatches.length === 0}
              aria-label="Previous match"
              className={`text-fg-2/40 hover:text-fg w-5 h-5 flex items-center justify-center rounded hover:bg-bg-2 transition-all flex-shrink-0 text-[10px] ${searchMatches.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
            >↑</button>
            <button
              onClick={() => setSearchIndex(i => searchMatches.length > 0 ? (i + 1) % searchMatches.length : 0)}
              disabled={searchMatches.length === 0}
              aria-label="Next match"
              className={`text-fg-2/40 hover:text-fg w-5 h-5 flex items-center justify-center rounded hover:bg-bg-2 transition-all flex-shrink-0 text-[10px] ${searchMatches.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
            >↓</button>
            <button
              onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchIndex(0); }}
              aria-label="Close search"
              className="text-fg-2/40 hover:text-fg w-5 h-5 flex items-center justify-center rounded hover:bg-bg-2 transition-all flex-shrink-0"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {/* ── Messages ── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {messages.length === 0 && historyLoaded ? (
            <EmptyState onSend={(text) => { chat.send(text); }} compact={headerless} />
          ) : messages.length === 0 ? (
            /* History still loading — show subtle placeholder instead of EmptyState flash */
            <div className="flex items-center justify-center h-full text-fg-2/30 text-xs">Loading…</div>
          ) : (
            <div className={headerless ? 'px-2.5 py-2 space-y-2' : 'px-5 py-4 space-y-4'}>
              {visibleMessages.map((m, idx) => {
                const isDimmed = searchOpen && searchQuery && !searchMatches.includes(m.id);
                const isBookmarked = bookmarks.has(m.id);
                const isCurrentMatch = searchOpen && searchQuery && searchMatches[searchIndex] === m.id;
                const matchHighlight = isCurrentMatch ? 'ring-2 ring-yellow-400/60 rounded-lg shadow-[0_0_12px_rgba(250,204,21,0.15)]' : '';
                const prevMsg = idx > 0 ? visibleMessages[idx - 1] : null;
                const isGrouped = prevMsg && prevMsg.role === m.role && m.role !== 'system' && (m.timestamp - prevMsg.timestamp) < 60_000;

                /* ── System message ── */
                if (m.role === 'system') {
                  return (
                    <div key={m.id} className="flex justify-center animate-fade-in">
                      <span className="text-[10px] text-fg-2/40 bg-bg-2/30 px-3 py-1 rounded-full border border-border/20">
                        {m.text}
                      </span>
                    </div>
                  );
                }

                /* ── User message ── */
                if (m.role === 'user') {
                  return (
                    <div key={m.id} id={`msg-${m.id}`} className={`flex justify-end animate-message-slide-up transition-opacity duration-200 ${isDimmed ? 'opacity-30' : ''} ${matchHighlight}`}>
                      <div className={`max-w-[85%] relative ${isBookmarked ? 'border-r-2 border-amber-400/50 pr-3' : ''}`}>
                        {/* Relay sender — only show for agent-to-agent messages */}
                        {m.from && m.from !== 'you' && m.from !== 'dashboard' && m.from !== 'external' && (
                          <div className="text-[10px] text-fg-2/40 mb-1 text-right">
                            ↗ from <span className="text-blue-400/60 font-medium">{m.from}</span>
                          </div>
                        )}
                        {/* Action badge */}
                        {m.action && (
                          <div className="flex justify-end mb-1">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${
                              m.action === 'enqueue' ? 'bg-amber-500/8 text-amber-400/60 border border-amber-500/10' : 'bg-cyan-500/8 text-cyan-400/60 border border-cyan-500/10'
                            }`}>{m.action === 'enqueue' ? '📋 queued' : '↯ steer'}</span>
                          </div>
                        )}
                        <div className={compact
                          ? 'px-3 py-1.5 bg-blue-500/[0.12] text-fg text-[11px] leading-relaxed border border-blue-500/[0.15] whitespace-pre-wrap break-words'
                          : 'px-4 py-2.5 bg-blue-500/[0.15] text-fg text-[13px] leading-relaxed border border-blue-500/[0.2] whitespace-pre-wrap break-words'
                        } style={{ borderRadius: compact ? '14px 14px 4px 14px' : '18px 18px 4px 18px' }}>
                          {renderHighlightedText(m.text)}
                        </div>
                        <div className="flex items-center justify-end gap-2 mt-0.5">
                          <span className="text-[10px] text-fg-2/20 tabular-nums">{relativeTime(m.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  );
                }

                /* ── Agent message ── */
                return (
                  <div key={m.id} id={`msg-${m.id}`} className={`group/agent flex gap-2.5 animate-message-slide-up transition-opacity duration-200 ${isDimmed ? 'opacity-30' : ''} ${isBookmarked ? 'border-l-2 border-amber-400/50 pl-2' : ''} ${matchHighlight} ${isGrouped ? (compact ? 'mt-0' : 'mt-1') : ''}`}>
                    {/* Agent avatar — hidden for grouped messages to eliminate spacing */}
                    {!compact && (
                      <div className={`w-7 h-7 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[12px] ${isGrouped ? 'hidden' : ''}`}
                        style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15))', border: '1px solid rgba(139,92,246,0.2)' }}>
                        ⚡
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                    {/* Single unified agent bubble */}
                    {(m.thinking || m.text || (m.tools && m.tools.length > 0) || m.streaming) && (
                      <div style={{
                        background: 'var(--color-bg-2)',
                        borderRadius: compact ? '4px 14px 14px 14px' : '4px 18px 18px 18px',
                        padding: compact ? '6px 10px' : '12px 14px',
                        border: '1px solid var(--color-border)',
                        overflow: 'hidden',
                      }}>
                        {/* Thinking section */}
                        {m.thinking && (
                          <div className={m.text || (m.tools && m.tools.length > 0) ? 'mb-2 pb-2 border-b border-border/30' : ''}>
                            <ThinkingBlock text={m.thinking} isStreaming={!!m.streaming} hasResponse={!!m.text} />
                          </div>
                        )}

                        {/* Tools section */}
                        {m.tools && m.tools.length > 0 && (
                          <div className={m.text ? 'mb-2 pb-2 border-b border-border/30' : ''}>
                            <ToolTimeline tools={m.tools} compact={compact} />
                          </div>
                        )}

                        {/* Response text */}
                        {m.text ? (
                          <div className={compact ? 'text-[11px] leading-relaxed text-fg/90' : 'text-[13px] leading-relaxed text-fg/90'}>
                            <MarkdownContent content={m.text} />
                            {m.streaming && (
                              <span className="inline-block w-[2px] h-4 bg-blue-400/60 ml-0.5 animate-pulse rounded-full align-text-bottom" />
                            )}
                          </div>
                        ) : m.streaming && !m.thinking && !(m.tools && m.tools.length > 0) ? (
                          /* Streaming placeholder — only when nothing else is showing yet */
                          <div className="flex items-center gap-2 py-1">
                            <div className="flex gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '150ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                            <span className="text-[11px] text-fg-2/30">Thinking…</span>
                          </div>
                        ) : null}

                        {/* Intent while streaming */}
                        {m.intent && m.streaming && (
                          <div className="text-[10px] text-blue-400/40 mt-1 flex items-center gap-1">
                            <span className="w-1 h-1 rounded-full bg-blue-400/40 animate-pulse" />
                            {m.intent}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Footer: usage/tokens — show on hover in compact mode, always in full mode */}
                    {(m.tokens || m.usage) && (
                      <div className={`flex items-center gap-3 text-[10px] px-1 ${compact ? 'opacity-0 group-hover/agent:opacity-100 transition-opacity h-0 group-hover/agent:h-auto overflow-hidden' : ''}`}>
                        {m.usage?.model && <span className="text-fg-2/25">{m.usage.model}</span>}
                        {m.tokens && <span className={`tabular-nums ${m.streaming ? 'text-blue-400/40' : 'text-fg-2/20'}`}>{m.tokens.toLocaleString()} out{m.streaming && '…'}</span>}
                        {m.usage?.inputTokens && <span className="text-fg-2/20 tabular-nums">{m.usage.inputTokens.toLocaleString()} in</span>}
                        {m.usage?.duration && !m.streaming && <span className="text-fg-2/20 tabular-nums">{(m.usage.duration / 1000).toFixed(1)}s</span>}
                        <span className="ml-auto text-fg-2/20 tabular-nums">{relativeTime(m.timestamp)}</span>
                      </div>
                    )}
                    </div>
                  </div>
                );
              })}
              {/* Immediate "Thinking…" feedback when sending but no agent message placeholder yet */}
              {sending && !messages.some(m => m.role === 'agent' && m.streaming) && (
                <div className={`flex gap-2.5 animate-fade-in ${compact ? '' : ''}`}>
                  {!compact && (
                    <div className="w-7 h-7 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[12px]"
                      style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15))', border: '1px solid rgba(139,92,246,0.2)' }}>
                      ⚡
                    </div>
                  )}
                  <div style={{
                    background: 'var(--color-bg-2)',
                    borderRadius: compact ? '4px 14px 14px 14px' : '4px 18px 18px 18px',
                    padding: compact ? '6px 10px' : '12px 14px',
                    border: '1px solid var(--color-border)',
                  }}>
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                      <span className="text-[11px] text-fg-2/30">
                        {turnStartedAt ? (() => {
                          const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000);
                          if (elapsed > 30) return `Thinking… ${elapsed}s (may be slow)`;
                          return `Thinking… ${elapsed}s`;
                        })() : 'Thinking…'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {isScrolledUp && (
            <button
              onClick={() => { isNearBottom.current = true; isUserScrolled.current = false; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
              style={{
                position: 'sticky', bottom: 12, alignSelf: 'center',
                width: 40, height: 40, borderRadius: '50%',
                background: 'var(--color-bg-2)', border: 'none',
                color: 'var(--color-fg-1)', fontSize: '1rem', cursor: 'pointer',
                boxShadow: 'var(--elevation-2)', zIndex: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'box-shadow var(--duration-short) var(--ease-standard), transform var(--duration-short) var(--ease-standard)',
              }}
              aria-label="Scroll to latest message"
            >
              ↓
            </button>
          )}
        </div>

        {/* ── Permission request ── */}
        {pendingPermission && (
          <div className="border-t border-amber-500/15 bg-amber-500/[0.03] px-5 py-3 flex items-center gap-3 flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
              <span className="text-sm">🔐</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-fg">Permission required</div>
              <div className="text-[11px] text-fg-2 font-mono truncate mt-0.5">{pendingPermission.tool}</div>
              {pendingPermission.args && (
                <div className="text-[10px] text-fg-2/40 mt-0.5 font-mono whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto rounded bg-bg/50 px-2 py-1">
                  {JSON.stringify(pendingPermission.args, null, 2)}
                </div>
              )}
            </div>
            <button onClick={() => chat.respondPermission(true)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/15 transition-all font-medium">
              Allow
            </button>
            <button onClick={() => chat.respondPermission(false)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg hover:bg-bg-2 border border-border/40 transition-all font-medium">
              Deny
            </button>
          </div>
        )}

        {/* ── Input ── */}
        <div className={headerless ? 'border-t border-border/30 px-2 py-1.5 flex-shrink-0' : 'border-t border-border/30 p-5 flex-shrink-0 bg-bg-1/80'}>
          {!connected && !headerless && (
            <div className="text-[11px] text-amber-400/60 bg-amber-400/[0.04] rounded-lg px-3 py-2 mb-2.5 border border-amber-400/[0.08] flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 animate-pulse" />
              {reconnectCountdown ? `Reconnecting in ${reconnectCountdown}s…` : 'Reconnecting…'}
            </div>
          )}
          {/* ── Slash command autocomplete ── */}
          {showSlashMenu && (
            <div className="mb-1.5 rounded-lg border border-border/50 bg-bg-1 shadow-lg overflow-hidden max-h-[280px] overflow-y-auto"
                 style={{ backdropFilter: 'blur(12px)' }}>
              <div className="px-2.5 py-1.5 border-b border-border/30 sticky top-0 bg-bg-1/95 z-10">
                <span className="text-[10px] text-fg-2/40 font-medium tracking-wide uppercase">
                  {slashParsed.phase === 'model' ? 'Models' : slashParsed.phase === 'mode' ? 'Modes' : 'Commands'}
                </span>
              </div>
              {slashOptions.map((opt, i) => (
                <button key={opt.key}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors ${
                    i === slashIdx ? 'bg-blue-500/10 text-fg' : 'text-fg-2 hover:bg-bg-2/60 hover:text-fg'
                  }`}
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => {
                    if (opt.execute) { handleSlashCommand(opt.fill); setInput(''); }
                    else { setInput(opt.fill); }
                    setSlashIdx(0);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="text-sm w-5 text-center">{opt.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-[12px] font-medium">{opt.label}</span>
                    <span className="text-[11px] text-fg-2/50 ml-2">{opt.desc}</span>
                  </span>
                  {i === slashIdx && <span className="text-[10px] text-fg-2/30">↵</span>}
                </button>
              ))}
            </div>
          )}
          <div className={headerless ? 'flex items-center gap-1.5' : 'flex items-end gap-2.5'}>
            <textarea
              ref={inputRef}
              className={headerless
                ? 'flex-1 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-fg resize-none focus:outline-none focus:border-blue-500/30 min-h-[28px] max-h-[60px] transition-colors placeholder:text-fg-2/40'
                : 'flex-1 input-m3 px-4 py-3 text-[13px] text-fg resize-none focus:outline-none min-h-[44px] max-h-[140px] transition-all placeholder:text-fg-2/40'}
              placeholder={pendingPermission ? 'Approve or deny the permission request above…' : sending ? (headerless ? '↯ Steer…' : 'Type to steer or Ctrl+Q to queue…') : `Message ${agentName}…`}
              rows={1}
              value={input}
              disabled={!!pendingPermission}
              onChange={e => { setInput(e.target.value); chat.historyIndex.current = -1; setSlashIdx(0); }}
              onKeyDown={handleKeyDown}
              onInput={e => {
                const t = e.currentTarget;
                cancelAnimationFrame(resizeTimer.current as unknown as number);
                resizeTimer.current = requestAnimationFrame(() => {
                  t.style.height = 'auto';
                  t.style.height = Math.min(t.scrollHeight, headerless ? 60 : 140) + 'px';
                }) as unknown as ReturnType<typeof setTimeout>;
              }}
            />
            <button
              className={headerless
                ? `flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                    sending
                      ? input.trim()
                        ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/15'
                      : 'bg-blue-600/80 hover:bg-blue-500 text-white'
                  } disabled:opacity-20`
                : `flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-90 ${
                    sending
                      ? input.trim()
                        ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/20'
                        : 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/15'
                      : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border-none'
                  } disabled:opacity-20`}
              onClick={() => { if (input.trim().startsWith('/')) { handleSlashCommand(input); setInput(''); return; } if (sending) { input.trim() ? (chat.send(input, 'steer'), setInput('')) : chat.abort(); } else { chat.send(input); setInput(''); } }}
              disabled={!!pendingPermission || (!input.trim() && !sending)}
              aria-label={sending ? (input.trim() ? 'Steer' : 'Stop') : 'Send message'}
              title={sending ? (input.trim() ? 'Steer (redirect agent)' : 'Stop') : 'Send'}
            >
              {sending ? (
                input.trim() ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M13 5l7 7-7 7M5 12h14" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                )
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M5 12h14M12 5l7 7-7 7" /></svg>
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-2 px-1">
            {!compact && (
              <span className="text-[10px] text-fg-2/20">
                {sending ? '⏎ steer · ⌃Q queue · click ■ abort' : '⏎ send · ⇧⏎ newline · ⌃Q queue · ⌃F search · ↑ history'}
              </span>
            )}
            <div className="flex items-center gap-2">
              {input.length > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--color-fg-2)', opacity: 0.3, fontFamily: 'monospace' }}>
                  {input.length}
                </span>
              )}
              {liveUsage?.model && (
                <span className="text-[10px] text-fg-2/20">{liveUsage.model}</span>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
