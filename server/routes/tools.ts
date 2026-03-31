import { Router } from 'express';
import { listHeadlessAgents, getHeadlessAgent, type ToolActivityEntry } from '../services/headless.js';

const router = Router();

// ── MCP tool definitions (20 tools from ensure-server.cjs) ──────────────
const MCP_TOOLS: { name: string; description: string; parameters?: object }[] = [
  { name: 'copilot_town_open', description: 'Open the Copilot Town dashboard in your browser' },
  { name: 'copilot_town_status', description: 'Get status of all agents in Copilot Town' },
  { name: 'copilot_town_relay', description: 'Relay a message between agents', parameters: { from: 'string', to: 'string', message: 'string' } },
  { name: 'copilot_town_list_templates', description: 'List available agent templates' },
  { name: 'copilot_town_register', description: 'Register this Copilot session as a named agent in Copilot Town', parameters: { name: 'string', session_id: 'string' } },
  { name: 'copilot_town_whoami', description: 'Get your own agent identity — name, session ID, pane, status', parameters: { session_id: 'string' } },
  { name: 'copilot_town_get_agent', description: 'Get details of a specific agent by name or ID', parameters: { agent: 'string' } },
  { name: 'copilot_town_set_status', description: 'Set your current task/status text so other agents and the dashboard can see what you are working on', parameters: { agent: 'string', task: 'string' } },
  { name: 'copilot_town_broadcast', description: 'Send a message to ALL other agents at once', parameters: { from: 'string', message: 'string' } },
  { name: 'copilot_town_read_output', description: "Read the last N lines of another agent's terminal output without messaging them", parameters: { agent: 'string', lines: 'number' } },
  { name: 'copilot_town_set_meta', description: 'Update your own agent metadata — description, model, flags, template', parameters: { agent: 'string', description: 'string', model: 'string', template: 'string', flags: 'string[]' } },
  { name: 'copilot_town_spawn', description: 'Spawn a new agent in a new terminal pane or as headless', parameters: { name: 'string', template: 'string', model: 'string', headless: 'boolean', role: 'string' } },
  { name: 'copilot_town_stop_agent', description: 'Stop another agent by name or ID', parameters: { agent: 'string' } },
  { name: 'copilot_town_promote', description: 'Promote a headless agent to a terminal pane', parameters: { agent: 'string', session: 'string' } },
  { name: 'copilot_town_demote', description: 'Demote a pane agent to headless mode', parameters: { agent: 'string' } },
  { name: 'copilot_town_set_model', description: 'Change the model and/or reasoning effort on a running headless agent', parameters: { agent: 'string', model: 'string', reasoningEffort: 'string' } },
  { name: 'copilot_town_set_mode', description: 'Switch a headless agent between interactive, plan, and autopilot modes', parameters: { agent: 'string', mode: 'string' } },
  { name: 'copilot_town_share_note', description: 'Share a note with the team — a key-value pair that any agent can read', parameters: { key: 'string', value: 'string', author: 'string' } },
  { name: 'copilot_town_get_notes', description: 'Read shared notes from the team', parameters: { key: 'string' } },
  { name: 'copilot_town_wake', description: "Wake up a stopped agent and optionally send it an initial message", parameters: { agent: 'string', message: 'string', from: 'string' } },
];

// ── SDK tool definitions (5 tools registered per headless agent) ────────
const SDK_TOOLS: { name: string; description: string }[] = [
  { name: 'get_agents', description: 'List all agents currently registered in Copilot Town' },
  { name: 'relay_message', description: 'Send a message to another agent' },
  { name: 'share_note', description: 'Share a key-value note with other agents' },
  { name: 'read_notes', description: 'Read shared notes from other agents' },
  { name: 'set_status', description: 'Set your current status/task text' },
];

// ── Helpers ─────────────────────────────────────────────────────────────

interface ToolStats {
  totalCalls: number;
  lastUsed: string | null;
  avgDuration: number | null;
  agentsUsed: string[];
}

function aggregateStats(allActivity: { agentName: string; entry: ToolActivityEntry }[], toolName: string): ToolStats {
  const matches = allActivity.filter(a => a.entry.tool === toolName);
  if (matches.length === 0) {
    return { totalCalls: 0, lastUsed: null, avgDuration: null, agentsUsed: [] };
  }

  const durations = matches.filter(m => m.entry.duration != null).map(m => m.entry.duration!);
  const agents = [...new Set(matches.map(m => m.agentName))];
  const lastUsed = matches
    .map(m => m.entry.timestamp)
    .sort()
    .pop() || null;

  return {
    totalCalls: matches.length,
    lastUsed,
    avgDuration: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    agentsUsed: agents,
  };
}

function collectAllActivity(): { agentName: string; entry: ToolActivityEntry }[] {
  const agents = listHeadlessAgents();
  const result: { agentName: string; entry: ToolActivityEntry }[] = [];
  for (const agent of agents) {
    for (const entry of agent.toolActivity) {
      result.push({ agentName: agent.name, entry });
    }
  }
  return result;
}

// ── GET / — MCP Tools Registry ──────────────────────────────────────────
router.get('/', (_req, res) => {
  const allActivity = collectAllActivity();

  const mcpTools = MCP_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    category: 'mcp' as const,
    parameters: t.parameters || undefined,
    stats: aggregateStats(allActivity, t.name),
  }));

  const sdkTools = SDK_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    category: 'sdk' as const,
    stats: aggregateStats(allActivity, t.name),
  }));

  res.json({ tools: [...mcpTools, ...sdkTools] });
});

// ── GET /agents/:name — Per-agent available tools + activity ────────────
router.get('/agents/:name', (req, res) => {
  const agent = getHeadlessAgent(req.params.name);
  if (!agent) {
    return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
  }

  const available = [
    ...MCP_TOOLS.map(t => ({ name: t.name, description: t.description, category: 'mcp' as const })),
    ...SDK_TOOLS.map(t => ({ name: t.name, description: t.description, category: 'sdk' as const })),
  ];

  const activity = agent.toolActivity;
  const uniqueTools = new Set(activity.map(a => a.tool)).size;
  const lastActive = activity.length > 0
    ? activity.map(a => a.timestamp).sort().pop() || null
    : null;

  res.json({
    agent: agent.name,
    available,
    activity,
    stats: {
      totalCalls: activity.length,
      uniqueTools,
      lastActive,
    },
  });
});

export default router;
