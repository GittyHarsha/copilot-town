import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { MarkdownContent, relativeTime } from './ChatMarkdown';
import { ThinkingBlock, InlineToolCall, ToolTimeline, type ToolCall, type UsageInfo } from './ChatWidgets';
import { useHeadlessChat, type ChatMessage, type UseHeadlessChatReturn } from '../hooks/useHeadlessChat';
import { api } from '../lib/api';

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
  const { messages, connected, sending, liveIntent, liveUsage, agentMode, pendingPermission } = chat;

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  /* ── Auto-scroll (only when user is near the bottom) ── */
  const isNearBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isNearBottom.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  /* ── Scroll listener — tracks position for auto-scroll + scroll-to-bottom button ── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottom.current = gap <= 150;
      setIsScrolledUp(gap > 150);
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

  /* ── Elapsed time counter ── */
  useEffect(() => {
    if (!sending) {
      setElapsedDisplay('');
      return;
    }
    const startTime = Date.now();
    setElapsedDisplay('0s');
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      setElapsedDisplay(mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [sending]);

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
    <div className={`h-full flex flex-col relative ${headerless ? 'bg-transparent' : 'bg-bg border-l border-border/50'}`} style={embedded ? undefined : { width: panelWidth }}>

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
                    onClick={() => chat.changeMode(m)}
                    disabled={!connected}
                    aria-label={`Set mode to ${m}`}
                    aria-pressed={agentMode === m}
                    className={`text-[10px] px-2.5 py-1 rounded-md transition-all font-medium ${
                      agentMode === m
                        ? 'bg-bg-3 text-fg shadow-sm border border-border/40'
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

        {/* ── Streaming status bar ── */}
        {sending && (
          <div className="flex items-center gap-2 px-5 py-2 bg-blue-500/[0.03] border-b border-blue-500/10 text-[11px] flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-blue-400/70 truncate">{liveIntent || 'Responding…'}</span>
            <span className="ml-auto text-fg-2/30 tabular-nums">{elapsedDisplay}</span>
            {liveUsage?.outputTokens && <span className="text-fg-2/30 tabular-nums">{liveUsage.outputTokens.toLocaleString()} tok</span>}
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
                  setSearchIndex(i => (i + 1) % Math.max(1, searchMatches.length));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSearchIndex(i => (i - 1 + searchMatches.length) % Math.max(1, searchMatches.length));
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
          {messages.length === 0 ? (
            <EmptyState onSend={(text) => { chat.send(text); }} compact={headerless} />
          ) : (
            <div className={headerless ? 'px-2.5 py-2 space-y-2' : 'px-5 py-4 space-y-4'}>
              {visibleMessages.map(m => {
                const isDimmed = searchOpen && searchQuery && !searchMatches.includes(m.id);
                const isBookmarked = bookmarks.has(m.id);
                const isCurrentMatch = searchOpen && searchQuery && searchMatches[searchIndex] === m.id;

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
                    <div key={m.id} id={`msg-${m.id}`} className={`flex justify-end animate-message-slide-up transition-opacity duration-200 ${isDimmed ? 'opacity-30' : ''} ${isCurrentMatch ? 'ring-1 ring-yellow-400/40 rounded-lg' : ''}`}>
                      <div className={`max-w-[85%] relative ${isBookmarked ? 'border-r-2 border-amber-400/50 pr-3' : ''}`}>
                        {/* Relay sender */}
                        {m.from && m.from !== 'you' && (
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
                  <div key={m.id} id={`msg-${m.id}`} className={`flex gap-2.5 animate-message-slide-up transition-opacity duration-200 ${isDimmed ? 'opacity-30' : ''} ${isBookmarked ? 'border-l-2 border-amber-400/50 pl-2' : ''} ${isCurrentMatch ? 'ring-1 ring-yellow-400/40 rounded-lg' : ''}`}>
                    {/* Agent avatar — hidden in compact mode */}
                    {!compact && (
                      <div className="w-7 h-7 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[12px]"
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

                    {/* Footer: usage/tokens — hidden in compact mode */}
                    {!compact && (m.tokens || m.usage) && (
                      <div className="flex items-center gap-3 text-[10px] px-1">
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
            </div>
          )}
          {isScrolledUp && (
            <button
              onClick={() => { isNearBottom.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
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
                <div className="text-[10px] text-fg-2/40 truncate mt-0.5 font-mono">{JSON.stringify(pendingPermission.args).slice(0, 100)}</div>
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
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
              Not connected — reconnecting…
            </div>
          )}
          <div className={headerless ? 'flex items-center gap-1.5' : 'flex items-end gap-2.5'}>
            <textarea
              ref={inputRef}
              className={headerless
                ? 'flex-1 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-[11px] text-fg resize-none focus:outline-none focus:border-blue-500/30 min-h-[28px] max-h-[60px] transition-colors placeholder:text-fg-2/40'
                : 'flex-1 input-m3 px-4 py-3 text-[13px] text-fg resize-none focus:outline-none min-h-[44px] max-h-[140px] transition-all placeholder:text-fg-2/40'}
              placeholder={sending ? (headerless ? '↯ Steer…' : 'Type to steer or Ctrl+Q to queue…') : `Message ${agentName}…`}
              rows={1}
              value={input}
              onChange={e => { setInput(e.target.value); historyIndex.current = -1; }}
              onKeyDown={handleKeyDown}
              onInput={e => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, headerless ? 60 : 140) + 'px';
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
              disabled={!input.trim() && !sending}
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
