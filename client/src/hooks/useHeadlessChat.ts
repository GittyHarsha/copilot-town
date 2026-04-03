/**
 * useHeadlessChat — shared hook for all headless agent chat UIs.
 *
 * Encapsulates: WebSocket connection + auto-reconnect, streaming event handling
 * (15 event types), message state, send/steer/enqueue/abort/compact/setMode,
 * conversation history loading, input history navigation.
 *
 * Used by: HeadlessChatPanel, LiveGrid MiniChat, Sessions page.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import type { ToolCall, UsageInfo } from '../components/ChatWidgets';

/* ═══════════════════════════════════════════════════════════════════
   Types (shared across all consumers)
   ═══════════════════════════════════════════════════════════════════ */

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  thinking?: string;
  tokens?: number;
  usage?: UsageInfo;
  timestamp: number;
  from?: string;
  streaming?: boolean;
  tools?: ToolCall[];
  intent?: string;
  action?: 'enqueue' | 'steer';
}

export interface UseHeadlessChatOptions {
  /** Load conversation history on mount (default: true) */
  loadHistory?: boolean;
  /** Max messages to keep in state (0 = unlimited, default: 0) */
  maxMessages?: number;
}

export interface UseHeadlessChatReturn {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  connected: boolean;
  sending: boolean;
  historyLoaded: boolean;
  liveIntent: string | null;
  liveUsage: UsageInfo | null;
  agentMode: string;
  pendingPermission: { id: string; tool: string; args?: any } | null;
  reconnectCountdown: number | null;
  turnStartedAt: number | null;

  /** Send a message. Optional action: 'enqueue' (queue), 'steer' (interrupt). */
  send: (text: string, action?: 'enqueue' | 'steer') => void;
  /** Abort the current agent response. */
  abort: () => void;
  /** Compact/compress the agent context. */
  compact: () => void;
  /** Change agent mode (plan, autopilot, interactive). */
  changeMode: (mode: string) => void;
  /** Respond to a permission request. */
  respondPermission: (approved: boolean) => void;

  /** Input history for ↑/↓ navigation. */
  inputHistory: React.MutableRefObject<string[]>;
  historyIndex: React.MutableRefObject<number>;

  /** WebSocket ref for advanced use (e.g. custom sends). */
  wsRef: React.MutableRefObject<WebSocket | null>;
}

/* ═══════════════════════════════════════════════════════════════════
   Hook
   ═══════════════════════════════════════════════════════════════════ */

const WS_BASE = `ws://${window.location.host}/ws/headless`;

export function useHeadlessChat(
  agentName: string | null,
  options: UseHeadlessChatOptions = {},
): UseHeadlessChatReturn {
  const { loadHistory = true, maxMessages = 0 } = options;

  /* ── State ── */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [liveIntent, setLiveIntent] = useState<string | null>(null);
  const [liveUsage, setLiveUsage] = useState<UsageInfo | null>(null);
  const [agentMode, setAgentMode] = useState<string>('autopilot');
  const [pendingPermissions, setPendingPermissions] = useState<Array<{ id: string; tool: string; args?: any }>>([]);
  const [reconnectCountdown, setReconnectCountdown] = useState<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  // Derived: first pending permission for backward compat with UI
  const pendingPermission = pendingPermissions[0] || null;

  /* ── Refs ── */
  const wsRef = useRef<WebSocket | null>(null);
  const clientId = useRef(`client-${Math.random().toString(36).slice(2, 10)}`);
  const msgCounter = useRef(0);
  const streamBuf = useRef('');
  const thinkBuf = useRef('');
  const toolsBuf = useRef<ToolCall[]>([]);
  const activeStreamId = useRef<string | null>(null);
  const pendingSendRef = useRef<string | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectDelay = useRef(1000);
  const sendingRef = useRef(false);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const abortedRef = useRef(false);
  const lastEventRef = useRef<number>(0);

  /* helper: keep sendingRef in sync with state (for use in wireWs without deps) */
  useEffect(() => { sendingRef.current = sending; }, [sending]);

  /* helper: trim messages if maxMessages set */
  const trimMessages = useCallback((msgs: ChatMessage[]) => {
    if (maxMessages > 0 && msgs.length > maxMessages) return msgs.slice(-maxMessages);
    return msgs;
  }, [maxMessages]);

  /* ── Load conversation history ── */
  useEffect(() => {
    if (!agentName || !loadHistory) { setHistoryLoaded(true); return; }
    (async () => {
      try {
        const data = await api.getAgentMessages(agentName);
        if (!data?.messages) { setHistoryLoaded(true); return; }
        const seen = new Set<string>();
        const history: ChatMessage[] = [];
        for (const m of data.messages) {
          // Deduplicate by server-assigned ID
          if (m.id && seen.has(m.id)) continue;
          if (m.id) seen.add(m.id);

          if (m.type === 'user.message') {
            const text = m.prompt || m.content || m.text || '';
            if (!text) continue; // Skip empty messages entirely
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'user', text,
              from: text.startsWith('[Message from ') ? text.match(/\[Message from (.+?)\]/)?.[1] : 'you',
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          } else if (m.type === 'assistant.message') {
            const text = m.content || m.text || '';
            if (!text && !(m.thinking || m.reasoningText)) continue; // Skip empty agent messages
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'agent', text,
              thinking: m.thinking || m.reasoningText || undefined,
              tokens: m.outputTokens,
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          }
        }
        // Merge: deduplicate history against any live messages already in state
        setMessages(prev => {
          if (prev.length === 0) return trimMessages(history);
          const liveIds = new Set(prev.map(m => m.id));
          const deduped = history.filter(h => !liveIds.has(h.id));
          return trimMessages([...deduped, ...prev]);
        });
      } catch {} finally {
        setHistoryLoaded(true);
      }
    })();
  }, [agentName, loadHistory, trimMessages]);

  /* ── WebSocket message handler ── */
  const wireWs = useCallback((ws: WebSocket) => {
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        lastEventRef.current = Date.now();
        let sid = activeStreamId.current;

        // Auto-create placeholder on turn_start (e.g. from relay/external trigger)
        if (msg.type === 'turn_start') {
          abortedRef.current = false;
          if (!sid) {
            const agentId = `agent-${msgCounter.current++}`;
            activeStreamId.current = agentId;
            sid = agentId;
            streamBuf.current = '';
            thinkBuf.current = '';
            toolsBuf.current = [];
            setSending(true);
            setTurnStartedAt(Date.now());
            setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
          }
          return;
        }

        // Auto-create placeholder if streaming data arrives with no active stream
        if (abortedRef.current) return; // Ignore trailing events after abort
        if (!sid && (msg.type === 'message_delta' || msg.type === 'streaming_delta' || msg.type === 'reasoning_delta' || msg.type === 'tool_start')) {
          const agentId = `agent-${msgCounter.current++}`;
          activeStreamId.current = agentId;
          sid = agentId;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setSending(true);
          setTurnStartedAt(Date.now());
          setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
        }

        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          streamBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const text = streamBuf.current;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, text, streaming: true } : m));
          }
        } else if (msg.type === 'reasoning_delta') {
          thinkBuf.current += msg.content || msg.deltaContent || '';
          if (sid) {
            const thinking = thinkBuf.current;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, thinking, streaming: true } : m));
          }
        } else if (msg.type === 'tool_start') {
          const input = msg.input ? (typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input)) : undefined;
          const description = msg.description || undefined;
          toolsBuf.current = [...toolsBuf.current, { tool: msg.tool, toolCallId: msg.toolCallId, description, status: 'running', timestamp: Date.now(), input }];
          if (sid) {
            const tools = [...toolsBuf.current];
            // Re-enable streaming if a tool starts after response finalized the bubble
            setSending(true);
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools, streaming: true } : m));
          }
        } else if (msg.type === 'tool_complete') {
          const output = msg.output ?? msg.result;
          const outputStr = output ? (typeof output === 'string' ? output : JSON.stringify(output)) : (msg.error ? `Error: ${msg.error}` : undefined);
          // Match by toolCallId first, fall back to tool name
          toolsBuf.current = toolsBuf.current.map(t => {
            if (t.status !== 'running') return t;
            if (msg.toolCallId && t.toolCallId === msg.toolCallId) return { ...t, status: 'done' as const, endTimestamp: Date.now(), output: outputStr };
            if (!msg.toolCallId && t.tool === msg.tool && t.status === 'running') return { ...t, status: 'done' as const, endTimestamp: Date.now(), output: outputStr };
            return t;
          });
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'intent') {
          setLiveIntent(msg.intent || null);
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, intent: msg.intent } : m));
        } else if (msg.type === 'usage') {
          const usage: UsageInfo = { model: msg.model, inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, cost: msg.cost, duration: msg.duration };
          setLiveUsage(usage);
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, usage, tokens: msg.outputTokens } : m));
        } else if (msg.type === 'subagent_start') {
          toolsBuf.current = [...toolsBuf.current, { tool: `🤖 ${msg.name || 'subagent'}`, status: 'running', timestamp: Date.now() }];
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'subagent_complete') {
          toolsBuf.current = toolsBuf.current.map(t =>
            t.tool === `🤖 ${msg.name}` && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now() } : t
          );
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'response') {
          // Update the message with final content but keep streaming alive —
          // more tools can arrive before turn_end. Only turn_end finalizes.
          if (activeStreamId.current) {
            const text = msg.content || streamBuf.current;
            const thinking = msg.thinking || thinkBuf.current || undefined;
            const tokens = msg.outputTokens;
            const tools = toolsBuf.current.length > 0
              ? toolsBuf.current.map(t => ({ ...t, status: t.status === 'running' ? 'done' as const : t.status, endTimestamp: t.endTimestamp || Date.now() }))
              : undefined;
            streamBuf.current = text;
            setMessages(prev => prev.map(m => m.id === activeStreamId.current ? {
              ...m, text, thinking, tokens, tools,
            } : m));
          }
          setLiveIntent(null);
          setLiveUsage(null);
        } else if (msg.type === 'aborted') {
          abortedRef.current = true;
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: m.text || '(aborted)', streaming: false } : m));
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false); setTurnStartedAt(null);
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '⏹ Response aborted', timestamp: Date.now() }]);
        } else if (msg.type === 'enqueued') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '📋 Queued — runs when idle', timestamp: Date.now() }]);
        } else if (msg.type === 'steered') {
          // User message already added
        } else if (msg.type === 'compacted') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '🗜️ Context compacted', timestamp: Date.now() }]);
        } else if (msg.type === 'mode_changed') {
          const m = msg.mode ?? msg.data?.mode;
          if (m) {
            setAgentMode(m);
            setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: `Mode → ${m}`, timestamp: Date.now() }]);
          }
        } else if (msg.type === 'permission_request') {
          setPendingPermissions(prev => [...prev, { id: msg.requestId, tool: msg.tool, args: msg.args }]);
        } else if (msg.type === 'system') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: msg.message, timestamp: Date.now() }]);
        } else if (msg.type === 'error') {
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: `Error: ${msg.message}`, streaming: false } : m));
          else setMessages(prev => [...prev, { id: `err-${msgCounter.current++}`, role: 'system', text: `⚠ ${msg.message}`, timestamp: Date.now() }]);
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setSending(false); setTurnStartedAt(null);
        } else if (msg.type === 'turn_end') {
          if (activeStreamId.current && streamBuf.current) {
            const text = streamBuf.current;
            const thinking = thinkBuf.current || undefined;
            const tools = toolsBuf.current.length > 0
              ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() }))
              : undefined;
            setMessages(prev => prev.map(m => m.id === activeStreamId.current ? { ...m, text, thinking, tools, streaming: false } : m));
          } else if (activeStreamId.current) {
            setMessages(prev => prev.map(m => m.id === activeStreamId.current ? { ...m, streaming: false } : m));
          }
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false); setTurnStartedAt(null);
        } else if (msg.type === 'status_sync') {
          // Server sends agent status on connect — sync client state
          if (msg.agentStatus === 'running') {
            if (!sendingRef.current) setSending(true);
          } else {
            if (sendingRef.current && !activeStreamId.current) setSending(false);
          }
        } else if (msg.type === 'user_message') {
          // Skip user_message broadcast from ourselves (we already added it locally)
          if (msg.senderId && msg.senderId === clientId.current) return;
          const prompt = msg.prompt || '';
          // Use server-provided 'from' field; fall back to parsing [Message from X] envelope
          const from = msg.from || (prompt.startsWith('[Message from ') ? prompt.match(/\[Message from (.+?)\]/)?.[1] : undefined) || 'external';
          // Strip the [Message from X] envelope for display
          const displayText = prompt.replace(/^\[Message from .+?\]\n/, '');
          setMessages(prev => trimMessages([...prev, { id: `ext-${msgCounter.current++}`, role: 'user', text: displayText, from, timestamp: Date.now() }]));
        }
      } catch {}
    };
  }, [agentName, trimMessages]);

  /* ── WebSocket connection with auto-reconnect ── */
  const connectWs = useCallback(() => {
    if (!agentName) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    wireWs(ws);
    ws.onopen = () => {
      setConnected(true);
      setReconnectCountdown(null);
      reconnectDelay.current = 1000;
      if (pendingSendRef.current) {
        const prompt = pendingSendRef.current;
        pendingSendRef.current = null;
        // Don't create placeholder eagerly — server events will trigger it
        streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
        setSending(true);
        lastEventRef.current = Date.now();
        abortedRef.current = false;
        ws.send(JSON.stringify({ prompt }));
      }
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Preserve any partial streaming response before reconnecting
      if (activeStreamId.current && streamBuf.current) {
        const partialId = activeStreamId.current;
        const partialText = streamBuf.current + '\n\n_(connection lost — reconnecting…)_';
        const partialThinking = thinkBuf.current || undefined;
        const partialTools = toolsBuf.current.length ? [...toolsBuf.current] : undefined;
        setMessages(prev => prev.map(m =>
          m.id === partialId ? { ...m, text: partialText, thinking: partialThinking, tools: partialTools, streaming: false } : m
        ));
        activeStreamId.current = null;
        streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      }
      // Always clear sending on disconnect — we can't guarantee turn_end will arrive
      // after reconnect since the stream listener was removed server-side.
      setSending(false);
      setTurnStartedAt(null);
      clearTimeout(reconnectTimer.current);
      const delay = reconnectDelay.current;
      // Start countdown for UI display
      setReconnectCountdown(Math.ceil(delay / 1000));
      countdownIntervalRef.current = setInterval(() => {
        setReconnectCountdown(prev => prev !== null && prev > 1 ? prev - 1 : null);
      }, 1000);
      reconnectTimer.current = setTimeout(() => {
        clearInterval(countdownIntervalRef.current);
        setReconnectCountdown(null);
        connectWs();
      }, delay);
      reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 15000);
    };
  }, [agentName, wireWs, trimMessages]);

  useEffect(() => {
    if (!agentName) return;
    connectWs();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(countdownIntervalRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs, agentName]);

  const ensureWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return wsRef.current;
    connectWs();
    return wsRef.current!;
  }, [connectWs]);

  /* ── Load initial agent mode ── */
  useEffect(() => {
    if (!agentName) return;
    api.getAgentMode(agentName).then(r => {
      const mode = r.mode || 'autopilot';
      setAgentMode(mode === 'interactive' ? 'autopilot' : mode);
    }).catch(() => {});
  }, [agentName]);

  /* ── Sending timeout safety net ──
   * If `sending` stays true for 120s without any streaming event clearing it,
   * force-reset to idle so the user isn't stuck in a loading state forever.
   */
  useEffect(() => {
    if (!sending) return;
    const check = () => {
      const elapsed = Date.now() - lastEventRef.current;
      if (elapsed > 120_000) {
        // No event for 120s — truly stuck
        setSending(false);
        setTurnStartedAt(null);
        if (activeStreamId.current) {
          setMessages(prev => prev.map(m =>
            m.id === activeStreamId.current ? { ...m, streaming: false } : m
          ));
          activeStreamId.current = null;
          streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
        }
        setMessages(prev => [...prev, {
          id: `sys-${msgCounter.current++}`, role: 'system' as const,
          text: '⚠ No response for 2 minutes — you can send again.',
          timestamp: Date.now(),
        }]);
      }
    };
    const interval = setInterval(check, 10_000); // Check every 10s
    return () => clearInterval(interval);
  }, [sending]);

  /* ── Actions ── */
  const send = useCallback((text: string, action?: 'enqueue' | 'steer') => {
    text = text.trim();
    if (!text) return;

    const userId = `u-${msgCounter.current++}`;
    const userMsg: ChatMessage = { id: userId, role: 'user', text, from: 'you', timestamp: Date.now() };
    if (action) userMsg.action = action;
    setMessages(prev => trimMessages([...prev, userMsg]));
    inputHistoryRef.current.push(text);
    if (inputHistoryRef.current.length > 50) inputHistoryRef.current.shift();
    historyIndexRef.current = -1;

    const ws = wsRef.current;
    const isOpen = ws && ws.readyState === WebSocket.OPEN;

    if (action === 'enqueue') {
      if (isOpen) ws.send(JSON.stringify({ action: 'enqueue', prompt: text }));
      else setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: '⚠ Not connected — message not queued', timestamp: Date.now() }]);
      return;
    }
    if (action === 'steer') {
      activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      const agentId = `a-${msgCounter.current++}`;
      setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
      activeStreamId.current = agentId;
      if (isOpen) ws!.send(JSON.stringify({ action: 'steer', prompt: text }));
      else { pendingSendRef.current = text; ensureWs(); }
      return;
    }

    if (sending) {
      // Provide visual feedback that send is blocked
      setMessages(prev => [...prev, {
        id: `sys-${msgCounter.current++}`, role: 'system',
        text: 'Still waiting for response — message not sent. Use ⏎ Steer to interrupt.',
        timestamp: Date.now(),
      }]);
      return;
    }
    if (isOpen) {
      // Don't create placeholder eagerly — wait for first streaming data to arrive.
      // Just mark as sending so the UI shows immediate "Thinking…" feedback.
      setSending(true);
      lastEventRef.current = Date.now();
      abortedRef.current = false;
      streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      ws!.send(JSON.stringify({ prompt: text, clientId: clientId.current }));
    } else {
      pendingSendRef.current = text;
      setSending(true);
      lastEventRef.current = Date.now();
      abortedRef.current = false;
      ensureWs();
    }
  }, [sending, ensureWs, trimMessages]);

  const abort = useCallback(() => {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ action: 'abort' }));
  }, []);

  const compact = useCallback(() => {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ action: 'compact' }));
  }, []);

  const changeMode = useCallback(async (mode: string) => {
    if (!agentName) return;
    try {
      await api.setAgentMode(agentName, mode);
      setAgentMode(mode);
    } catch (e: any) {
      setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: `Failed: ${e.message}`, timestamp: Date.now() }]);
    }
  }, [agentName]);

  const respondPermission = useCallback((approved: boolean) => {
    if (pendingPermissions.length === 0 || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const perm = pendingPermissions[0];
    wsRef.current.send(JSON.stringify({ action: 'permission_response', requestId: perm.id, approved }));
    setPendingPermissions(prev => prev.slice(1));
  }, [pendingPermissions]);

  /* ── Reset on agent change ── */
  useEffect(() => {
    setMessages([]);
    setSending(false);
    setHistoryLoaded(false);
    setLiveIntent(null);
    setLiveUsage(null);
    setPendingPermissions([]);
    setTurnStartedAt(null);
    setReconnectCountdown(null);
    activeStreamId.current = null;
    streamBuf.current = '';
    thinkBuf.current = '';
    toolsBuf.current = [];
  }, [agentName]);

  return {
    messages, setMessages,
    connected, sending, historyLoaded,
    liveIntent, liveUsage, agentMode,
    pendingPermission, reconnectCountdown, turnStartedAt,
    send, abort, compact, changeMode, respondPermission,
    inputHistory: inputHistoryRef,
    historyIndex: historyIndexRef,
    wsRef,
  };
}
