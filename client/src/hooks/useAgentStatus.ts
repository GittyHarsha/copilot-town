import { useState, useEffect, useRef, useCallback } from 'react';
import type { ActivityEvent } from '../lib/api';

interface AgentStatusMsg {
  id: string;
  name: string;
  status: string;
  pane: string | null;
}

interface StatusUpdate {
  type: 'status';
  timestamp: string;
  agents: AgentStatusMsg[];
  psmux?: {
    totalPanes: number;
    sessions: string[];
  };
}

interface EventUpdate {
  type: 'event';
  event: ActivityEvent;
}

type WsMessage = StatusUpdate | EventUpdate;

const MAX_EVENTS = 200;

export function useAgentStatus() {
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<ActivityEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initialEventsLoaded = useRef(false);

  // Load initial events via REST on first connect
  const loadInitialEvents = useCallback(() => {
    if (initialEventsLoaded.current) return;
    initialEventsLoaded.current = true;
    fetch('/api/events?limit=200')
      .then(r => r.ok ? r.json() : [])
      .then((data: ActivityEvent[]) => {
        if (Array.isArray(data)) setEvents(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    function connect() {
      if (disposedRef.current) return;

      try {
        const ws = new WebSocket('ws://localhost:3848/ws/status');

        ws.onopen = () => {
          if (!disposedRef.current) {
            setConnected(true);
            loadInitialEvents();
          }
        };
        ws.onclose = () => {
          if (disposedRef.current) return;
          setConnected(false);
          reconnectTimer.current = setTimeout(connect, 3000);
        };
        ws.onerror = () => {
          // Suppress errors from StrictMode cleanup race
          if (ws.readyState === WebSocket.CONNECTING) return;
          ws.close();
        };
        ws.onmessage = (rawEvent) => {
          try {
            const data = JSON.parse(rawEvent.data) as WsMessage;
            if (data.type === 'status') {
              setStatus(data);
            } else if (data.type === 'event') {
              const evt = (data as EventUpdate).event;
              setLatestEvent(evt);
              setEvents(prev => {
                const next = [...prev, evt];
                return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
              });
            }
          } catch { /* ignore */ }
        };

        wsRef.current = ws;
      } catch { /* connection failed, retry */ 
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    }

    // Small delay to survive StrictMode's immediate unmount
    const startTimer = setTimeout(connect, 100);

    return () => {
      disposedRef.current = true;
      clearTimeout(startTimer);
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect from cleanup
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [loadInitialEvents]);

  return { status, connected, events, latestEvent };
}
