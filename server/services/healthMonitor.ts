import { createHash } from 'crypto';
import { getAllAgents, type Agent } from './agents.js';
import { capturePane } from './psmux.js';
import { pushEvent } from './events.js';
import { recordHealthSnapshot } from './statusHistory.js';

export interface AgentHealthState {
  lastOutputHash: string;
  hashSince: number;
  lastWarningAt: number;
  status: 'healthy' | 'warning' | 'hung' | 'crashed';
  message: string;
}

const healthStates = new Map<string, AgentHealthState>();
const HUNG_THRESHOLD_MS = 10 * 60 * 1000;    // 10 minutes
const WARNING_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min between repeated warnings
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const SHELL_PROMPT_PATTERNS = [
  /PS [A-Z]:\\.*>/,
  /\$\s*$/m,
  />\s*$/m,
];

const COPILOT_INDICATORS = [
  'shift+tab',
  'ctrl+s',
  'Type @ to mention',
  'ctrl+q',
  'Selected custom agent',
  'copilot --agent=',
  '⎇',
];

function hashOutput(output: string): string {
  return createHash('md5').update(output).digest('hex');
}

function hasCopilotIndicators(output: string): boolean {
  return COPILOT_INDICATORS.some(ind => output.includes(ind)) ||
    /claude-|gpt-|gemini-/i.test(output);
}

function looksLikeShellPrompt(output: string): boolean {
  const lines = output.split('\n').slice(-5);
  const tail = lines.join('\n');
  return !hasCopilotIndicators(tail) && SHELL_PROMPT_PATTERNS.some(p => p.test(tail));
}

function checkAgent(agent: Agent): void {
  if (!agent.pane) return;
  const now = Date.now();

  let output: string;
  try {
    output = capturePane(agent.pane.target, 5);
  } catch {
    return;
  }

  const currentHash = hashOutput(output);
  const prev = healthStates.get(agent.id);

  if (!prev) {
    healthStates.set(agent.id, {
      lastOutputHash: currentHash,
      hashSince: now,
      lastWarningAt: 0,
      status: 'healthy',
      message: '',
    });
    return;
  }

  let newStatus: AgentHealthState['status'] = 'healthy';
  let message = '';

  // Crash detection: pane shows shell prompt instead of copilot
  if ((agent.status === 'running' || agent.status === 'idle') && looksLikeShellPrompt(output)) {
    newStatus = 'crashed';
    message = `Agent ${agent.name} appears crashed — pane shows shell prompt`;
  }
  // Hung detection: same output hash for 10+ minutes while running
  else if (agent.status === 'running') {
    if (currentHash === prev.lastOutputHash) {
      const staleMs = now - prev.hashSince;
      if (staleMs >= HUNG_THRESHOLD_MS) {
        newStatus = 'hung';
        message = `Agent ${agent.name} may be hung — output unchanged for ${Math.round(staleMs / 60000)} min`;
      }
    } else {
      prev.hashSince = now;
    }
  }

  // Emit event on status change or after cooldown
  if (newStatus !== 'healthy' &&
      (newStatus !== prev.status || now - prev.lastWarningAt > WARNING_COOLDOWN_MS)) {
    pushEvent('health_warning', message, 'warn', agent.name);
    prev.lastWarningAt = now;
  }

  const outputChanged = currentHash !== prev.lastOutputHash;
  prev.lastOutputHash = currentHash;
  prev.status = newStatus;
  prev.message = message;
  healthStates.set(agent.id, prev);

  recordHealthSnapshot(
    agent.id,
    agent.status,
    agent.pane.target,
    outputChanged ? new Date().toISOString() : null,
  );
}

function runHealthCheck(): void {
  try {
    const agents = getAllAgents();
    for (const agent of agents) {
      if (agent.status === 'running' || agent.status === 'idle') {
        checkAgent(agent);
      } else {
        healthStates.delete(agent.id);
      }
    }
  } catch (err) {
    console.error('Health monitor error:', err);
  }
}

export function startHealthMonitor(): void {
  if (monitorInterval) return;
  console.log('🏥 Health monitor started (30s interval)');
  monitorInterval = setInterval(runHealthCheck, 30_000);
  setTimeout(runHealthCheck, 5_000);
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function getHealthStatus(): Record<string, { status: string; message: string }> {
  const result: Record<string, { status: string; message: string }> = {};
  for (const [name, state] of healthStates) {
    result[name] = { status: state.status, message: state.message };
  }
  return result;
}
