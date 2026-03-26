#!/usr/bin/env node
/**
 * Hook script called on sessionStart/sessionEnd.
 * Registers the session in agent-sessions.json so the hub can track it.
 * 
 * Environment variables from copilot:
 *   COPILOT_SESSION_ID — the session UUID
 *   COPILOT_AGENT — the agent name (if --agent was used)
 *   COPILOT_TOWN_HOOK — "sessionStart" or "sessionEnd"
 */
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SESSION_FILE = path.join(HOME, '.copilot', 'agent-sessions.json');
const hookType = process.env.COPILOT_TOWN_HOOK;
const sessionId = process.env.COPILOT_SESSION_ID;
const agentName = process.env.COPILOT_AGENT;

if (!sessionId) process.exit(0); // No session ID, nothing to do

try {
  let data = { _schema: 'agent-sessions-v2', agents: {}, psmux_layout: {} };
  if (fs.existsSync(SESSION_FILE)) {
    data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  }
  if (!data.agents) data.agents = {};

  const name = agentName || `session-${sessionId.slice(0, 8)}`;

  if (hookType === 'sessionStart') {
    data.agents[name] = {
      ...(data.agents[name] || {}),
      session: sessionId,
      startedAt: new Date().toISOString(),
    };
  } else if (hookType === 'sessionEnd') {
    if (data.agents[name]) {
      data.agents[name].stoppedAt = new Date().toISOString();
    }
  }

  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
} catch (e) {
  // Silent fail — hooks should never break copilot
}
