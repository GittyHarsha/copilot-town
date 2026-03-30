import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';

/* ─── Types ─────────────────────────────────────────────────────── */
interface WorkflowDef {
  id: string; name: string; description?: string; icon?: string;
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  steps: { id: string; name?: string; needs?: string[]; prompt: string; agent?: { model?: string } }[];
  yaml?: string;
}
interface Iteration {
  attempt: number; output: string; tokens?: number;
  review?: { pass: boolean; feedback: string };
}
interface StepResult {
  id: string; name?: string; status: string; output: string;
  error?: string; startedAt?: string; finishedAt?: string; tokens?: number; agentName?: string;
  iteration?: number; iterations?: Iteration[];
}
interface WorkflowRun {
  runId: string; workflowId: string; workflowName: string;
  status: string; inputs: Record<string, string>; steps: StepResult[];
  startedAt: string; finishedAt?: string; error?: string;
}

/* ─── Helpers ───────────────────────────────────────────────────── */
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-zinc-600', running: 'bg-blue-500 animate-pulse', complete: 'bg-emerald-500',
  failed: 'bg-red-500', skipped: 'bg-zinc-500', cancelled: 'bg-amber-500',
  reviewing: 'bg-purple-500 animate-pulse', waiting: 'bg-amber-500 animate-pulse',
};
const STATUS_ICONS: Record<string, string> = {
  pending: '○', running: '◉', complete: '✓', failed: '✗', skipped: '—', cancelled: '⊘',
  reviewing: '🔍', waiting: '⏸',
};
function elapsed(start: string, end?: string): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedWf, setSelectedWf] = useState<WorkflowDef | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<'list' | 'run-monitor'>('list');
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const wsRef = useRef<WebSocket | null>(null);

  // Load workflows + runs
  const load = useCallback(async () => {
    try {
      const [wfs, rns] = await Promise.all([api.getWorkflows(), api.getWorkflowRuns()]);
      setWorkflows(wfs);
      setRuns(rns);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // WebSocket for live run updates
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/status`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'workflow_run') {
          const run: WorkflowRun = msg.run;
          setRuns(prev => {
            const idx = prev.findIndex(r => r.runId === run.runId);
            if (idx >= 0) { const copy = [...prev]; copy[idx] = run; return copy; }
            return [run, ...prev];
          });
          // Update selected run if viewing it
          setSelectedRun(prev => prev?.runId === run.runId ? run : prev);
        }
      } catch {}
    };
    return () => ws.close();
  }, []);

  // Start a workflow
  const startWorkflow = async () => {
    if (!selectedWf) return;
    setRunning(true);
    try {
      await api.runWorkflow(selectedWf.id, inputs);
      setView('run-monitor');
      // Poll runs to pick up the new run
      setTimeout(async () => {
        const rns = await api.getWorkflowRuns();
        setRuns(rns);
        const latest = rns.find(r => r.workflowId === selectedWf.id);
        if (latest) setSelectedRun(latest);
      }, 1000);
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
    } finally { setRunning(false); }
  };

  // Select a workflow and prep inputs
  const selectWorkflow = (wf: WorkflowDef) => {
    setSelectedWf(wf);
    setExpandedStep(null);
    const defaultInputs: Record<string, string> = {};
    if (wf.inputs) {
      for (const [key, spec] of Object.entries(wf.inputs)) {
        defaultInputs[key] = spec.default || '';
      }
    }
    setInputs(defaultInputs);
  };

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-100">
      {/* Left: Workflow list + Run history */}
      <div className="w-80 border-r border-zinc-800 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">⚡ Workflows</h2>
            <button onClick={load} className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">
              ↻ Reload
            </button>
          </div>
          <p className="text-xs text-zinc-500">Multi-agent pipelines</p>
        </div>

        {/* Workflow definitions */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-3 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Definitions ({workflows.length})
          </div>
          {workflows.map(wf => (
            <button
              key={wf.id}
              onClick={() => { selectWorkflow(wf); setView('list'); setSelectedRun(null); }}
              className={`w-full text-left px-4 py-3 border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors ${
                selectedWf?.id === wf.id && !selectedRun ? 'bg-zinc-800/70 border-l-2 border-l-emerald-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{wf.icon || '📋'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{wf.name}</div>
                  <div className="text-xs text-zinc-500 truncate">{wf.description || `${wf.steps.length} steps`}</div>
                </div>
              </div>
            </button>
          ))}

          {workflows.length === 0 && (
            <div className="px-4 py-8 text-center text-zinc-500 text-sm">
              No workflows found.<br/>
              <span className="text-xs">Add YAML files to data/workflows/</span>
            </div>
          )}

          {/* Run history */}
          {runs.length > 0 && (
            <>
              <div className="px-3 py-2 mt-2 text-xs font-medium text-zinc-500 uppercase tracking-wider border-t border-zinc-800">
                Recent Runs ({runs.length})
              </div>
              {runs.slice(0, 20).map(run => (
                <button
                  key={run.runId}
                  onClick={() => { setSelectedRun(run); setView('run-monitor'); }}
                  className={`w-full text-left px-4 py-2.5 border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors ${
                    selectedRun?.runId === run.runId ? 'bg-zinc-800/70 border-l-2 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[run.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{run.workflowName}</div>
                      <div className="text-xs text-zinc-500">
                        {run.status} · {elapsed(run.startedAt, run.finishedAt)}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="flex-1 overflow-y-auto">
        {!selectedWf && !selectedRun ? (
          <div className="flex items-center justify-center h-full text-zinc-500">
            <div className="text-center">
              <div className="text-5xl mb-4">⚡</div>
              <div className="text-lg font-medium mb-2">Agent Workflows</div>
              <div className="text-sm max-w-md">
                Define multi-agent pipelines in YAML. Each step spawns a headless agent,
                runs a prompt, and passes output to downstream steps.
              </div>
              <div className="mt-4 text-xs text-zinc-600">
                Like GitHub Actions — for AI agents
              </div>
            </div>
          </div>
        ) : selectedRun ? (
          /* ─── Run Monitor ─── */
          <RunMonitor
            run={selectedRun}
            expandedStep={expandedStep}
            setExpandedStep={setExpandedStep}
            onCancel={async () => {
              await api.cancelWorkflowRun(selectedRun.runId);
              load();
            }}
          />
        ) : selectedWf ? (
          /* ─── Workflow Detail + Run Form ─── */
          <div className="p-6 max-w-3xl">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
              <span className="text-3xl">{selectedWf.icon || '📋'}</span>
              <div>
                <h2 className="text-xl font-bold">{selectedWf.name}</h2>
                {selectedWf.description && (
                  <p className="text-sm text-zinc-400">{selectedWf.description}</p>
                )}
              </div>
            </div>

            {/* Pipeline visualization */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wider">Pipeline</h3>
              <div className="flex flex-wrap gap-2 items-center">
                {selectedWf.steps.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                      <div className="text-sm font-medium">{step.name || step.id}</div>
                      {step.agent?.model && (
                        <div className="text-xs text-zinc-500">{step.agent.model}</div>
                      )}
                      {step.needs?.length ? (
                        <div className="text-xs text-zinc-600 mt-1">← {step.needs.join(', ')}</div>
                      ) : null}
                    </div>
                    {i < selectedWf.steps.length - 1 && (
                      <span className="text-zinc-600">→</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Input form */}
            {selectedWf.inputs && Object.keys(selectedWf.inputs).length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wider">Inputs</h3>
                <div className="space-y-3">
                  {Object.entries(selectedWf.inputs).map(([key, spec]) => (
                    <div key={key}>
                      <label className="block text-sm text-zinc-300 mb-1">
                        {key}
                        {spec.required && <span className="text-red-400 ml-1">*</span>}
                        {spec.description && (
                          <span className="text-zinc-500 ml-2 text-xs">— {spec.description}</span>
                        )}
                      </label>
                      <textarea
                        value={inputs[key] || ''}
                        onChange={e => setInputs(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 resize-y min-h-[60px]"
                        placeholder={spec.default || `Enter ${key}...`}
                        rows={3}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run button */}
            <button
              onClick={startWorkflow}
              disabled={running}
              className={`px-6 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                running
                  ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {running ? '⏳ Starting...' : '▶ Run Workflow'}
            </button>

            {/* Recent runs for this workflow */}
            {runs.filter(r => r.workflowId === selectedWf.id).length > 0 && (
              <div className="mt-8">
                <h3 className="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wider">
                  Previous Runs
                </h3>
                <div className="space-y-2">
                  {runs.filter(r => r.workflowId === selectedWf.id).slice(0, 5).map(run => (
                    <button
                      key={run.runId}
                      onClick={() => { setSelectedRun(run); setView('run-monitor'); }}
                      className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 hover:border-zinc-600 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[run.status]}`} />
                          <span className="text-sm">{run.status}</span>
                          <span className="text-xs text-zinc-500">{run.runId}</span>
                        </div>
                        <span className="text-xs text-zinc-500">{elapsed(run.startedAt, run.finishedAt)}</span>
                      </div>
                      <div className="flex gap-1 mt-2">
                        {run.steps.map(s => (
                          <div
                            key={s.id}
                            className={`h-1.5 flex-1 rounded-full ${STATUS_COLORS[s.status]}`}
                            title={`${s.name}: ${s.status}`}
                          />
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ─── Run Monitor Component ─────────────────────────────────────── */
function RunMonitor({
  run, expandedStep, setExpandedStep, onCancel,
}: {
  run: WorkflowRun;
  expandedStep: string | null;
  setExpandedStep: (id: string | null) => void;
  onCancel: () => void;
}) {
  const completedSteps = run.steps.filter(s => s.status === 'complete').length;
  const progress = run.steps.length > 0 ? (completedSteps / run.steps.length) * 100 : 0;

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${STATUS_COLORS[run.status]}`} />
            {run.workflowName}
          </h2>
          <div className="text-sm text-zinc-400 mt-1">
            Run {run.runId} · Started {new Date(run.startedAt).toLocaleTimeString()}
            {run.finishedAt && ` · ${elapsed(run.startedAt, run.finishedAt)}`}
          </div>
        </div>
        {(run.status === 'running' || run.status === 'waiting') && (
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-red-600/20 text-red-400 border border-red-600/30 rounded-lg text-sm hover:bg-red-600/30 transition-colors"
          >
            ■ Cancel
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>{completedSteps}/{run.steps.length} steps</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              run.status === 'failed' ? 'bg-red-500' :
              run.status === 'complete' ? 'bg-emerald-500' : 'bg-blue-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Inputs summary */}
      {Object.keys(run.inputs).length > 0 && (
        <div className="mb-6 bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <div className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wider">Inputs</div>
          {Object.entries(run.inputs).map(([k, v]) => (
            <div key={k} className="text-sm">
              <span className="text-zinc-400">{k}:</span>{' '}
              <span className="text-zinc-300">{v.length > 100 ? v.slice(0, 100) + '...' : v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {run.steps.map((step, i) => (
          <div
            key={step.id}
            className={`bg-zinc-900 border rounded-lg overflow-hidden transition-colors ${
              step.status === 'running' ? 'border-blue-500/50' :
              step.status === 'failed' ? 'border-red-500/30' :
              step.status === 'complete' ? 'border-emerald-500/20' : 'border-zinc-800'
            }`}
          >
            {/* Step header */}
            <button
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-800/50 transition-colors"
            >
              <span className="text-lg font-mono">{STATUS_ICONS[step.status] || '○'}</span>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="text-zinc-500 mr-1">#{i + 1}</span>
                  {step.name || step.id}
                  {(step.iteration || 0) > 1 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30">
                      attempt {step.iteration}/{(step.iterations?.length || step.iteration || 1)}
                    </span>
                  )}
                  {step.status === 'reviewing' && (
                    <span className="text-[10px] text-purple-400 animate-pulse">reviewing...</span>
                  )}
                </div>
                {step.startedAt && (
                  <div className="text-xs text-zinc-500">
                    {elapsed(step.startedAt, step.finishedAt)}
                    {step.tokens ? ` · ${step.tokens} tokens` : ''}
                    {step.error ? ` · Error: ${step.error}` : ''}
                  </div>
                )}
              </div>
              <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[step.status] || 'bg-zinc-600'} text-white`}>
                {step.status}
              </span>
              <span className="text-zinc-500 text-sm">{expandedStep === step.id ? '▾' : '▸'}</span>
            </button>

            {/* Step detail */}
            {expandedStep === step.id && (
              <div className="border-t border-zinc-800 px-4 py-3">
                {/* Gate approval UI */}
                {step.status === 'waiting' && (
                  <GateApproval runId={run.runId} stepId={step.id} message={step.output} />
                )}

                {/* Iteration history (if multiple attempts) */}
                {(step.iterations?.length || 0) > 1 && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-zinc-500 mb-2 uppercase tracking-wider">
                      Iterations ({step.iterations!.length})
                    </div>
                    <div className="space-y-2">
                      {step.iterations!.map((iter, idx) => (
                        <div key={idx} className={`rounded-lg border p-3 text-sm ${
                          idx === step.iterations!.length - 1
                            ? 'border-zinc-700 bg-zinc-800/50'
                            : 'border-zinc-800/50 bg-zinc-900/50'
                        }`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-zinc-400">Attempt {iter.attempt}</span>
                            <div className="flex items-center gap-2">
                              {iter.tokens && <span className="text-[10px] text-zinc-600">{iter.tokens} tok</span>}
                              {iter.review && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  iter.review.pass
                                    ? 'bg-emerald-500/20 text-emerald-300'
                                    : 'bg-red-500/20 text-red-300'
                                }`}>
                                  {iter.review.pass ? '✓ passed' : '✗ needs revision'}
                                </span>
                              )}
                            </div>
                          </div>
                          {iter.review?.feedback && (
                            <div className={`text-xs mt-1 px-2 py-1 rounded ${
                              iter.review.pass ? 'bg-emerald-500/10 text-emerald-300/80' : 'bg-red-500/10 text-red-300/80'
                            }`}>
                              💬 {iter.review.feedback}
                            </div>
                          )}
                          {idx < step.iterations!.length - 1 && (
                            <details className="mt-1">
                              <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400">
                                Show output ({iter.output.length} chars)
                              </summary>
                              <pre className="text-xs text-zinc-500 whitespace-pre-wrap font-mono mt-1 max-h-32 overflow-y-auto">
                                {iter.output}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Current/final output */}
                {step.output && step.status !== 'waiting' ? (
                  <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                    {step.output}
                  </pre>
                ) : step.status === 'running' ? (
                  <div className="text-sm text-zinc-500 animate-pulse">Processing...</div>
                ) : step.status === 'reviewing' ? (
                  <div className="text-sm text-purple-400 animate-pulse">🔍 Reviewing output against criteria...</div>
                ) : step.status !== 'waiting' && (
                  <div className="text-sm text-zinc-600">No output</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      {run.error && (
        <div className="mt-4 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <div className="text-sm text-red-400 font-medium">Error</div>
          <div className="text-sm text-red-300 mt-1">{run.error}</div>
        </div>
      )}
    </div>
  );
}

/* ─── Gate Approval Component ───────────────────────────────────── */
function GateApproval({ runId, stepId, message }: { runId: string; stepId: string; message: string }) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleGate = async (approved: boolean) => {
    setSubmitting(true);
    try {
      await api.resolveWorkflowGate(runId, stepId, approved, feedback || undefined);
    } catch (e: any) {
      alert(`Gate resolution failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-400 text-lg">⏸</span>
        <span className="text-sm font-medium text-amber-300">Waiting for approval</span>
      </div>
      {message && (
        <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono mb-3 max-h-48 overflow-y-auto bg-zinc-900/50 rounded p-2">
          {message}
        </pre>
      )}
      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="Optional feedback..."
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 resize-y mb-3"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          onClick={() => handleGate(true)}
          disabled={submitting}
          className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          ✓ Approve
        </button>
        <button
          onClick={() => handleGate(false)}
          disabled={submitting}
          className="px-4 py-1.5 bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30 text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
