#!/usr/bin/env node
/**
 * Copilot Town CLI — start, stop, status, open.
 * Pure Node.js — no PowerShell, no -ExecutionPolicy Bypass.
 * Avoids EDR/security alerts triggered by PowerShell execution policy flags.
 *
 * Usage:
 *   node scripts/ctl.cjs start [--no-browser]
 *   node scripts/ctl.cjs stop
 *   node scripts/ctl.cjs status
 *   node scripts/ctl.cjs open
 */
const { execSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.COPILOT_TOWN_PORT || '3848');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PID_FILE = path.join(HOME, '.copilot', 'copilot-town.pid');
const LOG_FILE = path.join(HOME, '.copilot', 'copilot-town.log');
const SERVER_SCRIPT = path.join(ROOT, 'server', 'index.ts');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const args = process.argv.slice(2);
const action = args[0] || 'status';
const noBrowser = args.includes('--no-browser') || args.includes('-NoBrowser');

// ── Helpers ───────────────────────────────────────────────────────

function isPortInUse(port) {
  return new Promise((resolve) => {
    // Try connecting to the port — works regardless of bind address
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
  });
}

function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 400);
      });
    };
    check();
  });
}

function getServerPid() {
  // Try PID file first
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (pid && isProcessAlive(pid)) return pid;
    }
  } catch {}
  return null;
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano', { encoding: 'utf-8', windowsHide: true });
      const line = out.split('\n').find(l => l.includes(`:${port}`) && l.includes('LISTEN'));
      if (line) {
        const match = line.match(/LISTENING\s+(\d+)/);
        if (match) return parseInt(match[1]);
      }
    } else {
      const out = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
      if (out) return parseInt(out);
    }
  } catch {}
  return null;
}

function ensureDeps() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) {
    console.log('[copilot-town] Installing dependencies...');
    execSync('npm install --silent --no-progress', {
      cwd: ROOT, stdio: 'ignore', timeout: 120000, windowsHide: true,
    });
  }
}

function openBrowser(url) {
  const { platform } = process;
  try {
    if (platform === 'win32') execSync(`start "" "${url}"`, { windowsHide: true });
    else if (platform === 'darwin') execSync(`open "${url}"`);
    else execSync(`xdg-open "${url}" 2>/dev/null`);
  } catch {}
}

// ── Actions ───────────────────────────────────────────────────────

async function doStart() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    console.log(`[copilot-town] Server already running on port ${PORT}`);
    if (!noBrowser) openBrowser(`http://localhost:${PORT}`);
    process.exit(0);
  }

  ensureDeps();

  // Open log file
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');

  // Spawn server — pure node, no PowerShell.
  // detached:true is needed on all platforms so the child survives parent exit.
  // windowsHide:true suppresses the console window flash on Windows.
  const child = spawn(process.execPath, [TSX_CLI, SERVER_SCRIPT], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, COPILOT_TOWN_PORT: String(PORT) },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);

  // Save PID
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
  } catch {}

  // Wait for server to be ready
  const ready = await waitForPort(PORT, 8000);
  if (ready) {
    console.log(`[copilot-town] Server running on port ${PORT} (PID: ${child.pid})`);
    console.log(`[copilot-town] Dashboard: http://localhost:${PORT}`);
    console.log(`[copilot-town] Logs: ${LOG_FILE}`);
    if (!noBrowser) openBrowser(`http://localhost:${PORT}`);
  } else {
    console.error(`[copilot-town] Server failed to start. Check logs: ${LOG_FILE}`);
    process.exit(1);
  }
}

async function doStop() {
  // Try PID file first
  const pid = getServerPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    console.log(`[copilot-town] Server stopped (PID: ${pid})`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    return;
  }

  // Fallback: if port is in use, find and kill the process
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    const foundPid = findPidOnPort(PORT);
    if (foundPid) {
      try { process.kill(foundPid, 'SIGTERM'); } catch {}
      console.log(`[copilot-town] Server stopped (PID: ${foundPid})`);
      try { fs.unlinkSync(PID_FILE); } catch {}
      return;
    }
    console.log(`[copilot-town] Server on port ${PORT} — could not determine PID.`);
  } else {
    console.log('[copilot-town] Server not running');
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function doStatus() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    const pid = getServerPid() || findPidOnPort(PORT);
    console.log(`[copilot-town] Server running on port ${PORT}${pid ? ` (PID: ${pid})` : ''}`);
    console.log(`[copilot-town] Dashboard: http://localhost:${PORT}`);
  } else {
    console.log('[copilot-town] Server not running');
    // Clean stale PID file
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
  }
}

async function doOpen() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    openBrowser(`http://localhost:${PORT}`);
    console.log('[copilot-town] Dashboard opened');
  } else {
    console.log('[copilot-town] Server not running. Use: node scripts/ctl.cjs start');
  }
}

// ── Main ──────────────────────────────────────────────────────────

(async () => {
  switch (action) {
    case 'start': await doStart(); break;
    case 'stop':  await doStop(); break;
    case 'status': await doStatus(); break;
    case 'open':  await doOpen(); break;
    default:
      console.log('Usage: node scripts/ctl.cjs {start|stop|status|open} [--no-browser]');
      process.exit(1);
  }
})();
