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
  liveIntent: string | null;
  liveUsage: UsageInfo | null;
  agentMode: string;
  pendingPermission: { id: string; tool: string; args?: any } | null;

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
  const [liveIntent, setLiveIntent] = useState<string | null>(null);
  const [liveUsage, setLiveUsage] = useState<UsageInfo | null>(null);
  const [agentMode, setAgentMode] = useState<string>('autopilot');
  const [pendingPermission, setPendingPermission] = useState<{ id: string; tool: string; args?: any } | null>(null);

  /* ── Refs ── */
  const wsRef = useRef<WebSocket | null>(null);
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

  /* helper: trim messages if maxMessages set */
  const trimMessages = useCallback((msgs: ChatMessage[]) => {
    if (maxMessages > 0 && msgs.length > maxMessages) return msgs.slice(-maxMessages);
    return msgs;
  }, [maxMessages]);

  /* ── Load conversation history ── */
  useEffect(() => {
    if (!agentName || !loadHistory) return;
    (async () => {
      try {
        const data = await api.getAgentMessages(agentName);
        if (!data?.messages) return;
        const history: ChatMessage[] = [];
        for (const m of data.messages) {
          if (m.type === 'user.message') {
            const text = m.prompt || m.content || m.text || '';
            if (!text) {
              history.push({ id: m.id || `h-${msgCounter.current++}`, role: 'user', text: '(message not available)', from: 'you', timestamp: new Date(m.timestamp || 0).getTime() });
              continue;
            }
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'user', text,
              from: text.startsWith('[Message from ') ? text.match(/\[Message from (.+?)\]/)?.[1] : 'you',
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          } else if (m.type === 'assistant.message') {
            history.push({
              id: m.id || `h-${msgCounter.current++}`, role: 'agent',
              text: m.content || m.text || '',
              thinking: m.thinking || m.reasoningText || undefined,
              tokens: m.outputTokens,
              timestamp: new Date(m.timestamp || 0).getTime(),
            });
          }
        }
        setMessages(trimMessages(history));
      } catch {}
    })();
  }, [agentName, loadHistory, trimMessages]);

  /* ── WebSocket message handler ── */
  const wireWs = useCallback((ws: WebSocket) => {
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        let sid = activeStreamId.current;

        // Auto-create placeholder on turn_start (e.g. from relay/external trigger)
        if (msg.type === 'turn_start' && !sid) {
          const agentId = `agent-${msgCounter.current++}`;
          activeStreamId.current = agentId;
          sid = agentId;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setSending(true);
          setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
          return;
        }

        // Auto-create placeholder if streaming data arrives with no active stream
        if (!sid && (msg.type === 'message_delta' || msg.type === 'streaming_delta' || msg.type === 'reasoning_delta' || msg.type === 'tool_start')) {
          const agentId = `agent-${msgCounter.current++}`;
          activeStreamId.current = agentId;
          sid = agentId;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setSending(true);
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
          toolsBuf.current = [...toolsBuf.current, { tool: msg.tool, description, status: 'running', timestamp: Date.now(), input }];
          if (sid) { const tools = [...toolsBuf.current]; setMessages(prev => prev.map(m => m.id === sid ? { ...m, tools } : m)); }
        } else if (msg.type === 'tool_complete') {
          const output = (msg.output || msg.result) ? (typeof (msg.output || msg.result) === 'string' ? (msg.output || msg.result) : JSON.stringify(msg.output || msg.result)) : undefined;
          toolsBuf.current = toolsBuf.current.map(t =>
            t.tool === msg.tool && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now(), output } : t
          );
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
          if (sid) {
            setMessages(prev => prev.map(m => m.id === sid ? {
              ...m,
              text: msg.content || streamBuf.current,
              thinking: msg.thinking || thinkBuf.current || undefined,
              tokens: msg.outputTokens,
              tools: toolsBuf.current.length > 0 ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() })) : undefined,
              streaming: false,
            } : m));
          }
          activeStreamId.current = null;
          streamBuf.current = '';
          thinkBuf.current = '';
          toolsBuf.current = [];
          setLiveIntent(null);
          setLiveUsage(null);
          setSending(false);
        } else if (msg.type === 'aborted') {
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: m.text || '(aborted)', streaming: false } : m));
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false);
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
          setPendingPermission({ id: msg.requestId, tool: msg.tool, args: msg.args });
        } else if (msg.type === 'system') {
          setMessages(prev => [...prev, { id: `sys-${msgCounter.current++}`, role: 'system', text: msg.message, timestamp: Date.now() }]);
        } else if (msg.type === 'error') {
          if (sid) setMessages(prev => prev.map(m => m.id === sid ? { ...m, text: `Error: ${msg.message}`, streaming: false } : m));
          else setMessages(prev => [...prev, { id: `err-${msgCounter.current++}`, role: 'system', text: `⚠ ${msg.message}`, timestamp: Date.now() }]);
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setSending(false);
        } else if (msg.type === 'turn_end') {
          if (sid && streamBuf.current) {
            const text = streamBuf.current;
            const thinking = thinkBuf.current || undefined;
            const tools = toolsBuf.current.length > 0
              ? toolsBuf.current.map(t => ({ ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() }))
              : undefined;
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, text, thinking, tools, streaming: false } : m));
          } else if (sid) {
            setMessages(prev => prev.map(m => m.id === sid ? { ...m, streaming: false } : m));
          }
          activeStreamId.current = null; streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
          setLiveIntent(null); setLiveUsage(null); setSending(false);
        } else if (msg.type === 'user_message') {
          const prompt = msg.prompt || '';
          const from = prompt.startsWith('[Message from ') ? prompt.match(/\[Message from (.+?)\]/)?.[1] : undefined;
          setMessages(prev => trimMessages([...prev, { id: `ext-${msgCounter.current++}`, role: 'user', text: prompt, from: from || 'external', timestamp: Date.now() }]));
        }
      } catch {}
    };
  }, [agentName, trimMessages]);

  /* ── WebSocket connection with auto-reconnect ── */
  const connectWs = useCallback(() => {
    if (!agentName) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(`${WS_BASE}?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    wireWs(ws);
    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = 1000;
      if (pendingSendRef.current) {
        const prompt = pendingSendRef.current;
        pendingSendRef.current = null;
        const agentId = `a-${msgCounter.current++}`;
        setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
        activeStreamId.current = agentId;
        streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
        setSending(true);
        ws.send(JSON.stringify({ prompt }));
      }
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => connectWs(), reconnectDelay.current);
      reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 15000);
    };
  }, [agentName, wireWs, trimMessages]);

  useEffect(() => {
    if (!agentName) return;
    connectWs();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connectWs, agentName]);

  const ensureWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return wsRef.current;
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

    if (sending) return;
    if (isOpen) {
      const agentId = `a-${msgCounter.current++}`;
      setMessages(prev => trimMessages([...prev, { id: agentId, role: 'agent', text: '', streaming: true, timestamp: Date.now() }]));
      activeStreamId.current = agentId;
      streamBuf.current = ''; thinkBuf.current = ''; toolsBuf.current = [];
      setSending(true);
      ws!.send(JSON.stringify({ prompt: text }));
    } else {
      pendingSendRef.current = text;
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
    if (!pendingPermission || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ action: 'permission_response', requestId: pendingPermission.id, approved }));
    setPendingPermission(null);
  }, [pendingPermission]);

  /* ── Reset on agent change ── */
  useEffect(() => {
    setMessages([]);
    setSending(false);
    setLiveIntent(null);
    setLiveUsage(null);
    setPendingPermission(null);
    activeStreamId.current = null;
    streamBuf.current = '';
    thinkBuf.current = '';
    toolsBuf.current = [];
  }, [agentName]);

  return {
    messages, setMessages,
    connected, sending,
    liveIntent, liveUsage, agentMode,
    pendingPermission,
    send, abort, compact, changeMode, respondPermission,
    inputHistory: inputHistoryRef,
    historyIndex: historyIndexRef,
    wsRef,
  };
}
