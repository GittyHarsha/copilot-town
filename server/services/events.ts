export type EventType =
  | 'agent_started'
  | 'agent_stopped'
  | 'agent_resumed'
  | 'message_sent'
  | 'relay'
  | 'pane_created'
  | 'pane_killed'
  | 'error'
  | 'health_warning'
  | 'status_change'
  | 'task'
  | 'broadcast'
  | 'spawn';

export type Severity = 'info' | 'warn' | 'error';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: EventType;
  agent?: string;
  message: string;
  severity: Severity;
}

const MAX_EVENTS = 200;
const events: ActivityEvent[] = [];
let idCounter = 0;
let broadcaster: ((event: ActivityEvent) => void) | null = null;

export function setBroadcaster(fn: (event: ActivityEvent) => void) {
  broadcaster = fn;
}

export function pushEvent(
  type: EventType,
  message: string,
  severity: Severity = 'info',
  agent?: string,
): ActivityEvent {
  const event: ActivityEvent = {
    id: `evt-${++idCounter}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type,
    agent,
    message,
    severity,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  if (broadcaster) broadcaster(event);
  return event;
}

export function getRecentEvents(limit = MAX_EVENTS): ActivityEvent[] {
  return events.slice(-limit);
}
