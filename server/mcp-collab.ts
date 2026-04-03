/**
 * Copilot Town Collaboration MCP Server (stdio)
 *
 * Provides get_agents, relay_message, share_note, read_notes, set_status
 * tools to headless agent sessions via MCP protocol.
 *
 * Launched as a child process per headless session with AGENT_NAME env var.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENT_NAME = process.env.AGENT_NAME || 'unknown';
const PORT = parseInt(process.env.COPILOT_TOWN_PORT || '3848', 10);
const SESSION_MAP_FILE = path.join(os.homedir(), '.copilot', 'agent-sessions.json');

// Helper: HTTP POST to the town API
function apiPost(urlPath: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Helper: HTTP GET from the town API
function apiGet(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks }); }
      });
    }).on('error', reject);
  });
}

const server = new McpServer({
  name: 'copilot-town-collab',
  version: '1.0.0',
});

server.tool(
  'get_agents',
  'Get the list of all agents in Copilot Town with their name, status, type, model, and current task.',
  {},
  async () => {
    try {
      const agents: any[] = await apiGet('/api/agents');
      const list = agents.map((a: any) => ({
        name: a.name,
        status: a.status,
        type: a.type || 'pane',
        task: a.task || null,
        model: a.model || null,
        sessionId: a.sessionId?.slice(0, 8),
        isMe: a.name === AGENT_NAME,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Failed to get agents: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  'relay_message',
  'Send a message to another agent in Copilot Town and get their response. Use this to communicate with teammates.',
  { to: z.string().describe('Target agent name (exact match from get_agents)'), message: z.string().describe('Your message to the agent. Be specific — they have no context about your conversation.') },
  async ({ to, message }) => {
    try {
      const result = await apiPost('/api/agents/relay', { from: AGENT_NAME, to, message });
      if (result.response) {
        return { content: [{ type: 'text' as const, text: `Response from ${to}: ${result.response}` }] };
      }
      return { content: [{ type: 'text' as const, text: `Message delivered to ${to}` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Failed to relay to ${to}: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  'share_note',
  'Share a note with the team — a key-value pair any agent can read. Use for sharing decisions, API interfaces, file locations, etc.',
  { key: z.string().describe('Note key (e.g., "auth-api", "db-schema")'), value: z.string().describe('Note content (text/markdown)') },
  async ({ key, value }) => {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      if (!raw.notes) raw.notes = {};
      raw.notes[key] = { value, author: AGENT_NAME, updatedAt: new Date().toISOString() };
      fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(raw, null, 2));
      return { content: [{ type: 'text' as const, text: `Note "${key}" shared` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Failed to share note: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  'read_notes',
  'Read shared notes from the team. Call with no key to get all notes, or with a key to get a specific one.',
  { key: z.string().optional().describe('Note key to read (optional — omit for all notes)') },
  async ({ key }) => {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const notes = raw.notes || {};
      if (key) {
        const note = (notes as any)[key];
        const text = note ? `${key}: ${note.value} (by ${note.author})` : 'Note not found';
        return { content: [{ type: 'text' as const, text }] };
      }
      const text = Object.entries(notes)
        .map(([k, v]: any) => `${k}: ${v.value.slice(0, 100)} (by ${v.author})`)
        .join('\n') || 'No notes';
      return { content: [{ type: 'text' as const, text }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Failed to read notes: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  'set_status',
  'Set your current task/status text so other agents and the dashboard can see what you are working on.',
  { task: z.string().describe('What you are currently working on (short text)') },
  async ({ task }) => {
    try {
      await apiPost('/api/events', { type: 'task', message: `${AGENT_NAME}: ${task}`, level: 'info', source: AGENT_NAME });
      return { content: [{ type: 'text' as const, text: `Status set: "${task}"` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Status set locally: "${task}"` }] };
    }
  }
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
