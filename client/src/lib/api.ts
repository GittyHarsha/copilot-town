const API_BASE = '/api';

export interface AgentData {
  id: string;              // session ID (UUID) — primary key
  name: string;            // display name
  status: 'running' | 'idle' | 'stopped';
  type?: 'pane' | 'headless';
  source?: 'user' | 'workflow';
  template?: {
    name: string;
    description: string;
    model?: string;
    filePath: string;
    source: 'user' | 'project';
  };
  pane?: {
    sessionName: string;
    windowIndex: number;
    paneIndex: number;
    command: string;
    pid: number;
    target: string;
  };
  sessionId: string;
  // Persisted metadata (from agent-sessions.json)
  description?: string;
  model?: string;
  flags?: string[];
  envVars?: Record<string, string>;
  task?: string;
  // SDK enrichment
  summary?: string;
  reasoningEffort?: string;
  agentMode?: string;
}

export interface AgentTemplate {
  name: string;
  description: string;
  model?: string;
  filePath: string;
  source: 'user' | 'project';
}

export interface PsmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface CopilotSession {
  id: string;
  lastModified: string;
  hasPlan: boolean;
  planSnippet?: string;
  summary?: string;
  cwd?: string;
  agentName?: string;
  isOrphaned: boolean;
  checkpoints: { number: number; title: string; filename: string }[];
  type?: 'pane' | 'headless';
}

export interface Town {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  agents: string[];
  parent?: string;
  level: 'town' | 'city' | 'state' | 'country';
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: string;
  agent?: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
}

export interface HealthStatus {
  status: string;
  timestamp: string;
  port: number;
  agents: Record<string, { status: string; lastCheck: string; details?: any }>;
  mux: { available: boolean; binary: string };
}

export interface StatusChange {
  agent: string;
  oldStatus: string;
  newStatus: string;
  timestamp: string;
}

export interface StatusTimeline {
  agent: string;
  entries: { timestamp: string; status: string }[];
}

export interface ToolInfo {
  name: string;
  description: string;
  category: 'mcp' | 'sdk';
  parameters?: object;
  stats: {
    totalCalls: number;
    lastUsed: string | null;
    avgDuration: number | null;
    agentsUsed: string[];
  };
}

export interface AgentToolsInfo {
  agent: string;
  available: { name: string; description: string; category: string }[];
  activity: { timestamp: string; tool: string; args?: any; result?: string; duration?: number }[];
  stats: { totalCalls: number; uniqueTools: number; lastActive: string | null };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson<T>(url: string, body?: object): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

async function putJson<T>(url: string, body?: object): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export interface Config {
  port: number;
  defaultSession: string;
  maxPanesPerWindow: number;
  autoOpenBrowser: boolean;
}

export const api = {
  // Config
  getConfig: () => fetchJson<Config>('/config'),
  updateConfig: (config: Partial<Config>) => putJson<Config>('/config', config),

  // Agent settings
  updateAgentSettings: (id: string, settings: {
    name?: string; description?: string; template?: string;
    model?: string; flags?: string[]; envVars?: Record<string, string>;
  }) =>
    putJson<AgentData>(`/agents/${encodeURIComponent(id)}/settings`, settings),
  deleteAgentSettings: (id: string) =>
    deleteJson<{ success: boolean }>(`/agents/${encodeURIComponent(id)}/settings`),

  // Agents
  getAgents: () => fetchJson<AgentData[]>('/agents'),
  getAgent: (id: string) => fetchJson<AgentData & { mdContent?: string }>(`/agents/${encodeURIComponent(id)}`),
  getAgentOutput: (id: string, lines = 50) => fetchJson<{ output: string }>(`/agents/${encodeURIComponent(id)}/output?lines=${lines}`),
  sendMessage: (id: string, message: string, from?: string) =>
    postJson<{ success: boolean }>(`/agents/${encodeURIComponent(id)}/message`, { message, from }),
  relayMessage: (from: string, to: string, message: string) =>
    postJson<{ success: boolean; from: string; to: string }>('/agents/relay', { from, to, message }),
  startAgent: (id: string, target?: string) =>
    postJson<{ success: boolean }>(`/agents/${encodeURIComponent(id)}/start`, { target }),
  spawnAgent: (opts: {
    name: string; template?: string; model?: string; flags?: string[];
    session?: string; headless?: boolean; role?: string; reasoningEffort?: string;
  }) =>
    postJson<{ ok: boolean; name: string; pane?: string; command?: string; type?: string; sessionId?: string; model?: string }>('/agents/spawn', opts),
  resumeAgent: (id: string, target?: string, autoCreate?: boolean, session?: string, command?: string) => {
    const body: any = {};
    if (target) body.target = target;
    if (autoCreate) body.autoCreate = true;
    if (session) body.session = session;
    if (command) body.command = command;
    return postJson<{ success: boolean }>(`/agents/${encodeURIComponent(id)}/resume`, body);
  },
  stopAgent: (id: string) => postJson<{ success: boolean }>(`/agents/${encodeURIComponent(id)}/stop`),

  // SDK features — headless agents
  setAgentModel: (id: string, model: string, reasoningEffort?: string) =>
    postJson<{ success: boolean; model: string; reasoningEffort?: string }>(
      `/agents/${encodeURIComponent(id)}/model`, { model, reasoningEffort }),
  setAgentMode: (id: string, mode: string) =>
    postJson<{ success: boolean; mode: string }>(
      `/agents/${encodeURIComponent(id)}/mode`, { mode }),
  getAgentMode: (id: string) =>
    fetchJson<{ mode: string }>(`/agents/${encodeURIComponent(id)}/mode`),
  moveToPaneAgent: (id: string) =>
    postJson<{ success: boolean; pane: string; sessionId: string }>(
      `/agents/${encodeURIComponent(id)}/move-to-pane`),
  moveToHeadlessAgent: (id: string) =>
    postJson<{ success: boolean; sessionId: string; model: string }>(
      `/agents/${encodeURIComponent(id)}/move-to-headless`),
  getToolActivity: (id: string) =>
    fetchJson<{ agent: string; activity: { timestamp: string; tool: string; result?: string }[] }>(
      `/agents/${encodeURIComponent(id)}/tools/activity`),

  // Tools registry
  getToolsRegistry: () => fetchJson<{ tools: ToolInfo[] }>('/tools'),
  getAgentTools: (name: string) => fetchJson<AgentToolsInfo>(`/tools/agents/${encodeURIComponent(name)}`),
  getSessionDetails: (id: string) => fetchJson<any>(`/sessions/${id}/details`),
  getAgentMessages: (id: string) =>
    fetchJson<{ messages: any[] }>(`/agents/${encodeURIComponent(id)}/messages`),

  // Templates
  getTemplates: () => fetchJson<AgentTemplate[]>('/templates'),

  // psmux — read
  getPsmuxSessions: () => fetchJson<PsmuxSession[]>('/psmux/sessions'),
  getPsmuxPanes: (session?: string) => fetchJson<any[]>(`/psmux/panes${session ? `?session=${session}` : ''}`),
  getPsmuxWindows: (session?: string) => fetchJson<any[]>(`/psmux/windows${session ? `?session=${session}` : ''}`),
  capturePane: (target: string) => fetchJson<{ output: string }>(`/psmux/capture/${target}`),
  hasPsmuxSession: (name: string) => fetchJson<{ exists: boolean }>(`/psmux/sessions/${encodeURIComponent(name)}/exists`),
  getPsmuxOptions: () => fetchJson<{ options: string }>('/psmux/options'),

  // psmux — create
  createPsmuxSession: (name: string) => postJson<{ success: boolean }>('/psmux/sessions', { name }),
  splitPsmuxPane: (session: string, vertical = true) =>
    postJson<{ success: boolean }>('/psmux/split', { session, vertical }),
  selectLayout: (target: string, layout: string) =>
    postJson<{ success: boolean }>('/psmux/layout', { target, layout }),
  createPsmuxWindow: (session: string, name?: string) =>
    postJson<{ success: boolean }>('/psmux/windows', { session, name }),

  // psmux — pane actions
  selectPane: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/select`, {}),
  resizePane: (target: string, direction: string, amount = 5) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/resize`, { direction, amount }),
  zoomPane: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/zoom`, {}),
  swapPane: (target: string, direction: string) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/swap`, { direction }),
  breakPane: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/break`, {}),
  joinPane: (source: string, target: string) =>
    postJson<{ ok: boolean }>('/psmux/panes/join', { source, target }),
  respawnPane: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}/respawn`, {}),

  // psmux — window actions
  selectWindow: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/windows/${encodeURIComponent(target)}/select`, {}),
  rotateWindow: (target: string) =>
    postJson<{ ok: boolean }>(`/psmux/windows/${encodeURIComponent(target)}/rotate`, {}),

  // psmux — rename
  renamePsmuxSession: (name: string, newName: string) =>
    putJson<{ ok: boolean }>(`/psmux/sessions/${encodeURIComponent(name)}`, { name: newName }),
  renamePsmuxWindow: (target: string, newName: string) =>
    putJson<{ ok: boolean }>(`/psmux/windows/${encodeURIComponent(target)}`, { name: newName }),

  // psmux — kill / delete
  killPane: (target: string) =>
    deleteJson<{ ok: boolean }>(`/psmux/panes/${encodeURIComponent(target)}`),
  killWindow: (target: string) =>
    deleteJson<{ ok: boolean }>(`/psmux/windows/${encodeURIComponent(target)}`),
  killPsmuxSession: (name: string) =>
    deleteJson<{ ok: boolean }>(`/psmux/sessions/${encodeURIComponent(name)}`),
  killPsmuxServer: () => deleteJson<{ ok: boolean }>('/psmux/server'),

  // psmux — config
  displayMessage: (target?: string, format?: string) =>
    postJson<{ result: string }>('/psmux/display-message', { target, format }),
  setPsmuxOption: (key: string, value: string, global = true) =>
    postJson<{ ok: boolean }>('/psmux/options', { key, value, global }),

  // Health & Status
  getHealth: () => fetchJson<HealthStatus>('/health'),
  getStatusHistory: (agent: string, limit = 100) => fetchJson<StatusChange[]>(`/status-history/${encodeURIComponent(agent)}?limit=${limit}`),
  getStatusTimeline: (agent: string, since?: string) => fetchJson<any>(`/status-history/${encodeURIComponent(agent)}/timeline${since ? `?since=${since}` : ''}`),

  // Events
  getEvents: (limit = 200) => fetchJson<ActivityEvent[]>(`/events?limit=${limit}`),

  // Sessions
  getSessions: (limit = 20) => fetchJson<CopilotSession[]>(`/sessions?limit=${limit}`),
  getOrphanedSessions: () => fetchJson<CopilotSession[]>('/sessions/orphaned'),
  getSessionPlan: (id: string) => fetchJson<{ plan: string }>(`/sessions/${id}/plan`),
  registerSession: (id: string, name: string) =>
    postJson<{ success: boolean; sessionId: string; name: string }>(`/sessions/${id}/register`, { name }),

  // Conversations
  getConversation: (sessionId: string) =>
    fetchJson<{ turn_index: number; user_message: string; assistant_response: string; timestamp: string }[]>(
      `/conversations/${encodeURIComponent(sessionId)}`
    ),
  getConversationSummary: (sessionId: string) =>
    fetchJson<{ id: string; summary: string; branch: string; created_at: string; updated_at: string }>(
      `/conversations/${encodeURIComponent(sessionId)}/summary`
    ),
  getSessionList: (q?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJson<{ id: string; summary: string; branch: string; created_at: string; updated_at: string }[]>(
      `/conversations${qs ? '?' + qs : ''}`
    );
  },

  // Relays
  getRelays: (limit = 50) =>
    fetchJson<{ from: string; to: string; message: string; timestamp: string }[]>(`/relays?limit=${limit}`),

  // Towns / Hierarchy
  getTowns: () => fetchJson<Town[]>('/towns'),
  createTown: (town: { name: string; description?: string; color?: string; icon?: string; level?: string; agents?: string[]; parent?: string }) =>
    postJson<Town>('/towns', town),
  updateTown: (id: string, updates: Partial<Town>) =>
    fetch(`${API_BASE}/towns/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }).then(r => r.json()),
  deleteTown: (id: string) =>
    fetch(`${API_BASE}/towns/${id}`, { method: 'DELETE' }).then(r => r.json()),
  addAgentToTown: (townId: string, agentName: string) =>
    postJson(`/towns/${townId}/agents`, { agentName }),
  removeAgentFromTown: (townId: string, agentName: string) =>
    fetch(`${API_BASE}/towns/${townId}/agents/${agentName}`, { method: 'DELETE' }).then(r => r.json()),

  // Workflows
  getWorkflows: () => fetchJson<any[]>('/workflows'),
  getWorkflow: (id: string) => fetchJson<any>(`/workflows/${encodeURIComponent(id)}`),
  reloadWorkflows: () => postJson<any>('/workflows/reload'),
  createWorkflow: (id: string, yaml: string) => postJson<any>('/workflows', { id, yaml }),
  deleteWorkflow: (id: string) => deleteJson<any>(`/workflows/${encodeURIComponent(id)}`),
  runWorkflow: (id: string, inputs: Record<string, string>) =>
    postJson<any>(`/workflows/${encodeURIComponent(id)}/run`, { inputs }),
  getWorkflowRuns: () => fetchJson<any[]>('/workflows/runs/list'),
  getWorkflowRun: (runId: string) => fetchJson<any>(`/workflows/runs/${encodeURIComponent(runId)}`),
  cancelWorkflowRun: (runId: string) => deleteJson<any>(`/workflows/runs/${encodeURIComponent(runId)}`),
  resolveWorkflowGate: (runId: string, stepId: string, approved: boolean, feedback?: string) =>
    postJson<any>(`/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/gate`, { approved, feedback }),
  rerunFromStep: (runId: string, stepId: string, feedback?: string) =>
    postJson<{ success: boolean; run: any }>(`/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/rerun`, { feedback }),
  rerunSingleStep: (runId: string, stepId: string, feedback?: string) =>
    postJson<{ success: boolean; run: any }>(`/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/rerun-single`, { feedback }),
  chatWithStepAgent: (runId: string, stepId: string, message: string) =>
    postJson<{ response: string; tokens?: number }>(`/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/chat`, { message }),
  pauseWorkflowRun: (runId: string) =>
    postJson<{ ok: boolean }>(`/workflows/runs/${encodeURIComponent(runId)}/pause`),
  resumeWorkflowRun: (runId: string) =>
    postJson<{ ok: boolean }>(`/workflows/runs/${encodeURIComponent(runId)}/resume`),
  getAliveAgents: (runId: string) =>
    fetchJson<{ agents: string[] }>(`/workflows/runs/${encodeURIComponent(runId)}/agents`),
  cleanupRunAgents: (runId: string) =>
    deleteJson<{ ok: boolean }>(`/workflows/runs/${encodeURIComponent(runId)}/agents`),
  promoteStepAgent: (runId: string, stepId: string, name?: string) =>
    postJson<{ agentName: string; promoted: boolean }>(`/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/promote`, { name }),
  getWorkflowAnalytics: (id: string) =>
    fetchJson<any>(`/workflows/${encodeURIComponent(id)}/analytics`),
  getArtifactUrl: (runId: string, stepId: string, name: string) =>
    `${API_BASE}/workflows/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/artifacts/${encodeURIComponent(name)}`,
  generateWebhook: (id: string) =>
    postJson<{ token: string; url: string }>(`/workflows/${encodeURIComponent(id)}/webhook`),
  disableWebhook: (id: string) =>
    deleteJson<{ ok: boolean }>(`/workflows/${encodeURIComponent(id)}/webhook`),

  // Stage files
  getStageFiles: () => fetchJson<string[]>('/workflows/stages/list'),
  getStageFile: (name: string) => fetchJson<{ name: string; content: string }>(`/workflows/stages/${encodeURIComponent(name)}`),
  saveStageFile: (name: string, content: string) => postJson<any>('/workflows/stages', { name, content }),
  deleteStageFile: (name: string) => deleteJson<any>(`/workflows/stages/${encodeURIComponent(name)}`),
};
