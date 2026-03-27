import { execSync } from 'child_process';

// Detect available multiplexer binary (psmux on Windows, tmux on Mac/Linux)
let MUX_BIN: string | null = null;

function detectMux(): string | null {
  if (MUX_BIN !== null) return MUX_BIN;
  for (const bin of ['psmux', 'tmux']) {
    try {
      execSync(`${bin} -V`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      MUX_BIN = bin;
      return bin;
    } catch {}
  }
  MUX_BIN = ''; // empty = not found (but don't re-detect)
  return null;
}

/** Returns true if psmux/tmux is available on this system */
export function isMuxAvailable(): boolean {
  return !!detectMux();
}

/** Returns the detected multiplexer name or null */
export function getMuxBinary(): string | null {
  return detectMux() || null;
}

export interface PsmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface PsmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  command: string;
  pid: number;
  active: boolean;
  width: number;
  height: number;
  target: string; // "session:window.pane"
}

const IS_WIN = process.platform === 'win32';
const SHELL: string = IS_WIN ? 'powershell.exe' : '/bin/sh';

function exec(cmd: string, needsUtf8 = false): string {
  const bin = detectMux();
  if (!bin) return '';
  const resolved = cmd.replace(/^psmux\b/, bin);
  try {
    const prefix = IS_WIN && needsUtf8 ? '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' : '';
    return execSync(
      `${prefix}${resolved}`,
      { encoding: 'utf-8', timeout: 10000, shell: SHELL }
    ).trim();
  } catch (e: any) {
    console.error(`${bin} exec failed:`, resolved, e.message);
    return '';
  }
}

// ── Validation & strict execution ──

const TARGET_RE = /^[a-zA-Z0-9_\-.:@%]+$/;
const NAME_RE = /^[a-zA-Z0-9_\-. ]+$/;

function sanitizeTarget(t: string): string {
  if (!TARGET_RE.test(t)) throw new Error('Invalid target format');
  return t;
}

function sanitizeName(n: string): string {
  if (!NAME_RE.test(n)) throw new Error('Invalid name — alphanumeric, dash, underscore, dot, or space only');
  return n;
}

/** Like exec() but throws on failure so callers can propagate errors. */
function strictExec(cmd: string): string {
  const bin = detectMux();
  if (!bin) throw new Error('No terminal multiplexer found. Install psmux (Windows) or tmux (Mac/Linux).');
  const resolved = cmd.replace(/^psmux\b/, bin);
  return execSync(resolved, { encoding: 'utf-8', timeout: 10000, shell: SHELL }).trim();
}

export function listSessions(): PsmuxSession[] {
  const raw = exec('psmux list-sessions');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    // Default format: "name: N windows (created ...) (attached?)"
    const match = line.match(/^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)(\s+\(attached\))?/);
    if (match) {
      return {
        name: match[1].trim(),
        windows: parseInt(match[2]) || 0,
        created: match[3],
        attached: !!match[4],
      };
    }
    // Fallback: just take everything before the colon
    const name = line.split(':')[0].trim();
    return { name, windows: 0, created: '', attached: false };
  });
}

export function listPanes(session?: string): PsmuxPane[] {
  const target = session ? `-t ${session}` : '-a';
  const raw = exec(
    `psmux list-panes ${target} -F "#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}|#{pane_pid}|#{pane_active}|#{pane_width}|#{pane_height}"`
  );
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [sessionName, windowIndex, paneIndex, command, pid, active, width, height] = line.split('|');
    const wi = parseInt(windowIndex) || 0;
    const pi = parseInt(paneIndex) || 0;
    return {
      sessionName,
      windowIndex: wi,
      paneIndex: pi,
      command,
      pid: parseInt(pid) || 0,
      active: active === '1',
      width: parseInt(width) || 0,
      height: parseInt(height) || 0,
      target: `${sessionName}:${wi}.${pi}`,
    };
  });
}

export function capturePane(target: string, lines = 100, ansi = false): string {
  const flag = ansi ? '-e -p' : '-p';
  return exec(`psmux capture-pane ${flag} -t "${sanitizeTarget(target)}" -S -${lines}`, true);
}

export function getPaneDimensions(target: string): { width: number; height: number } | null {
  const panes = listPanes();
  const pane = panes.find(p => p.target === target);
  return pane ? { width: pane.width, height: pane.height } : null;
}

// Send text to a pane. Multi-line text chains lines with Enter keys
// in ONE psmux command: 'line1' Enter 'line2' Enter 'line3'
export function sendKeys(target: string, text: string, pressEnter = true): boolean {
  try {
    const safeTarget = sanitizeTarget(target);
    const esc = (s: string) => s.replace(/'/g, "''");

    if (text.includes('\n')) {
      const parts = text.split('\n').map(line => `'${esc(line)}'`).join(' Enter ');
      const enterArg = pressEnter ? ' Enter' : '';
      exec(`psmux send-keys -t '${esc(safeTarget)}' ${parts}${enterArg}`);
    } else {
      const enterArg = pressEnter ? ' Enter' : '';
      exec(`psmux send-keys -t '${esc(safeTarget)}' '${esc(text)}'${enterArg}`);
    }
    return true;
  } catch {
    return false;
  }
}

// Send Escape key
export function sendEscape(target: string): boolean {
  try {
    exec(`psmux send-keys -t "${sanitizeTarget(target)}" Escape`);
    return true;
  } catch {
    return false;
  }
}

export function createSession(name: string): boolean {
  try {
    exec(`psmux new-session -d -s "${sanitizeName(name)}"`);
    return true;
  } catch {
    return false;
  }
}

export function splitPane(sessionTarget: string, vertical = true): PsmuxPane | null {
  try {
    const flag = vertical ? '-v' : '-h';
    // split-window creates a new pane; capture its info
    exec(`psmux split-window ${flag} -t "${sanitizeTarget(sessionTarget)}"`);
    // New pane becomes the active pane — find it
    const panes = listPanes();
    // The newest pane in this session is the one just created (highest pane index)
    const session = sessionTarget.split(':')[0];
    const sessionPanes = panes.filter(p => p.sessionName === session);
    if (sessionPanes.length === 0) return null;
    // Return the pane with highest index (just created)
    return sessionPanes.reduce((a, b) => a.paneIndex > b.paneIndex ? a : b);
  } catch {
    return null;
  }
}

// Change layout of all panes in a window
// Layouts: 'even-horizontal' (side by side), 'even-vertical' (stacked), 'tiled', 'main-horizontal', 'main-vertical'
export function selectLayout(windowTarget: string, layout: string): boolean {
  try {
    exec(`psmux select-layout -t "${sanitizeTarget(windowTarget)}" ${layout}`);
    return true;
  } catch {
    return false;
  }
}

// Create a new window in an existing session
export function newWindow(session: string, name?: string): boolean {
  try {
    const nameArg = name ? ` -n "${sanitizeName(name)}"` : '';
    exec(`psmux new-window -t "${sanitizeName(session)}"${nameArg}`);
    return true;
  } catch {
    return false;
  }
}

// ── Kill operations ──

export function killPane(target: string): void {
  strictExec(`psmux kill-pane -t "${sanitizeTarget(target)}"`);
}

export function killWindow(target: string): void {
  strictExec(`psmux kill-window -t "${sanitizeTarget(target)}"`);
}

export function killSession(name: string): void {
  strictExec(`psmux kill-session -t "${sanitizeName(name)}"`);
}

export function killServer(): void {
  strictExec('psmux kill-server');
}

// ── Rename operations ──

export function renameSession(oldName: string, newName: string): void {
  strictExec(`psmux rename-session -t "${sanitizeName(oldName)}" "${sanitizeName(newName)}"`);
}

export function renameWindow(target: string, newName: string): void {
  strictExec(`psmux rename-window -t "${sanitizeTarget(target)}" "${sanitizeName(newName)}"`);
}

// ── Pane operations ──

export function selectPane(target: string): void {
  strictExec(`psmux select-pane -t "${sanitizeTarget(target)}"`);
}

export function resizePane(target: string, direction: 'U' | 'D' | 'L' | 'R', amount: number): void {
  if (amount < 1 || amount > 100) throw new Error('Amount must be 1-100');
  strictExec(`psmux resize-pane -t "${sanitizeTarget(target)}" -${direction} ${amount}`);
}

export function zoomPane(target: string): void {
  strictExec(`psmux resize-pane -Z -t "${sanitizeTarget(target)}"`);
}

export function swapPane(target: string, direction: 'U' | 'D'): void {
  strictExec(`psmux swap-pane -t "${sanitizeTarget(target)}" -${direction}`);
}

export function breakPane(target: string): void {
  strictExec(`psmux break-pane -t "${sanitizeTarget(target)}"`);
}

export function joinPane(source: string, target: string): void {
  strictExec(`psmux join-pane -s "${sanitizeTarget(source)}" -t "${sanitizeTarget(target)}"`);
}

export function respawnPane(target: string): void {
  strictExec(`psmux respawn-pane -k -t "${sanitizeTarget(target)}"`);
}

// ── Window operations ──

export function selectWindow(target: string): void {
  strictExec(`psmux select-window -t "${sanitizeTarget(target)}"`);
}

export function rotateWindow(target: string): void {
  strictExec(`psmux rotate-window -t "${sanitizeTarget(target)}"`);
}

export interface PsmuxWindow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneCount: number;
  active: boolean;
}

export function listWindows(session?: string): PsmuxWindow[] {
  const target = session ? `-t "${sanitizeName(session)}"` : '-a';
  const raw = exec(
    `psmux list-windows ${target} -F "#{session_name}|#{window_index}|#{window_name}|#{window_panes}|#{window_active}"`
  );
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    const [sessionName, windowIndex, windowName, paneCount, active] = line.split('|');
    return {
      sessionName,
      windowIndex: parseInt(windowIndex) || 0,
      windowName: windowName || '',
      paneCount: parseInt(paneCount) || 0,
      active: active === '1',
    };
  });
}

// ── Info / Config ──

export function displayMessage(target?: string, format?: string): string {
  const targetArg = target ? ` -t "${sanitizeTarget(target)}"` : '';
  const fmtArg = format || '#{session_name}:#{window_index}.#{pane_index}';
  return exec(`psmux display-message${targetArg} -p "${fmtArg}"`);
}

export function setOption(key: string, value: string, global = true): void {
  if (!/^[a-zA-Z0-9_\-]+$/.test(key)) throw new Error('Invalid option key');
  const globalFlag = global ? ' -g' : '';
  strictExec(`psmux set-option${globalFlag} ${key} "${value}"`);
}

export function showOptions(): string {
  return exec('psmux show-options -g');
}

export function hasSession(name: string): boolean {
  try {
    strictExec(`psmux has-session -t "${sanitizeName(name)}"`);
    return true;
  } catch {
    return false;
  }
}

// ── Auto-provisioning ──

export interface ProvisionConfig {
  maxPanesPerWindow: number;      // default 4
  defaultSession: string;         // default "town"
  defaultLayout: string;          // default "even-horizontal" (side by side)
}

const DEFAULT_PROVISION: ProvisionConfig = {
  maxPanesPerWindow: 4,
  defaultSession: 'town',
  defaultLayout: 'even-horizontal',
};

/**
 * Automatically provision a free pane, creating sessions/windows as needed.
 * Logic:
 *   1. Find an existing free pane → use it
 *   2. Find a window with room (< maxPanes) → split it
 *   3. All windows full → create new window in default session
 *   4. No sessions at all → create session + first pane comes free
 * Returns the target string of the provisioned pane.
 */
export function provisionPane(
  config: Partial<ProvisionConfig> = {},
  isPaneFree?: (pane: PsmuxPane) => boolean,
): { target: string; created: 'reused' | 'split' | 'new-window' | 'new-session' } {
  const cfg = { ...DEFAULT_PROVISION, ...config };

  // 1) Check if any free pane already exists
  const allPanes = listPanes();
  if (isPaneFree) {
    const free = allPanes.filter(isPaneFree);
    if (free.length > 0) {
      return { target: free[0].target, created: 'reused' };
    }
  }

  // 2) Find a window with room to split
  const sessions = listSessions();
  if (sessions.length > 0) {
    const windows = listWindows();
    for (const win of windows) {
      if (win.paneCount < cfg.maxPanesPerWindow) {
        const winTarget = `${win.sessionName}:${win.windowIndex}`;
        // Split horizontally (panes side by side) by default
        const isHorizontal = cfg.defaultLayout === 'even-horizontal';
        const newPane = splitPane(winTarget, !isHorizontal); // splitPane: vertical=true means stacked
        if (newPane) {
          // Re-apply layout to keep things tidy
          try { selectLayout(winTarget, cfg.defaultLayout); } catch {}
          return { target: newPane.target, created: 'split' };
        }
      }
    }

    // 3) All windows full → create new window in preferred session
    const preferredSession = sessions.find(s => s.name === cfg.defaultSession) || sessions[0];
    if (newWindow(preferredSession.name)) {
      // New window comes with 1 free pane — find it
      const updatedPanes = listPanes(preferredSession.name);
      const newWinPanes = updatedPanes.filter(p =>
        !allPanes.some(old => old.target === p.target)
      );
      if (newWinPanes.length > 0) {
        return { target: newWinPanes[0].target, created: 'new-window' };
      }
      // Fallback: highest window index pane
      const highest = updatedPanes.reduce((a, b) =>
        a.windowIndex > b.windowIndex ? a : (a.windowIndex === b.windowIndex && a.paneIndex > b.paneIndex ? a : b)
      );
      return { target: highest.target, created: 'new-window' };
    }
  }

  // 4) No sessions at all → create one
  const sessName = cfg.defaultSession;
  createSession(sessName);
  // New session comes with 1 pane
  const newPanes = listPanes(sessName);
  if (newPanes.length > 0) {
    return { target: newPanes[0].target, created: 'new-session' };
  }

  throw new Error('Failed to provision a pane — psmux may not be available');
}
