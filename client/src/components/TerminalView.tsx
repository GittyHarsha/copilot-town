import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  target: string;
  agentName?: string;
  onClose?: () => void;
  hideHeader?: boolean;
}

export function TerminalView({ target, agentName, onClose, hideHeader }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let disposed = false;

    const fitAddon = new FitAddon();

    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: 11,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      scrollback: 0,
      theme: {
        background: '#111111',
        foreground: '#c9d1d9',
        cursor: '#3b82f6',
        cursorAccent: '#111111',
        selectionBackground: '#264f78',
        black: '#484f58', red: '#ff7b72', green: '#3fb950',
        yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      },
      allowProposedApi: true,
    });

    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current = fitAddon;

    // Send current xterm size to server so capture output is trimmed to fit
    function sendResize() {
      if (ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }

    // Fit to container after open
    requestAnimationFrame(() => {
      if (!disposed) {
        try { fitAddon.fit(); sendResize(); } catch { /* container not ready */ }
      }
    });

    // Re-fit on container resize
    const ro = new ResizeObserver(() => {
      if (!disposed) {
        try { fitAddon.fit(); sendResize(); } catch { /* ignore */ }
      }
    });
    ro.observe(el);

    const ws = new WebSocket(`ws://localhost:3848/ws/terminal?target=${encodeURIComponent(target)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (disposed) { ws.close(); return; }
      setConnected(true);
      // Send fitted size immediately on connect
      requestAnimationFrame(() => {
        try { fitAddon.fit(); sendResize(); } catch { /* ignore */ }
      });
    };

    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'dimensions') {
          // Ignore psmux dims — we use FitAddon. But re-fit and tell server our size.
          requestAnimationFrame(() => {
            try { fitAddon.fit(); sendResize(); } catch { /* ignore */ }
          });
        } else if (msg.type === 'output') {
          term.write('\x1b[H\x1b[2J' + msg.content);
        } else if (msg.type === 'error') {
          setError(msg.message);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => { if (!disposed) setConnected(false); };
    ws.onerror = () => { if (!disposed) setError('Connection failed'); };

    // Input handling
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const escMap: Record<string, string> = {
        '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
        '\x1b[H': 'Home', '\x1b[F': 'End',
      };
      if (escMap[data]) { ws.send(JSON.stringify({ type: 'key', key: escMap[data] })); return; }
      const ctrlMap: Record<number, string> = {
        13: 'Enter', 27: 'Escape', 9: 'Tab', 127: 'Backspace', 8: 'Backspace',
        3: 'C-c', 4: 'C-d', 12: 'C-l', 26: 'C-z',
      };
      for (const char of data) {
        const code = char.charCodeAt(0);
        if (ctrlMap[code]) ws.send(JSON.stringify({ type: 'key', key: ctrlMap[code] }));
        else if (code >= 32) ws.send(JSON.stringify({ type: 'input', data: char }));
      }
    });

    return () => {
      disposed = true;
      ro.disconnect();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        ws.onclose = null; ws.close();
      } else {
        ws.onopen = () => ws.close(); ws.onclose = null; ws.onerror = null;
      }
      term.dispose();
    };
  }, [target]);

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 h-7 shrink-0 bg-bg-2 border-b border-border">
          <div className="flex items-center gap-2 text-[11px] text-fg-2 font-mono">
            {agentName && <><span className="text-fg-1">{agentName}</span><span className="text-fg-2/40">·</span></>}
            <span>{target}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green' : 'bg-red/50'}`} />
            {onClose && <button onClick={onClose} className="text-fg-2 hover:text-fg text-xs leading-none">✕</button>}
          </div>
        </div>
      )}
      <div ref={wrapperRef} className="flex-1 overflow-hidden" style={{ minHeight: 0, background: '#111111' }} />
      {error && <div className="px-3 py-1 text-[10px] text-red bg-red/10 border-t border-red/20 shrink-0">{error}</div>}
    </div>
  );
}
