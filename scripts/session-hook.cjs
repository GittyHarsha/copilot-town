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
      const ps1Src = path.join(PLUGIN_ROOT, 'scripts', 'copilot-town.ps1');
      const content = `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Src}" %*\r\n`;
      // Always overwrite — plugin path may change between installs
      fs.writeFileSync(cmdPath, content);
    } else {
      const shPath = path.join(COPILOT_DIR, 'copilot-town');
      const ps1Src = path.join(PLUGIN_ROOT, 'scripts', 'copilot-town.ps1');
      // Use bash wrapper that calls start.ps1 via node for Unix
      const startScript = path.join(PLUGIN_ROOT, 'start.sh');
      let content;
      if (fs.existsSync(startScript)) {
        content = `#!/bin/sh\nexec "${startScript}" "$@"\n`;
      } else {
        // Fallback: call node ensure-server.cjs --start
        const ensure = path.join(PLUGIN_ROOT, 'scripts', 'ensure-server.cjs');
        content = `#!/bin/sh\ncase "\${1:-status}" in\n  start)\n    cd "${PLUGIN_ROOT}" && npx tsx server/index.ts &\n    echo "[copilot-town] Server starting on port \${COPILOT_TOWN_PORT:-3848}"\n    ;;\n  stop)\n    PID=$(lsof -ti:\${COPILOT_TOWN_PORT:-3848} 2>/dev/null)\n    [ -n "$PID" ] && kill "$PID" && echo "[copilot-town] Stopped (PID $PID)" || echo "[copilot-town] Not running"\n    ;;\n  open)\n    open "http://localhost:\${COPILOT_TOWN_PORT:-3848}" 2>/dev/null || xdg-open "http://localhost:\${COPILOT_TOWN_PORT:-3848}" 2>/dev/null\n    ;;\n  status)\n    lsof -i:\${COPILOT_TOWN_PORT:-3848} >/dev/null 2>&1 && echo "[copilot-town] Running on port \${COPILOT_TOWN_PORT:-3848}" || echo "[copilot-town] Not running"\n    ;;\n  *) echo "Usage: copilot-town {start|stop|open|status}";;\nesac\n`;
      }
      fs.writeFileSync(shPath, content, { mode: 0o755 });
    }
  } catch {
    // Silent — don't break session startup
  }
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
  } else if (hookType === 'sessionEnd') {
    if (data.agents[name]) {
      data.agents[name].stoppedAt = new Date().toISOString();
    }
  }

  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
} catch (e) {
  // Silent fail — hooks should never break copilot
}
