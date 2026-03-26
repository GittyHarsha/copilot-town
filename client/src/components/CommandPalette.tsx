import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export interface Command {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  action: () => void;
  category?: string;
}

interface Props {
  commands: Command[];
  onExecute: (cmd: Command) => void;
  onClose: () => void;
}

const RECENT_KEY = 'copilot-town-recent-commands';
const MAX_RECENT = 5;

function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  const list = getRecent().filter(r => r !== id);
  list.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

function fuzzyMatch(query: string, text: string): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      // Consecutive matches score higher
      score += (lastIdx === ti - 1) ? 2 : 1;
      // Word-boundary bonus
      if (ti === 0 || t[ti - 1] === ' ') score += 3;
      lastIdx = ti;
      qi++;
    }
  }

  return { match: qi === q.length, score, indices };
}

function HighlightedLabel({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices);
  return (
    <span>
      {text.split('').map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-blue font-semibold">{ch}</span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </span>
  );
}

export default function CommandPalette({ commands, onExecute, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const recent = getRecent();

    if (!query.trim()) {
      // No query: show recent first, then all grouped by category
      const recentCmds = recent
        .map(id => commands.find(c => c.id === id))
        .filter(Boolean) as Command[];
      const rest = commands.filter(c => !recent.includes(c.id));

      const results: { cmd: Command; indices: number[]; isRecent: boolean }[] = [
        ...recentCmds.map(cmd => ({ cmd, indices: [], isRecent: true })),
        ...rest.map(cmd => ({ cmd, indices: [], isRecent: false })),
      ];
      return results;
    }

    const scored = commands
      .map(cmd => {
        const result = fuzzyMatch(query, cmd.label);
        return { cmd, ...result, isRecent: recent.includes(cmd.id) };
      })
      .filter(r => r.match)
      .sort((a, b) => {
        // Recent items float to top
        if (a.isRecent !== b.isRecent) return a.isRecent ? -1 : 1;
        return b.score - a.score;
      });

    return scored;
  }, [query, commands]);

  // Reset active index when results change
  useEffect(() => { setActiveIdx(0); }, [filtered.length, query]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const execute = useCallback((idx: number) => {
    const entry = filtered[idx];
    if (!entry) return;
    pushRecent(entry.cmd.id);
    onExecute(entry.cmd);
  }, [filtered, onExecute]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIdx(i => (i + 1) % Math.max(filtered.length, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIdx(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
        break;
      case 'Enter':
        e.preventDefault();
        execute(activeIdx);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [activeIdx, filtered.length, execute, onClose]);

  // Click on backdrop closes
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  }, [onClose]);

  // Group items by category for display
  const groupedItems = useMemo(() => {
    const groups: { label: string; items: typeof filtered }[] = [];
    let currentCategory = '';

    for (const entry of filtered) {
      const cat = entry.isRecent ? 'Recent' : (entry.cmd.category || 'Commands');
      if (cat !== currentCategory) {
        currentCategory = cat;
        groups.push({ label: cat, items: [] });
      }
      groups[groups.length - 1].items.push(entry);
    }
    return groups;
  }, [filtered]);

  // Flat index mapping for keyboard navigation
  let flatIdx = 0;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-start justify-center pt-[15vh] animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-[520px] mx-4">
        {/* Search input */}
        <div className="relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-2 text-sm pointer-events-none">⌘</span>
          <input
            ref={inputRef}
            type="text"
            className="w-full bg-bg-1 border border-border-1 rounded-lg pl-9 pr-4 py-3 text-sm text-fg placeholder-fg-2/50 outline-none focus:border-blue/50"
            placeholder="Type a command…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        {/* Results list */}
        {filtered.length > 0 && (
          <div
            ref={listRef}
            className="mt-1.5 bg-bg-1 border border-border rounded-lg overflow-auto max-h-[60vh] py-1"
          >
            {groupedItems.map(group => (
              <div key={group.label}>
                <div className="px-3 pt-2 pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-fg-2">
                    {group.label}
                  </span>
                </div>
                {group.items.map(entry => {
                  const idx = flatIdx++;
                  const isActive = idx === activeIdx;
                  return (
                    <button
                      key={entry.cmd.id}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors ${
                        isActive ? 'bg-bg-3 text-fg' : 'text-fg-1 hover:bg-bg-2'
                      }`}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => execute(idx)}
                    >
                      {entry.cmd.icon && (
                        <span className="w-5 text-center text-sm opacity-60 shrink-0">{entry.cmd.icon}</span>
                      )}
                      <span className="flex-1 truncate">
                        {entry.indices.length > 0
                          ? <HighlightedLabel text={entry.cmd.label} indices={entry.indices} />
                          : entry.cmd.label}
                      </span>
                      {entry.cmd.shortcut && (
                        <kbd className="text-[10px] text-fg-2 bg-bg-2 px-1.5 py-0.5 rounded font-mono shrink-0">
                          {entry.cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* No results */}
        {query.trim() && filtered.length === 0 && (
          <div className="mt-1.5 bg-bg-1 border border-border rounded-lg py-8 text-center">
            <span className="text-xs text-fg-2">No matching commands</span>
          </div>
        )}
      </div>
    </div>
  );
}
