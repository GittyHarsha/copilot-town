import { useEffect } from 'react';

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['1', '–', '9'], desc: 'Go to page' },
      { keys: ['Ctrl', 'K'], desc: 'Command palette' },
      { keys: ['Escape'], desc: 'Close panel / palette' },
    ],
  },
  {
    title: 'Agents',
    shortcuts: [
      { keys: ['R'], desc: 'Refresh agents' },
      { keys: ['Ctrl', 'F'], desc: 'Search in chat (when open)' },
      { keys: ['↑', '/', '↓'], desc: 'Input history (in chat)' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Click agent'], desc: 'Open chat sidebar' },
      { keys: ['Escape'], desc: 'Close chat' },
      { keys: ['Ctrl', 'F'], desc: 'Search messages' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], desc: 'Show this help' },
      { keys: ['T'], desc: 'Toggle theme' },
    ],
  },
];

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)',
  backdropFilter: 'blur(4px)',
  animation: 'shortcuts-fade-in 0.15s ease-out',
};

const modalStyle: React.CSSProperties = {
  background: 'var(--color-bg-1)',
  border: '1px solid var(--color-border)',
  borderRadius: 14,
  padding: '24px 28px 20px',
  maxWidth: 600,
  width: '100%',
  margin: '0 16px',
  boxShadow: '0 25px 60px rgba(0,0,0,0.35)',
  animation: 'shortcuts-fade-in 0.15s ease-out',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 20,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--color-fg)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const closeBtnStyle: React.CSSProperties = {
  background: 'var(--color-bg-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: 'var(--color-fg-2)',
  fontSize: 14,
  lineHeight: 1,
  transition: 'background 0.15s, color 0.15s',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: '18px 28px',
};

const categoryTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-fg-1)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  marginBottom: 8,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '3px 0',
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 11,
  fontWeight: 500,
  minWidth: 22,
  height: 22,
  padding: '0 6px',
  borderRadius: 5,
  background: 'var(--color-bg-3)',
  color: 'var(--color-fg-1)',
  border: '1px solid var(--color-border-1)',
  borderBottom: '2px solid var(--color-border-1)',
  lineHeight: 1,
};

const descStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-fg-2)',
};

export default function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <style>{`
        @keyframes shortcuts-fade-in {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
        @media (max-width: 540px) {
          .shortcuts-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
      <div style={overlayStyle} onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard Shortcuts"
          style={modalStyle}
          onClick={e => e.stopPropagation()}
        >
          <div style={headerStyle}>
            <div style={titleStyle}>
              <span aria-hidden>⌨️</span>
              Keyboard Shortcuts
            </div>
            <button
              onClick={onClose}
              style={closeBtnStyle}
              aria-label="Close"
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-fg)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-fg-2)'; }}
            >
              ×
            </button>
          </div>

          <div className="shortcuts-grid" style={gridStyle}>
            {CATEGORIES.map(cat => (
              <div key={cat.title}>
                <div style={categoryTitleStyle}>{cat.title}</div>
                {cat.shortcuts.map((s, i) => (
                  <div key={i} style={rowStyle}>
                    <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {s.keys.map((k, j) => (
                        <kbd key={j} style={kbdStyle}>{k}</kbd>
                      ))}
                    </span>
                    <span style={descStyle}>{s.desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, textAlign: 'center', fontSize: 10, color: 'var(--color-fg-2)', opacity: 0.6 }}>
            Press <kbd style={{ ...kbdStyle, fontSize: 10, height: 18, minWidth: 18 }}>Esc</kbd> or click outside to close
          </div>
        </div>
      </div>
    </>
  );
}
