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
const COPILOT_DIR = path.join(HOME, '.copilot');
const SESSION_FILE = path.join(COPILOT_DIR, 'agent-sessions.json');
const hookType = process.env.COPILOT_TOWN_HOOK;
const sessionId = process.env.COPILOT_SESSION_ID;
const agentName = process.env.COPILOT_AGENT;
const PLUGIN_ROOT = path.resolve(__dirname, '..');

if (!sessionId) process.exit(0); // No session ID, nothing to do

// ── Create global launcher scripts on first run ──────────────────
// Drops ~/.copilot/copilot-town.cmd (Windows) and ~/.copilot/copilot-town (Unix)
// so users can start/stop the server without any agent or knowing the plugin path.
function ensureLaunchers() {
  try {
    const isWin = process.platform === 'win32';
    if (isWin) {
      const cmdPath = path.join(COPILOT_DIR, 'copilot-town.cmd');
      const ctlScript = path.join(PLUGIN_ROOT, 'scripts', 'ctl.cjs');
      const content = `@echo off\r\nnode "${ctlScript}" %*\r\n`;
      // Always overwrite — plugin path may change between installs
      fs.writeFileSync(cmdPath, content);
    } else {
      const shPath = path.join(COPILOT_DIR, 'copilot-town');
      const ctlScript = path.join(PLUGIN_ROOT, 'scripts', 'ctl.cjs');
      const content = `#!/bin/sh\nnode "${ctlScript}" "$@"\n`;
      fs.writeFileSync(shPath, content, { mode: 0o755 });
    }
  } catch {
    // Silent — don't break session startup
  }
}

// ── Register with server for PID-based pane detection ──────────────
// Fire-and-forget HTTP POST — if server is down, silently skip.
function tryServerRegister(agentName, sid) {
  try {
    const http = require('http');
    const port = process.env.COPILOT_TOWN_PORT || 3848;
    const body = JSON.stringify({ name: agentName, session_id: sid, ppid: process.ppid });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/agents/register',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    });
    req.on('error', () => {}); // silent
    req.end(body);
  } catch {}
}

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
    // Create global launchers on every session start (idempotent, updates path if plugin moved)
    ensureLaunchers();
    // Register with server for PID-based pane detection + auto-titling (only if real name)
    if (agentName) tryServerRegister(name, sessionId);
  } else if (hookType === 'sessionEnd') {
    if (data.agents[name]) {
      data.agents[name].stoppedAt = new Date().toISOString();
    }
  }

  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
} catch (e) {
  // Silent fail — hooks should never break copilot
}
