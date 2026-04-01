import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { MarkdownContent } from '../components/ChatMarkdown';
import { ThinkingBlock, ToolTimeline, type ToolCall, type UsageInfo } from '../components/ChatWidgets';
import HeadlessChatPanel from '../components/HeadlessChatPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import WorkflowDAG from '../components/WorkflowDAG';

/* ─── 1. Types ──────────────────────────────────────────────────── */

interface StepDefReview {
  criteria: string;
  max_iterations?: number;
}

interface WorkflowStepDef {
  id: string; name?: string; needs?: string[]; prompt?: string;
  type?: string;
  agent?: { model?: string };
  review?: StepDefReview;
  http?: { url: string; method?: string };
  shell?: { command: string };
  file_read?: { path: string };
  file_write?: { path: string; content: string };
  workflow?: { id: string };
  foreach?: { items: string; as?: string; step: any };
}

interface WorkflowDef {
  id: string; name: string; description?: string; icon?: string;
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  steps: WorkflowStepDef[];
  yaml?: string;
  schedule?: { cron: string; enabled?: boolean };
  webhook?: { enabled?: boolean; token?: string };
}

interface Artifact {
  name: string;
  path: string;
  size: number;
}

interface Iteration {
  attempt: number; output: string; tokens?: number;
  review?: { pass: boolean; feedback: string };
}

interface StepResult {
  id: string; name?: string; status: string; output: string;
  error?: string; startedAt?: string; finishedAt?: string; tokens?: number; agentName?: string;
  iteration?: number; iterations?: Iteration[];
  review?: { criteria: string; max_iterations?: number };
  artifacts?: Artifact[];
  outputs?: Record<string, any>;
}

interface WorkflowRun {
  runId: string; workflowId: string; workflowName: string;
  status: string; inputs: Record<string, string>; steps: StepResult[];
  startedAt: string; finishedAt?: string; error?: string;
}


/* ─── 2. Helpers ────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-fg-2', running: 'bg-blue-500 animate-pulse', complete: 'bg-emerald-500',
  failed: 'bg-red-500', skipped: 'bg-fg-2', cancelled: 'bg-amber-500',
  reviewing: 'bg-purple-500 animate-pulse', waiting: 'bg-amber-500 animate-pulse',
  rewinding: 'bg-amber-400 animate-pulse', paused: 'bg-yellow-500',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○', running: '◉', complete: '✓', failed: '✗', skipped: '—', cancelled: '⊘',
  reviewing: '🔍', waiting: '⏸', rewinding: '↩', paused: '⏯',
};

function elapsed(start: string, end?: string): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

const DURATION_BAR_COLORS: Record<string, string> = {
  pending: '#71717a', running: '#3b82f6', complete: '#10b981',
  failed: '#ef4444', skipped: '#71717a', cancelled: '#f59e0b',
  reviewing: '#a855f7', waiting: '#f59e0b', rewinding: '#fbbf24',
  paused: '#eab308',
};

const STEP_TYPE_BADGES: Record<string, { icon: string; label: string; color: string }> = {
  http: { icon: '🌐', label: 'HTTP', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20' },
  shell: { icon: '⚙️', label: 'Shell', color: 'bg-orange-500/15 text-orange-400 border-orange-500/20' },
  'file-read': { icon: '📖', label: 'Read', color: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20' },
  'file-write': { icon: '✏️', label: 'Write', color: 'bg-pink-500/15 text-pink-400 border-pink-500/20' },
  workflow: { icon: '🔗', label: 'Sub', color: 'bg-violet-500/15 text-violet-400 border-violet-500/20' },
  foreach: { icon: '🔄', label: 'Loop', color: 'bg-teal-500/15 text-teal-400 border-teal-500/20' },
  gate: { icon: '🚪', label: 'Gate', color: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Module-level cache for LiveStream state — survives component unmount/remount (tab switches) */
interface StreamCache {
  text: string;
  thinking: string;
  tools: ToolCall[];
  intent: string | null;
  usage: UsageInfo | null;
  streaming: boolean;
}
const streamCache = new Map<string, StreamCache>();

/* ─── 3. Main Workflows Component ───────────────────────────────── */

export default function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedWf, setSelectedWf] = useState<WorkflowDef | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [wfLoading, setWfLoading] = useState(true);
  const [view, setView] = useState<'list' | 'run-monitor' | 'editor'>('list');
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [steerStep, setSteerStep] = useState<string | null>(null);
  const [dagView, setDagView] = useState<'dag' | 'list'>('dag');
  const wsRef = useRef<WebSocket | null>(null);

  // Editor state
  const [editorId, setEditorId] = useState('');
  const [editorYaml, setEditorYaml] = useState('');
  const [editorIsNew, setEditorIsNew] = useState(true);
  const [editorSaving, setEditorSaving] = useState(false);

  // Step criteria editing state
  const [editingCriteriaStep, setEditingCriteriaStep] = useState<string | null>(null);
  const [criteriaText, setCriteriaText] = useState('');
  const [criteriaMaxIter, setCriteriaMaxIter] = useState(3);
  const [criteriaSaving, setCriteriaSaving] = useState(false);

  // Stage files state
  const [stageFiles, setStageFiles] = useState<string[]>([]);
  const [editingStageName, setEditingStageName] = useState<string | null>(null);
  const [editingStageContent, setEditingStageContent] = useState('');
  const [editingStageIsNew, setEditingStageIsNew] = useState(false);

  // Confirm dialog state
  const [deleteWfId, setDeleteWfId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{action: () => void, title: string, message: string, variant?: 'danger' | 'default', confirmLabel?: string} | null>(null);

  // Load workflows + runs + stage files
  const load = useCallback(async () => {
    try {
      const [wfs, rns, stages] = await Promise.all([
        api.getWorkflows(),
        api.getWorkflowRuns(),
        api.getStageFiles().catch(() => [] as string[]),
      ]);
      setWorkflows(wfs);
      setRuns(rns);
      setStageFiles(stages);
    } catch {}
    setWfLoading(false);
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
      setTimeout(async () => {
        const rns = await api.getWorkflowRuns();
        setRuns(rns);
        const latest = rns.find(r => r.workflowId === selectedWf.id);
        if (latest) setSelectedRun(latest);
      }, 1000);
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Failed: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    } finally { setRunning(false); }
  };

  // Select a workflow and prep inputs
  const selectWorkflow = (wf: WorkflowDef) => {
    setSelectedWf(wf);
    setExpandedStep(null);
    setSteerStep(null);
    setEditingCriteriaStep(null);
    const defaultInputs: Record<string, string> = {};
    if (wf.inputs) {
      for (const [key, spec] of Object.entries(wf.inputs)) {
        defaultInputs[key] = spec.default || '';
      }
    }
    setInputs(defaultInputs);
  };

  // Save step review criteria by updating the YAML
  const saveStepCriteria = async (stepId: string, criteria: string, maxIterations: number) => {
    if (!selectedWf?.yaml && !selectedWf) return;
    setCriteriaSaving(true);
    try {
      const full = await api.getWorkflow(selectedWf.id);
      let yaml = full.yaml || '';
      // Find the step block and add/update the review field
      const lines = yaml.split('\n');
      const stepIdx = lines.findIndex((l: string) => /^\s+-\s+id:\s*/.test(l) && l.trim().replace(/^-\s+id:\s*/, '').replace(/["']/g, '') === stepId);
      if (stepIdx === -1) throw new Error(`Step "${stepId}" not found in YAML`);
      // Determine indentation of the step
      const stepLine = lines[stepIdx];
      const baseIndent = stepLine.match(/^(\s*)/)?.[1] || '';
      const fieldIndent = baseIndent + '  ';
      // Find extent of this step (next step or end)
      let stepEnd = lines.length;
      for (let j = stepIdx + 1; j < lines.length; j++) {
        if (/^\s+-\s+id:\s*/.test(lines[j])) { stepEnd = j; break; }
      }
      // Remove existing review block within this step
      const reviewIdx = lines.findIndex((l: string, i: number) => i > stepIdx && i < stepEnd && l.trim().startsWith('review:'));
      if (reviewIdx !== -1) {
        let end = reviewIdx + 1;
        const reviewIndent = (lines[reviewIdx].match(/^(\s*)/)?.[1] || '').length;
        while (end < stepEnd && lines[end].match(/^(\s*)/)?.[1]?.length! > reviewIndent) end++;
        lines.splice(reviewIdx, end - reviewIdx);
        stepEnd -= (end - reviewIdx);
      }
      // Insert review block before end of step
      const reviewLines = [
        `${fieldIndent}review:`,
        `${fieldIndent}  criteria: "${criteria.replace(/"/g, '\\"')}"`,
        `${fieldIndent}  max_iterations: ${maxIterations}`,
      ];
      if (!criteria.trim()) {
        // No criteria — skip insertion (effectively removes review)
      } else {
        lines.splice(stepEnd, 0, ...reviewLines);
      }
      const updatedYaml = lines.join('\n');
      await api.createWorkflow(selectedWf.id, updatedYaml);
      await load();
      // Refresh selected workflow
      const updated = (await api.getWorkflows()) as WorkflowDef[];
      const refreshed = updated.find(w => w.id === selectedWf.id);
      if (refreshed) setSelectedWf(refreshed);
      setEditingCriteriaStep(null);
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Failed to save criteria: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    } finally { setCriteriaSaving(false); }
  };

  // Open editor for new workflow
  const openNewWorkflow = () => {
    setEditorId('');
    setEditorYaml('name: My Workflow\ndescription: \"\"\nsteps:\n  - id: step1\n    prompt: |\n      Do something\n');
    setEditorIsNew(true);
    setSelectedWf(null);
    setSelectedRun(null);
    setEditingStageName(null);
    setView('editor');
  };

  // Open editor for existing workflow
  const openEditWorkflow = async (wf: WorkflowDef) => {
    try {
      const full = await api.getWorkflow(wf.id);
      setEditorId(wf.id);
      setEditorYaml(full.yaml || '');
      setEditorIsNew(false);
      setEditingStageName(null);
      setView('editor');
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Failed to load workflow: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    }
  };

  // Save workflow from editor
  const saveWorkflow = async () => {
    if (!editorId.trim()) { setConfirmState({ title: 'Validation', message: 'Workflow ID is required', action: () => {}, confirmLabel: 'OK' }); return; }
    setEditorSaving(true);
    try {
      await api.createWorkflow(editorId.trim(), editorYaml);
      await load();
      setView('list');
      const wf = workflows.find(w => w.id === editorId.trim());
      if (wf) selectWorkflow(wf);
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Save failed: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    } finally { setEditorSaving(false); }
  };

  // Open stage file for editing
  const openStageFile = async (name: string) => {
    try {
      const sf = await api.getStageFile(name);
      setEditingStageName(sf.name);
      setEditingStageContent(sf.content);
      setEditingStageIsNew(false);
      setSelectedWf(null);
      setSelectedRun(null);
      setView('editor');
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Failed to load stage file: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    }
  };

  // Open new stage file
  const openNewStage = () => {
    setEditingStageName('');
    setEditingStageContent('');
    setEditingStageIsNew(true);
    setSelectedWf(null);
    setSelectedRun(null);
    setView('editor');
  };

  // Save stage file
  const saveStageFile = async () => {
    if (!editingStageName?.trim() && editingStageIsNew) { setConfirmState({ title: 'Validation', message: 'Stage file name is required', action: () => {}, confirmLabel: 'OK' }); return; }
    const name = (editingStageName || '').trim();
    setEditorSaving(true);
    try {
      await api.saveStageFile(name.endsWith('.md') ? name : name + '.md', editingStageContent);
      await load();
      setView('list');
    } catch (e: any) {
      setConfirmState({ title: 'Error', message: `Save failed: ${e.message}`, action: () => {}, confirmLabel: 'OK' });
    } finally { setEditorSaving(false); }
  };

  const handleDeleteWorkflow= async (e: React.MouseEvent, wfId: string) => {
    e.stopPropagation();
    setDeleteWfId(wfId);
  };

  const confirmDeleteWorkflow = async () => {
    if (!deleteWfId) return;
    try {
      await api.deleteWorkflow(deleteWfId);
      if (selectedWf?.id === deleteWfId) { setSelectedWf(null); setView('list'); }
      await load();
    } catch (err: any) {
      setConfirmState({ title: 'Error', message: `Delete failed: ${err.message}`, action: () => {}, confirmLabel: 'OK' });
    } finally {
      setDeleteWfId(null);
    }
  };

  const handleDeleteStage = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    setConfirmState({
      title: 'Delete Stage File',
      message: `Delete stage file "${name}"?`,
      variant: 'danger',
      confirmLabel: 'Delete',
      action: async () => {
        try {
          await api.deleteStageFile(name);
          if (editingStageName === name) { setEditingStageName(null); setView('list'); }
          await load();
        } catch (err: any) {
          setConfirmState({ title: 'Error', message: `Delete failed: ${err.message}`, action: () => {}, confirmLabel: 'OK' });
        }
      },
    });
  };

  // Determine if editor is showing a stage file
  const isStageEditor = view === 'editor' && editingStageName !== null;

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="flex bg-bg text-fg -mx-4 md:-mx-8 -mt-6 md:-mt-8 -mb-6 md:-mb-8" style={{ height: 'calc(100vh - 57px)' }}>
      {/* Left: Sidebar */}
      <div className="w-80 border-r border-border flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">⚡ Workflows</h2>
            <div className="flex items-center gap-1">
              <button
                onClick={openNewWorkflow}
                className="text-xs text-fg-1 hover:text-fg px-2 py-1 rounded bg-bg-2 hover:bg-bg-3 transition-colors"
                title="New Workflow"
              >
                + New
              </button>
              <button
                onClick={load}
                className="text-xs text-fg-1 hover:text-fg px-2 py-1 rounded bg-bg-2 hover:bg-bg-3 transition-colors"
              >
                ↻
              </button>
            </div>
          </div>
          <p className="text-xs text-fg-2">Multi-agent pipelines</p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Workflow definitions */}
          <div className="px-3 py-2 text-xs font-medium text-fg-2 uppercase tracking-wider">
            Definitions ({workflows.length})
          </div>
          {workflows.map(wf => (
            <button
              key={wf.id}
              onClick={() => { selectWorkflow(wf); setView('list'); setSelectedRun(null); setEditingStageName(null); }}
              className={`group w-full text-left px-4 py-3 border-b border-border hover:bg-bg-2/50 transition-colors ${
                selectedWf?.id === wf.id && view === 'list' ? 'bg-bg-2/70 border-l-2 border-l-emerald-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{wf.icon || '📋'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{wf.name}</div>
                  <div className="text-xs text-fg-2 truncate">{wf.description || `${wf.steps.length} steps`}</div>
                </div>
                <span
                  role="button"
                  onClick={(e) => handleDeleteWorkflow(e, wf.id)}
                  className="opacity-0 group-hover:opacity-100 text-fg-2 hover:text-red-400 text-xs px-1 transition-opacity"
                  title="Delete workflow"
                >✕</span>
              </div>
            </button>
          ))}

          {wfLoading ? (
            <div className="px-3 py-2 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ width: '60%', height: 12, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                    <div style={{ width: '40%', height: 10, borderRadius: 6, background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : workflows.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--color-fg-2)', textAlign: 'center', gap: '0.75rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⛓</div>
              <div style={{ fontSize: '1.1rem', color: 'var(--color-fg-1)', fontWeight: 500 }}>No workflows defined</div>
              <div style={{ fontSize: '0.85rem', maxWidth: 400, lineHeight: 1.5 }}>Create workflow YAML files in data/workflows/ to define multi-step agent pipelines. Click 'New' to get started.</div>
            </div>
          ) : null}

          {/* Run history */}
          {runs.length > 0 && (
            <>
              <div className="px-3 py-2 mt-2 text-xs font-medium text-fg-2 uppercase tracking-wider border-t border-border">
                Recent Runs ({runs.length})
              </div>
              {runs.slice(0, 20).map(run => (
                <button
                  key={run.runId}
                  onClick={() => { setSelectedRun(run); setView('run-monitor'); setEditingStageName(null); }}
                  className={`w-full text-left px-4 py-2.5 border-b border-border hover:bg-bg-2/50 transition-colors ${
                    selectedRun?.runId === run.runId ? 'bg-bg-2/70 border-l-2 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[run.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{run.workflowName}</div>
                      <div className="text-xs text-fg-2">
                        {run.status} · {elapsed(run.startedAt, run.finishedAt)}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* Stage files */}
          <div className="px-3 py-2 mt-2 text-xs font-medium text-fg-2 uppercase tracking-wider border-t border-border flex items-center justify-between">
            <span>📄 Stages ({stageFiles.length})</span>
            <button
              onClick={openNewStage}
              className="text-[10px] text-fg-2 hover:text-fg-1 px-1.5 py-0.5 rounded bg-bg-2 hover:bg-bg-3 transition-colors"
            >
              + New
            </button>
          </div>
          {stageFiles.map(sf => (
            <button
              key={sf}
              onClick={() => openStageFile(sf)}
              className={`group w-full text-left px-4 py-2 border-b border-border hover:bg-bg-2/50 transition-colors ${
                editingStageName === sf && view === 'editor' ? 'bg-bg-2/70 border-l-2 border-l-amber-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">📄</span>
                <span className="text-sm truncate flex-1">{sf}</span>
                <span
                  role="button"
                  onClick={(e) => handleDeleteStage(e, sf)}
                  className="opacity-0 group-hover:opacity-100 text-fg-2 hover:text-red-400 text-xs px-1 transition-opacity"
                  title="Delete stage file"
                >✕</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="flex-1 overflow-y-auto">
        {view === 'editor' ? (
          <div>
            <button
              onClick={() => { setView('list'); setEditingStageName(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--color-fg-1)', cursor: 'pointer', fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
              aria-label="Back to workflow list"
            >
              ← Back to list
            </button>
          {isStageEditor ? (
            <WorkflowEditor
              mode="stage"
              stageFileName={editingStageName || ''}
              stageContent={editingStageContent}
              stageIsNew={editingStageIsNew}
              onStageNameChange={setEditingStageName}
              onStageContentChange={setEditingStageContent}
              onSaveStage={saveStageFile}
              saving={editorSaving}
              onCancel={() => { setView('list'); setEditingStageName(null); }}
            />
          ) : (
            <WorkflowEditor
              mode="workflow"
              workflowId={editorId}
              yaml={editorYaml}
              isNew={editorIsNew}
              onIdChange={setEditorId}
              onYamlChange={setEditorYaml}
              onSave={saveWorkflow}
              saving={editorSaving}
              onCancel={() => setView('list')}
            />
          )}
          </div>
        ) : !selectedWf && !selectedRun ? (
          <div className="flex items-center justify-center h-full text-fg-2">
            <div className="text-center">
              <div className="text-5xl mb-4">⚡</div>
              <div className="text-lg font-medium mb-2">Agent Workflows</div>
              <div className="text-sm max-w-md">
                Define multi-agent pipelines in YAML. Each step spawns a headless agent,
                runs a prompt, and passes output to downstream steps.
              </div>
              <div className="mt-4 text-xs text-fg-2">
                Like GitHub Actions — for AI agents
              </div>
            </div>
          </div>
        ) : selectedRun ? (
          <div>
            <button
              onClick={() => { setSelectedRun(null); setView('list'); }}
              style={{ background: 'none', border: 'none', color: 'var(--color-fg-1)', cursor: 'pointer', fontSize: '0.85rem', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
              aria-label="Back to workflow list"
            >
              ← Back to list
            </button>
            <RunMonitor
            run={selectedRun}
            expandedStep={expandedStep}
            setExpandedStep={setExpandedStep}
            steerStep={steerStep}
            setSteerStep={setSteerStep}
            dagView={dagView}
            setDagView={setDagView}
            workflowDef={workflows.find(w => w.id === selectedRun.workflowId)}
            onCancel={async () => {
              await api.cancelWorkflowRun(selectedRun.runId);
              load();
            }}
            />
          </div>
        ) : selectedWf ? (
          <div className="p-6 max-w-3xl">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
              <span className="text-3xl">{selectedWf.icon || '📋'}</span>
              <div className="flex-1">
                <h2 className="text-xl font-bold">{selectedWf.name}</h2>
                {selectedWf.description && (
                  <p className="text-sm text-fg-1">{selectedWf.description}</p>
                )}
              </div>
              <button
                onClick={() => openEditWorkflow(selectedWf)}
                className="px-3 py-1.5 text-sm bg-bg-2 hover:bg-bg-3 rounded-lg transition-colors flex items-center gap-1.5"
                title="Edit workflow YAML"
              >
                ✏️ Edit
              </button>
            </div>

            {/* Pipeline visualization */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-fg-1 uppercase tracking-wider">Pipeline</h3>
                <button
                  onClick={() => setDagView(dagView === 'dag' ? 'list' : 'dag')}
                  className="text-[11px] px-2 py-1 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg border border-border/40 transition-colors"
                >
                  {dagView === 'dag' ? '📝 List' : '📊 DAG'}
                </button>
              </div>
              {dagView === 'dag' ? (
                <WorkflowDAG
                  steps={selectedWf.steps}
                  onStepClick={(id) => setExpandedStep(expandedStep === id ? null : id)}
                />
              ) : (
                <div className="space-y-2">
                  {selectedWf.steps.map((step) => (
                    <div key={step.id} className={`bg-bg-2 border rounded-lg px-3 py-2 ${step.review?.criteria ? 'border-emerald-500/20' : 'border-border-1'}`}>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium flex items-center gap-2">
                            {step.name || step.id}
                            {step.type && step.type !== 'step' && STEP_TYPE_BADGES[step.type] && (
                              <span className={`px-1.5 py-0.5 rounded-full text-[10px] border ${STEP_TYPE_BADGES[step.type].color}`}>
                                {STEP_TYPE_BADGES[step.type].icon} {STEP_TYPE_BADGES[step.type].label}
                              </span>
                            )}
                            {step.review?.criteria && (
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                                ✓ criteria
                              </span>
                            )}
                          </div>
                          {step.agent?.model && (
                            <div className="text-xs text-fg-2">{step.agent.model}</div>
                          )}
                          {step.needs?.length ? (
                            <div className="text-xs text-fg-2 mt-1">← {step.needs.join(', ')}</div>
                          ) : null}
                        </div>
                        <button
                          onClick={() => {
                            if (editingCriteriaStep === step.id) {
                              setEditingCriteriaStep(null);
                            } else {
                              setEditingCriteriaStep(step.id);
                              setCriteriaText(step.review?.criteria || '');
                              setCriteriaMaxIter(step.review?.max_iterations || 3);
                            }
                          }}
                          className="text-[11px] text-fg-2 hover:text-fg-1 transition-colors px-1"
                        >
                          {editingCriteriaStep === step.id ? 'Close' : step.review?.criteria ? 'Edit' : '+ Criteria'}
                        </button>
                      </div>
                      {step.review?.criteria && editingCriteriaStep !== step.id && (
                        <div className="text-xs text-fg-2 mt-1.5 font-mono bg-bg-1/60 px-2 py-1 rounded truncate">
                          {step.review.criteria}
                        </div>
                      )}
                      {editingCriteriaStep === step.id && (
                        <div className="mt-2 animate-slide-down">
                          <textarea
                            value={criteriaText}
                            onChange={e => setCriteriaText(e.target.value)}
                            placeholder="Describe what makes this step's output successful..."
                            className="w-full input-m3 px-3 py-2 text-xs text-fg placeholder-fg-2/40 outline-none resize-y transition-colors"
                            style={{ borderRadius: 'var(--shape-md)' }}
                            rows={3}
                          />
                          <div className="flex items-center gap-3 mt-2">
                            <label className="text-[11px] text-fg-2 flex items-center gap-1.5">
                              Max iterations:
                              <input
                                type="number"
                                value={criteriaMaxIter}
                                onChange={e => setCriteriaMaxIter(Math.max(1, Math.min(10, Number(e.target.value))))}
                                min={1} max={10}
                                className="w-12 bg-bg-1 border border-border-1 rounded px-1.5 py-0.5 text-xs text-fg text-center focus:outline-none focus:border-emerald-500"
                              />
                            </label>
                            <div className="flex-1" />
                            <button
                              onClick={() => setEditingCriteriaStep(null)}
                              disabled={criteriaSaving}
                              className="px-3 py-1 text-[11px] text-fg-2 hover:text-fg-1 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => saveStepCriteria(step.id, criteriaText, criteriaMaxIter)}
                              disabled={criteriaSaving}
                              className="px-3 py-1 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
                              style={{ borderRadius: 'var(--shape-full)', background: 'var(--color-accent)' }}
                            >
                              {criteriaSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Schedule & Webhook Config */}
            <div className="mb-6 flex gap-3">
              {selectedWf.schedule?.cron && (
                <div className="flex-1 bg-bg-1 border border-border p-3 rounded-lg">
                  <div className="text-xs font-medium text-fg-2 uppercase tracking-wider mb-1">⏰ Schedule</div>
                  <div className="text-sm font-mono text-fg-1">{selectedWf.schedule.cron}</div>
                  <div className="text-[10px] text-fg-2 mt-1">
                    {selectedWf.schedule.enabled !== false ? '🟢 Active' : '⚪ Disabled'}
                  </div>
                </div>
              )}
              <WebhookConfig workflowId={selectedWf.id} webhook={selectedWf.webhook} />
            </div>

            {/* Analytics */}
            <AnalyticsPanel workflowId={selectedWf.id} />

            {/* Input form */}
            {selectedWf.inputs && Object.keys(selectedWf.inputs).length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-fg-1 mb-3 uppercase tracking-wider">Inputs</h3>
                <div className="space-y-3">
                  {Object.entries(selectedWf.inputs).map(([key, spec]) => (
                    <div key={key}>
                      <label className="block text-sm text-fg-1 mb-1">
                        {key}
                        {spec.required && <span className="text-red-400 ml-1">*</span>}
                        {spec.description && (
                          <span className="text-fg-2 ml-2 text-xs">— {spec.description}</span>
                        )}
                      </label>
                      <textarea
                        value={inputs[key] || ''}
                        onChange={e => setInputs(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full bg-bg-1 border border-border-1 rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-emerald-500 resize-y min-h-[60px]"
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
                  ? 'bg-bg-3 text-fg-1 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {running ? '⏳ Starting...' : '▶ Run Workflow'}
            </button>

            {/* Recent runs for this workflow */}
            {runs.filter(r => r.workflowId === selectedWf.id).length > 0 && (
              <div className="mt-8">
                <h3 className="text-sm font-medium text-fg-1 mb-3 uppercase tracking-wider">
                  Previous Runs
                </h3>
                <div className="space-y-2">
                  {runs.filter(r => r.workflowId === selectedWf.id).slice(0, 5).map(run => (
                    <button
                      key={run.runId}
                      onClick={() => { setSelectedRun(run); setView('run-monitor'); }}
                      className="w-full text-left bg-bg-1 border border-border rounded-lg px-4 py-3 hover:border-border-1 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[run.status]}`} />
                          <span className="text-sm">{run.status}</span>
                          <span className="text-xs text-fg-2">{run.runId}</span>
                        </div>
                        <span className="text-xs text-fg-2">{elapsed(run.startedAt, run.finishedAt)}</span>
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

      <ConfirmDialog
        open={deleteWfId !== null}
        title="Delete Workflow"
        message={`Delete workflow "${deleteWfId}"? This will remove the YAML file from disk.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDeleteWorkflow}
        onCancel={() => setDeleteWfId(null)}
      />
      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        variant={confirmState?.variant || 'default'}
        confirmLabel={confirmState?.confirmLabel || 'OK'}
        onConfirm={() => { confirmState?.action(); setConfirmState(null); }}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

/* ─── 4. WorkflowEditor Component ───────────────────────────────── */

function WorkflowEditor(props:
  | {
      mode: 'workflow';
      workflowId: string; yaml: string; isNew: boolean;
      onIdChange: (id: string) => void; onYamlChange: (yaml: string) => void;
      onSave: () => void; saving: boolean; onCancel: () => void;
    }
  | {
      mode: 'stage';
      stageFileName: string; stageContent: string; stageIsNew: boolean;
      onStageNameChange: (name: string) => void; onStageContentChange: (content: string) => void;
      onSaveStage: () => void; saving: boolean; onCancel: () => void;
    }
) {
  const [previewMode, setPreviewMode] = useState(false);

  if (props.mode === 'stage') {
    return (
      <div className="p-6 max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            📄 {props.stageIsNew ? 'New Stage File' : props.stageFileName}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={props.onCancel}
              className="px-4 py-2 text-sm bg-bg-2 hover:bg-bg-3 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={props.onSaveStage}
              disabled={props.saving}
              className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {props.saving ? '⏳ Saving...' : '💾 Save'}
            </button>
          </div>
        </div>

        {props.stageIsNew && (
          <div className="mb-4">
            <label className="block text-sm text-fg-1 mb-1">File Name</label>
            <input
              type="text"
              value={props.stageFileName || ''}
              onChange={e => props.onStageNameChange(e.target.value)}
              placeholder="my-stage.md"
              className="w-full bg-bg-1 border border-border-1 rounded-lg px-3 py-2 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>
        )}

        <textarea
          value={props.stageContent}
          onChange={e => props.onStageContentChange(e.target.value)}
          className="w-full h-[calc(100vh-240px)] bg-bg-1 border border-border-1 px-4 py-3 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500 focus:shadow-[0_0_0_3px_rgba(16,185,129,0.1)] resize-none leading-relaxed"
          style={{ borderRadius: 'var(--shape-lg)', transition: 'border-color 0.2s, box-shadow 0.2s' }}
          placeholder="# Stage content (Markdown)..."
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold flex items-center gap-2">
          {props.isNew ? '✨ New Workflow' : `✏️ Edit: ${props.workflowId}`}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={props.onCancel}
            className="px-4 py-2 text-sm bg-bg-2 hover:bg-bg-3 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={props.onSave}
            disabled={props.saving}
            className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {props.saving ? '⏳ Saving...' : '💾 Save'}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-sm text-fg-1 mb-1">Workflow ID</label>
        <input
          type="text"
          value={props.workflowId}
          onChange={e => props.onIdChange(e.target.value)}
          readOnly={!props.isNew}
          placeholder="my-workflow"
          className={`w-full bg-bg-1 border border-border-1 rounded-lg px-3 py-2 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500 ${
            !props.isNew ? 'opacity-60 cursor-not-allowed' : ''
          }`}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm text-fg-1">YAML Definition</label>
          <button
            onClick={() => setPreviewMode(!previewMode)}
            className="text-[11px] px-2 py-1 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg border border-border/40"
            aria-pressed={previewMode}
          >
            {previewMode ? '✏️ Edit' : '👁 Preview'}
          </button>
        </div>
        {previewMode ? (
          <div className="font-mono text-[12px] overflow-auto p-4 bg-bg-1 border border-border min-h-[300px] h-[calc(100vh-380px)]" style={{ borderRadius: 'var(--shape-lg)' }}>
            <MarkdownContent content={'```yaml\n' + props.yaml + '\n```'} />
          </div>
        ) : (
          <textarea
            value={props.yaml}
            onChange={e => props.onYamlChange(e.target.value)}
            className="w-full h-[calc(100vh-380px)] bg-bg-1 border border-border-1 px-4 py-3 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500 focus:shadow-[0_0_0_3px_rgba(16,185,129,0.1)] resize-none leading-relaxed"
            style={{ borderRadius: 'var(--shape-lg)', transition: 'border-color 0.2s, box-shadow 0.2s' }}
            placeholder="name: My Workflow&#10;steps:&#10;  - id: step1&#10;    prompt: |&#10;      ..."
            spellCheck={false}
          />
        )}
      </div>

      {/* Inline YAML Reference */}
      <details className="mt-3 bg-bg-1 border border-border" style={{ borderRadius: 'var(--shape-lg)' }}>
        <summary className="px-4 py-2.5 cursor-pointer text-sm text-fg-1 hover:text-fg select-none flex items-center gap-2">
          <span>📖</span> YAML Reference — step fields, expressions, examples
        </summary>
        <div className="px-4 py-3 border-t border-border text-xs text-fg-1 font-mono leading-relaxed max-h-72 overflow-y-auto space-y-3">
          <div>
            <div className="text-fg-1 font-semibold mb-1">Step Fields</div>
            <pre className="text-fg-2 whitespace-pre">{`id: unique-id           # required
name: Display Name       # optional
needs: [step-a, step-b]  # DAG dependencies
prompt: "..."            # agent prompt
prompt_file: stage.md    # load from data/stages/
type: step | gate | http | shell | file-read | file-write | workflow | foreach
timeout: 120             # seconds
session: shared-name     # share agent across steps
target: existing-agent   # run on a pre-existing agent
agent:
  model: claude-sonnet-4
  systemPrompt: "..."
if: "expression"         # conditional execution
outputs: json            # parse JSON from output
retry: 3                 # retry attempts
retry_delay: 5           # seconds between retries
on_fail: fallback-id     # fallback step on failure
continue_on_fail: true   # don't fail workflow
review:
  criteria: "..."        # auto-review criteria
  max_iterations: 3`}</pre>
          </div>
          <div>
            <div className="text-fg-1 font-semibold mb-1">Tool Step Types</div>
            <pre className="text-fg-2 whitespace-pre">{`# HTTP request
type: http
http:
  url: "https://api.example.com/data"
  method: GET              # GET, POST, PUT, DELETE
  headers:
    Authorization: "Bearer ..."
  body: '{"key": "value"}'

# Shell command
type: shell
shell:
  command: "ls -la"
  cwd: "/tmp"              # optional working directory

# Read file contents
type: file-read
file_read:
  path: "path/to/file.txt"

# Write file (creates artifact)
type: file-write
file_write:
  path: "report.txt"
  content: "\${{ steps.X.output }}"

# Sub-workflow
type: workflow
workflow:
  id: other-workflow-id
  inputs:
    param: "\${{ steps.X.output }}"

# Foreach loop
type: foreach
foreach:
  items: "\${{ steps.X.outputs.list }}"
  as: item                 # loop variable name
  max_items: 50
  step:
    id: process-item
    prompt: "Process \${{ inputs.item }}"`}</pre>
          </div>
          <div>
            <div className="text-fg-1 font-semibold mb-1">Variables</div>
            <pre className="text-fg-2 whitespace-pre">{`\${{ inputs.name }}              # input value
\${{ steps.X.output }}           # step output text
\${{ steps.X.status }}           # complete|failed|skipped
\${{ steps.X.error }}            # error message
\${{ steps.X.outputs.key }}      # parsed JSON field`}</pre>
          </div>
          <div>
            <div className="text-fg-1 font-semibold mb-1">Expressions (if:)</div>
            <pre className="text-fg-2 whitespace-pre">{`==  !=  contains  startsWith  >  <
&&  ||  !
Example: "\${{ steps.x.outputs.level }} == 'high' || \${{ inputs.force }} == 'true'"`}</pre>
          </div>
        </div>
      </details>
    </div>
  );
}

/* ─── 5. RunMonitor Component ───────────────────────────────────── */

function RunMonitor({
  run, expandedStep, setExpandedStep, steerStep, setSteerStep, dagView, setDagView, workflowDef, onCancel,
}: {
  run: WorkflowRun;
  expandedStep: string | null;
  setExpandedStep: (id: string | null) => void;
  steerStep: string | null;
  setSteerStep: (id: string | null) => void;
  dagView: 'dag' | 'list';
  setDagView: (v: 'dag' | 'list') => void;
  workflowDef?: WorkflowDef;
  onCancel: () => void;
}) {
  const completedSteps = run.steps.filter(s => s.status === 'complete').length;
  const progress = run.steps.length > 0 ? (completedSteps / run.steps.length) * 100 : 0;
  const [rewindStep, setRewindStep] = useState<string | null>(null);
  const runFinished = run.status === 'complete' || run.status === 'failed';
  const isActive = run.status === 'running' || run.status === 'waiting' || run.status === 'paused';

  // Auto-expand the currently running step so the user always sees activity
  const activeStepId = run.steps.find(s => s.status === 'running' || s.status === 'reviewing')?.id;
  useEffect(() => {
    if (activeStepId && expandedStep !== activeStepId) {
      setExpandedStep(activeStepId);
    }
  }, [activeStepId]);

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${STATUS_COLORS[run.status]}`} />
            {run.workflowName}
          </h2>
          <div className="text-sm text-fg-1 mt-1">
            Run {run.runId} · Started {new Date(run.startedAt).toLocaleTimeString()}
            {run.finishedAt && ` · ${elapsed(run.startedAt, run.finishedAt)}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {run.status === 'running' && (
            <button
              onClick={async () => { await api.pauseWorkflowRun(run.runId); }}
              className="px-4 py-2 bg-yellow-600/20 text-yellow-300 border border-yellow-600/30 rounded-lg text-sm hover:bg-yellow-600/30 transition-colors"
            >
              ⏸ Pause
            </button>
          )}
          {run.status === 'paused' && (
            <button
              onClick={async () => { await api.resumeWorkflowRun(run.runId); }}
              className="px-4 py-2 bg-emerald-600/20 text-emerald-300 border border-emerald-600/30 rounded-lg text-sm hover:bg-emerald-600/30 transition-colors"
            >
              ▶ Resume
            </button>
          )}
          {isActive && (
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-red-600/20 text-red-400 border border-red-600/30 rounded-lg text-sm hover:bg-red-600/30 transition-colors"
            >
              ■ Cancel
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex justify-between text-xs text-fg-2 mb-1">
          <span>{completedSteps}/{run.steps.length} steps</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-bg-2 overflow-hidden" style={{ borderRadius: 'var(--shape-xl)' }}>
          <div
            className={`h-full transition-all duration-500 ${
              run.status === 'failed' ? 'bg-red-500' :
              run.status === 'complete' ? 'bg-emerald-500' :
              run.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500'
            }`}
            style={{ width: `${progress}%`, borderRadius: 'var(--shape-xl)' }}
          />
        </div>
      </div>

      {/* Inputs summary */}
      {Object.keys(run.inputs).length > 0 && (
        <div className="mb-6 bg-bg-1 border border-border p-4" style={{ borderRadius: 'var(--shape-md)' }}>
          <div className="text-xs font-medium text-fg-2 mb-2 uppercase tracking-wider">Inputs</div>
          {Object.entries(run.inputs).map(([k, v]) => (
            <div key={k} className="text-sm">
              <span className="text-fg-1">{k}:</span>{' '}
              <span className="text-fg-1">{v.length > 100 ? v.slice(0, 100) + '...' : v}</span>
            </div>
          ))}
        </div>
      )}

      {/* DAG / List toggle + DAG view */}
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg-1 uppercase tracking-wider">Steps</h3>
        <button
          onClick={() => setDagView(dagView === 'dag' ? 'list' : 'dag')}
          className="text-[11px] px-2 py-1 rounded-lg bg-bg-2/60 text-fg-2 hover:text-fg border border-border/40 transition-colors"
        >
          {dagView === 'dag' ? '📝 List' : '📊 DAG'}
        </button>
      </div>

      {dagView === 'dag' && (
        <div className="mb-6">
          <WorkflowDAG
            steps={workflowDef?.steps ?? run.steps.map(s => ({ id: s.id, name: s.name }))}
            stepResults={run.steps}
            onStepClick={(id) => {
              setExpandedStep(expandedStep === id ? null : id);
              if (dagView === 'dag') setDagView('list');
            }}
          />
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {run.steps.map((step, i) => {
          const isActive = step.status === 'running' || step.status === 'reviewing';
          const isRewinding = step.status === 'rewinding';
          const defStep = workflowDef?.steps.find(s => s.id === step.id);
          const stepType = defStep?.type;
          return (
            <div
              key={step.id}
              className={`bg-bg-1 border overflow-hidden ${
                step.status === 'running' ? 'border-blue-500/50' :
                step.status === 'failed' ? 'border-red-500/30' :
                step.status === 'complete' ? 'border-emerald-500/20' :
                isRewinding ? 'border-amber-400/40' : 'border-border'
              }`}
              style={{ borderRadius: 'var(--shape-md)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
            >
              {/* Step header */}
              <button
                onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                className="w-full px-4 py-3 hover:bg-bg-2/50 transition-colors"
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span className="text-lg font-mono" style={{ flexShrink: 0 }}>{STATUS_ICONS[step.status] || '○'}</span>
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="text-fg-2 mr-1">#{i + 1}</span>
                    {step.name || step.id}
                    {stepType && stepType !== 'step' && STEP_TYPE_BADGES[stepType] && (
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] border ${STEP_TYPE_BADGES[stepType].color}`}>
                        {STEP_TYPE_BADGES[stepType].icon} {STEP_TYPE_BADGES[stepType].label}
                      </span>
                    )}
                    {(step.iteration || 0) > 1 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30">
                        attempt {step.iteration}/{(step.iterations?.length || step.iteration || 1)}
                      </span>
                    )}
                    {step.status === 'reviewing' && (
                      <span className="text-[10px] text-purple-400 animate-pulse">reviewing...</span>
                    )}
                    {isRewinding && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-400/20 text-amber-300 border border-amber-400/30 animate-pulse">
                        ↩ rewinding...
                      </span>
                    )}
                  </div>
                  {step.startedAt && (
                    <div className="text-xs text-fg-2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {step.startedAt && step.finishedAt && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-2)', fontFamily: 'monospace', minWidth: 64 }}>
                          ⏱ {formatDuration(new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime())}
                        </span>
                      )}
                      {step.startedAt && !step.finishedAt && step.status === 'running' && (
                        <span style={{ fontSize: '0.75rem', color: '#3b82f6', fontFamily: 'monospace', minWidth: 64 }}>
                          ⏱ {formatDuration(Date.now() - new Date(step.startedAt).getTime())}
                        </span>
                      )}
                      {step.tokens && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-fg-2)', fontFamily: 'monospace' }}>
                          {step.tokens.toLocaleString()} tok
                        </span>
                      )}
                      {step.error ? ` · Error: ${step.error}` : ''}
                    </div>
                  )}
                </div>
                <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[step.status] || 'bg-fg-2'} text-white`} style={{ flexShrink: 0 }}>
                  {step.status}
                </span>
                <span className="text-fg-2 text-sm" style={{ flexShrink: 0 }}>{expandedStep === step.id ? '▾' : '▸'}</span>
              </button>

              {/* Step detail */}
              {expandedStep === step.id && (
                <div className="border-t border-border px-4 py-3">
                  {/* Gate approval UI */}
                  {step.status === 'waiting' && (
                    <GateApproval runId={run.runId} stepId={step.id} message={step.output} />
                  )}

                  {/* Iteration history */}
                  {(step.iterations?.length || 0) > 1 && (
                    <div className="mb-3">
                      <div className="text-xs font-medium text-fg-2 mb-2 uppercase tracking-wider">
                        Iterations ({step.iterations!.length})
                      </div>
                      <div className="space-y-2">
                        {step.iterations!.map((iter, idx) => (
                          <div key={idx} className={`rounded-lg border p-3 text-sm ${
                            idx === step.iterations!.length - 1
                              ? 'border-border-1 bg-bg-2/50'
                              : 'border-border bg-bg-1/50'
                          }`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-medium text-fg-1">Attempt {iter.attempt}</span>
                              <div className="flex items-center gap-2">
                                {iter.tokens && <span className="text-[10px] text-fg-2">{iter.tokens} tok</span>}
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
                                <summary className="text-[10px] text-fg-2 cursor-pointer hover:text-fg-1">
                                  Show output ({iter.output.length} chars)
                                </summary>
                                <pre className="text-xs text-fg-2 whitespace-pre-wrap font-mono mt-1 max-h-32 overflow-y-auto">
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
                    <div className="text-sm text-fg-1 leading-relaxed max-h-96 overflow-y-auto">
                      <MarkdownContent content={step.output} />
                    </div>
                  ) : step.status === 'running' ? (
                    null /* LiveStream below handles the running state */
                  ) : step.status === 'reviewing' ? (
                    <div className="text-sm text-purple-400 animate-pulse">🔍 Reviewing output against criteria...</div>
                  ) : step.status !== 'waiting' && (
                    <div className="text-sm text-fg-2">No output</div>
                  )}

                  {/* Parsed outputs */}
                  {step.outputs && Object.keys(step.outputs).length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-fg-2 cursor-pointer hover:text-fg-1 uppercase tracking-wider">
                        📊 Parsed Outputs ({Object.keys(step.outputs).length} fields)
                      </summary>
                      <pre className="text-xs text-fg-2 font-mono mt-1 bg-bg-2/50 p-2 rounded max-h-32 overflow-y-auto">
                        {JSON.stringify(step.outputs, null, 2)}
                      </pre>
                    </details>
                  )}

                  {/* Artifacts */}
                  {step.artifacts && step.artifacts.length > 0 && (
                    <div className="mt-3 bg-bg-2/50 border border-border rounded-lg p-3">
                      <div className="text-xs font-medium text-fg-2 mb-2 uppercase tracking-wider flex items-center gap-1.5">
                        📎 Artifacts ({step.artifacts.length})
                      </div>
                      <div className="space-y-1">
                        {step.artifacts.map((art: Artifact) => (
                          <a
                            key={art.name}
                            href={api.getArtifactUrl(run.runId, step.id, art.name)}
                            download={art.name}
                            className="flex items-center gap-2 px-2 py-1.5 bg-bg-1 border border-border rounded hover:border-border-1 transition-colors group"
                          >
                            <span className="text-sm">📄</span>
                            <span className="text-xs text-fg-1 flex-1 truncate font-mono">{art.name}</span>
                            <span className="text-[10px] text-fg-2">{formatBytes(art.size)}</span>
                            <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">⬇ Download</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Success Criteria */}
                  {(() => {
                    const defStep = workflowDef?.steps.find(s => s.id === step.id);
                    const criteria = step.review?.criteria || defStep?.review?.criteria;
                    if (!criteria) return null;
                    const maxIter = step.review?.max_iterations || defStep?.review?.max_iterations || 3;
                    const lastIter = step.iterations?.[step.iterations.length - 1];
                    const passed = lastIter?.review?.pass;
                    return (
                      <div
                        className={`mt-3 border p-3 ${
                          passed === true ? 'bg-emerald-500/5 border-emerald-500/20' :
                          passed === false ? 'bg-red-500/5 border-red-500/20' :
                          'bg-bg-2/50 border-border'
                        }`}
                        style={{ borderRadius: 'var(--shape-md)' }}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-sm">{passed === true ? '✅' : passed === false ? '❌' : '📋'}</span>
                          <span className="text-xs font-medium text-fg-1 uppercase tracking-wider">Success Criteria</span>
                          {step.iteration && (
                            <span className="text-[10px] text-fg-2 ml-auto">
                              Attempt {step.iteration} of {maxIter}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-fg-1 whitespace-pre-wrap font-mono bg-bg-1/60 px-3 py-2 rounded">
                          {criteria}
                        </div>
                        {lastIter?.review?.feedback && (
                          <div className={`mt-2 text-xs px-3 py-1.5 rounded ${
                            lastIter.review.pass
                              ? 'bg-emerald-500/10 text-emerald-300/90'
                              : 'bg-red-500/10 text-red-300/90'
                          }`}>
                            💬 {lastIter.review.feedback}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Live stream for running/reviewing steps */}
                  {isActive && step.agentName && (
                    <LiveStream agentName={step.agentName} isActive={isActive} />
                  )}

                  {/* Connect & Steer — available on active AND completed steps (agents persist post-run) */}
                  {step.agentName && (isActive || step.status === 'complete' || step.status === 'failed') && (
                    <div className="mt-3">
                      {steerStep === step.id ? (
                        <SteerPanel
                          agentName={step.agentName}
                          onClose={() => setSteerStep(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setSteerStep(step.id)}
                          className="px-3 py-1.5 text-xs bg-bg-2 hover:bg-bg-3 border border-border-1 rounded-lg transition-colors"
                        >
                          🔗 {isActive ? 'Connect' : 'Chat with agent'}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Rewind button — only on complete/failed steps when run is finished */}
                  {runFinished && (step.status === 'complete' || step.status === 'failed') && (
                    <div className="mt-3 flex items-center gap-2">
                      {rewindStep === step.id ? (
                        <RewindPanel
                          runId={run.runId}
                          stepId={step.id}
                          onClose={() => setRewindStep(null)}
                        />
                      ) : (
                        <>
                          <button
                            onClick={() => setRewindStep(step.id)}
                            className="px-3 py-1.5 text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors"
                            style={{ borderRadius: 'var(--shape-full)' }}
                          >
                            ↩ Rewind
                          </button>
                          {step.agentName && (
                            <PromoteButton runId={run.runId} stepId={step.id} agentName={step.agentName} />
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Step Duration Bars */}
      {run.steps.some(s => s.startedAt && s.finishedAt) && (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--color-bg-2)', borderRadius: 'var(--shape-md)', border: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-fg-1)', fontWeight: 500, marginBottom: 8 }}>Step Durations</div>
          {run.steps.filter(s => s.startedAt).map(step => {
            const dur = step.finishedAt
              ? new Date(step.finishedAt).getTime() - new Date(step.startedAt!).getTime()
              : Date.now() - new Date(step.startedAt!).getTime();
            const maxDur = Math.max(...run.steps.filter(s => s.startedAt).map(s => {
              const d = s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt!).getTime() : Date.now() - new Date(s.startedAt!).getTime();
              return d;
            }));
            const pct = maxDur > 0 ? (dur / maxDur) * 100 : 0;
            return (
              <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ width: 80, fontSize: '0.7rem', color: 'var(--color-fg-2)', fontFamily: 'monospace', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {step.name || step.id}
                </span>
                <div style={{ flex: 1, height: 14, background: 'var(--color-bg-3)', borderRadius: 'var(--shape-xl)', overflow: 'hidden' }}>
                  <div style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: DURATION_BAR_COLORS[step.status] || '#71717a',
                    borderRadius: 'var(--shape-xl)',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <span style={{ width: 50, fontSize: '0.7rem', color: 'var(--color-fg-2)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {formatDuration(dur)}
                </span>
              </div>
            );
          })}
        </div>
      )}

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

/* ─── 6. LiveStream Component ───────────────────────────────────── */

function LiveStream({ agentName, isActive }: { agentName: string; isActive: boolean }) {
  // Restore from cache on mount (survives tab switches)
  const cached = streamCache.get(agentName);
  const [text, setText] = useState(cached?.text || '');
  const [thinking, setThinking] = useState(cached?.thinking || '');
  const [tools, setTools] = useState<ToolCall[]>(cached?.tools || []);
  const [intent, setIntent] = useState<string | null>(cached?.intent || null);
  const [usage, setUsage] = useState<UsageInfo | null>(cached?.usage || null);
  const [streaming, setStreaming] = useState(cached?.streaming || false);
  const wsRef = useRef<WebSocket | null>(null);
  const textRef = useRef(cached?.text || '');
  const thinkRef = useRef(cached?.thinking || '');
  const toolsRef = useRef<ToolCall[]>(cached?.tools || []);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist to cache whenever state changes
  useEffect(() => {
    streamCache.set(agentName, { text, thinking, tools, intent, usage, streaming });
  }, [agentName, text, thinking, tools, intent, usage, streaming]);

  useEffect(() => {
    if (!isActive || !agentName) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/headless?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    // Don't reset state — keep cached data, append new events

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          textRef.current += msg.content || msg.deltaContent || msg.delta || msg.text || '';
          setText(textRef.current);
          setStreaming(true);
        } else if (msg.type === 'reasoning_delta') {
          thinkRef.current += msg.content || msg.deltaContent || '';
          setThinking(thinkRef.current);
          setStreaming(true);
        } else if (msg.type === 'tool_start') {
          const input = msg.input ? (typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input)) : undefined;
          toolsRef.current = [...toolsRef.current, { tool: msg.tool, status: 'running', timestamp: Date.now(), input }];
          setTools([...toolsRef.current]);
          setStreaming(true);
        } else if (msg.type === 'tool_complete') {
          const output = (msg.output || msg.result) ? (typeof (msg.output || msg.result) === 'string' ? (msg.output || msg.result) : JSON.stringify(msg.output || msg.result)) : undefined;
          toolsRef.current = toolsRef.current.map(t =>
            t.tool === msg.tool && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now(), output } : t
          );
          setTools([...toolsRef.current]);
        } else if (msg.type === 'intent') {
          setIntent(msg.intent || null);
        } else if (msg.type === 'usage') {
          setUsage({ model: msg.model, inputTokens: msg.inputTokens, outputTokens: msg.outputTokens, cost: msg.cost, duration: msg.duration });
        } else if (msg.type === 'subagent_start') {
          toolsRef.current = [...toolsRef.current, { tool: `🤖 ${msg.name || 'subagent'}`, status: 'running', timestamp: Date.now() }];
          setTools([...toolsRef.current]);
        } else if (msg.type === 'subagent_complete') {
          toolsRef.current = toolsRef.current.map(t =>
            t.tool === `🤖 ${msg.name}` && t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: Date.now() } : t
          );
          setTools([...toolsRef.current]);
        } else if (msg.type === 'response' || msg.type === 'turn_end') {
          if (msg.type === 'response') {
            textRef.current = msg.content || msg.text || msg.response || textRef.current;
            setText(textRef.current);
            if (msg.thinking) { thinkRef.current = msg.thinking; setThinking(msg.thinking); }
          }
          toolsRef.current = toolsRef.current.map(t => t.status === 'running' ? { ...t, status: 'done' as const, endTimestamp: t.endTimestamp || Date.now() } : t);
          setTools([...toolsRef.current]);
          setStreaming(false);
        }
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [agentName, isActive]);

  // Auto-scroll
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [text, thinking, tools]);

  const hasContent = text || thinking || tools.length > 0;

  return (
    <div className="mt-3">
      {/* Header with live indicator + intent */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-xs text-emerald-400 font-medium">● Live</span>
        <span className="text-[10px] text-fg-2">{agentName}</span>
        {intent && (
          <span className="text-[10px] text-blue-400/60 truncate max-w-[200px] flex items-center gap-1 ml-auto">
            <span className="w-1 h-1 rounded-full bg-blue-400/50 animate-pulse flex-shrink-0" />
            {intent}
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="bg-bg border border-border rounded-lg p-3 max-h-80 overflow-y-auto space-y-2"
      >
        {/* Thinking block */}
        {thinking && (
          <ThinkingBlock text={thinking} isStreaming={streaming} hasResponse={!!text} />
        )}

        {/* Tool timeline */}
        {tools.length > 0 && <ToolTimeline tools={tools} />}

        {/* Response text */}
        {text && (
          <div className="text-[13px] leading-relaxed text-fg/90">
            <MarkdownContent content={text} />
            {streaming && (
              <span className="inline-block w-[2px] h-4 bg-blue-400/60 ml-0.5 animate-pulse rounded-full align-text-bottom" />
            )}
          </div>
        )}

        {/* Waiting indicator — shows during connect and before content arrives */}
        {!hasContent && (
          <div className="flex items-center gap-2 py-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-fg-2/30 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-[11px] text-fg-2/40">Agent working…</span>
          </div>
        )}

        {/* Usage footer */}
        {usage && !streaming && (
          <div className="flex items-center gap-3 pt-1.5 text-[10px] border-t border-border/30">
            {usage.model && <span className="text-fg-2/30">{usage.model}</span>}
            {usage.outputTokens && <span className="text-fg-2/25 tabular-nums">{usage.outputTokens.toLocaleString()} out</span>}
            {usage.inputTokens && <span className="text-fg-2/25 tabular-nums">{usage.inputTokens.toLocaleString()} in</span>}
            {usage.duration && <span className="text-fg-2/25 tabular-nums">{(usage.duration / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 7. SteerPanel Component ───────────────────────────────────── */

function SteerPanel({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-border" style={{ height: 420 }}>
      <HeadlessChatPanel agentName={agentName} onClose={onClose} embedded />
    </div>
  );
}

/* ─── 7b. RewindPanel Component ────────────────────────────────── */

function RewindPanel({ runId, stepId, onClose }: { runId: string; stepId: string; onClose: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'cascade' | 'single'>('cascade');

  const handleRewind = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'single') {
        await api.rerunSingleStep(runId, stepId, feedback || undefined);
      } else {
        await api.rerunFromStep(runId, stepId, feedback || undefined);
      }
      onClose();
    } catch (e: any) {
      setError(e.message || 'Rewind failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-slide-down bg-amber-500/5 border border-amber-500/20 p-4" style={{ borderRadius: 'var(--shape-md)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-400 text-base">↩</span>
        <span className="text-sm font-medium text-amber-300">Rewind from this step</span>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 mb-3 bg-bg-2 p-0.5 rounded-lg w-fit">
        <button
          onClick={() => setMode('cascade')}
          className={`px-3 py-1 text-[11px] rounded-md transition-colors ${
            mode === 'cascade' ? 'bg-amber-500/20 text-amber-300 font-medium' : 'text-fg-2 hover:text-fg-1'
          }`}
        >
          ↩ Cascade (rerun downstream)
        </button>
        <button
          onClick={() => setMode('single')}
          className={`px-3 py-1 text-[11px] rounded-md transition-colors ${
            mode === 'single' ? 'bg-blue-500/20 text-blue-300 font-medium' : 'text-fg-2 hover:text-fg-1'
          }`}
        >
          ⟳ This step only
        </button>
      </div>

      <p className="text-xs text-fg-2 mb-3">
        {mode === 'cascade'
          ? 'Re-run from this step and all downstream steps. Optionally send corrections.'
          : 'Re-run only this step. Downstream outputs stay unchanged.'}
      </p>
      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="What should the agent do differently?"
        className="w-full input-m3 px-4 py-2.5 text-xs text-fg placeholder-fg-2/40 outline-none resize-y mb-3 transition-colors"
        rows={3}
      />
      {error && (
        <div className="text-xs text-red-400 mb-2">{error}</div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={handleRewind}
          disabled={submitting}
          className="px-4 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
          style={{
            borderRadius: 'var(--shape-full)',
            background: submitting ? 'var(--color-fg-2)' : 'var(--color-accent)',
          }}
        >
          {submitting ? '⏳ Running...' : mode === 'cascade' ? '🔄 Rewind & Re-run' : '⟳ Rerun Step'}
        </button>
        <button
          onClick={onClose}
          disabled={submitting}
          className="px-4 py-1.5 text-xs text-fg-2 hover:text-fg-1 bg-bg-2 border border-border transition-colors disabled:opacity-50"
          style={{ borderRadius: 'var(--shape-full)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─── 8. GateApproval Component ─────────────────────────────────── */

function GateApproval({ runId, stepId, message }: { runId: string; stepId: string; message: string }) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [alertState, setAlertState] = useState<{title: string, message: string} | null>(null);

  const handleGate = async (approved: boolean) => {
    setSubmitting(true);
    try {
      await api.resolveWorkflowGate(runId, stepId, approved, feedback || undefined);
    } catch (e: any) {
      setAlertState({ title: 'Error', message: `Gate resolution failed: ${e.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-400 text-lg">⏸</span>
        <span className="text-sm font-medium text-amber-300">Waiting for approval</span>
      </div>
      {message && (
        <pre className="text-sm text-fg-1 whitespace-pre-wrap font-mono mb-3 max-h-48 overflow-y-auto bg-bg-1/50 rounded p-2">
          {message}
        </pre>
      )}
      <textarea
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="Optional feedback..."
        className="w-full bg-bg-1 border border-border-1 rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-amber-500 resize-y mb-3"
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
    <ConfirmDialog
      open={!!alertState}
      title={alertState?.title || ''}
      message={alertState?.message || ''}
      confirmLabel="OK"
      onConfirm={() => setAlertState(null)}
      onCancel={() => setAlertState(null)}
    />
    </>
  );
}

/* ─── 9. AnalyticsPanel Component ───────────────────────────────── */

function AnalyticsPanel({ workflowId }: { workflowId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getWorkflowAnalytics(workflowId);
      setData(res);
    } catch {}
    setLoading(false);
  }, [workflowId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-6 text-xs text-fg-2 hover:text-fg-1 flex items-center gap-1.5 transition-colors"
      >
        📊 Show Analytics
      </button>
    );
  }

  return (
    <div className="mb-6 bg-bg-1 border border-border p-4 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-fg-1 uppercase tracking-wider flex items-center gap-1.5">
          📊 Analytics
        </h3>
        <button onClick={() => setOpen(false)} className="text-xs text-fg-2 hover:text-fg-1">✕</button>
      </div>
      {loading ? (
        <div className="text-xs text-fg-2 animate-pulse">Loading...</div>
      ) : !data || data.runs === 0 ? (
        <div className="text-xs text-fg-2">No runs yet</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div className="bg-bg-2 p-3 rounded-lg text-center">
              <div className="text-xl font-bold text-fg">{data.runs}</div>
              <div className="text-[10px] text-fg-2 uppercase">Total Runs</div>
            </div>
            <div className="bg-bg-2 p-3 rounded-lg text-center">
              <div className="text-xl font-bold text-emerald-400">{data.successRate}%</div>
              <div className="text-[10px] text-fg-2 uppercase">Success Rate</div>
            </div>
            <div className="bg-bg-2 p-3 rounded-lg text-center">
              <div className="text-xl font-bold text-fg">{data.totalTokens.toLocaleString()}</div>
              <div className="text-[10px] text-fg-2 uppercase">Total Tokens</div>
            </div>
            <div className="bg-bg-2 p-3 rounded-lg text-center">
              <div className="text-xl font-bold text-fg">{formatDuration(data.avgDurationMs)}</div>
              <div className="text-[10px] text-fg-2 uppercase">Avg Duration</div>
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="text-emerald-400">✓ {data.completed} completed</span>
            <span className="text-red-400">✗ {data.failed} failed</span>
          </div>
          {data.recentRuns?.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] text-fg-2 uppercase tracking-wider mb-1">Recent Runs</div>
              <div className="space-y-1">
                {data.recentRuns.slice(0, 5).map((r: any) => (
                  <div key={r.runId} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLORS[r.status]}`} />
                    <span className="text-fg-2 font-mono flex-1 truncate">{r.runId}</span>
                    <span className="text-fg-2">{r.tokens?.toLocaleString() || 0} tok</span>
                    <span className="text-fg-2">{r.finishedAt ? formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── 10. WebhookConfig Component ───────────────────────────────── */

function WebhookConfig({ workflowId, webhook }: { workflowId: string; webhook?: { enabled?: boolean; token?: string } }) {
  const [token, setToken] = useState(webhook?.token || '');
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await api.generateWebhook(workflowId);
      setToken(res.token);
    } catch {}
    setGenerating(false);
  };

  const disable = async () => {
    try {
      await api.disableWebhook(workflowId);
      setToken('');
    } catch {}
  };

  return (
    <div className="flex-1 bg-bg-1 border border-border p-3 rounded-lg">
      <div className="text-xs font-medium text-fg-2 uppercase tracking-wider mb-1">🔗 Webhook</div>
      {token ? (
        <>
          <div className="flex items-center gap-1 mt-1">
            <code className="text-[10px] text-fg-1 bg-bg-2 px-2 py-1 rounded font-mono truncate flex-1">
              /api/workflows/webhook/{token.slice(0, 12)}...
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(`${location.origin}/api/workflows/webhook/${token}`)}
              className="text-[10px] text-fg-2 hover:text-fg-1 px-1"
              title="Copy URL"
            >📋</button>
            <button onClick={disable} className="text-[10px] text-red-400 hover:text-red-300 px-1" title="Disable">✕</button>
          </div>
          <div className="text-[10px] text-emerald-400 mt-1">🟢 Active</div>
        </>
      ) : (
        <button
          onClick={generate}
          disabled={generating}
          className="text-[10px] text-fg-2 hover:text-fg-1 mt-1 transition-colors"
        >
          {generating ? '...' : '+ Generate webhook URL'}
        </button>
      )}
    </div>
  );
}

/* ─── 12. PromoteButton Component ───────────────────────────────── */

function PromoteButton({ runId, stepId, agentName }: { runId: string; stepId: string; agentName: string }) {
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState(false);

  const handlePromote = async () => {
    setPromoting(true);
    try {
      await api.promoteStepAgent(runId, stepId);
      setPromoted(true);
    } catch {}
    setPromoting(false);
  };

  if (promoted) {
    return (
      <span className="px-3 py-1.5 text-xs text-emerald-400 border border-emerald-500/30 bg-emerald-500/10" style={{ borderRadius: 'var(--shape-full)' }}>
        ✓ Promoted
      </span>
    );
  }

  return (
    <button
      onClick={handlePromote}
      disabled={promoting}
      className="px-3 py-1.5 text-xs bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-50"
      style={{ borderRadius: 'var(--shape-full)' }}
      title={`Promote ${agentName} to permanent town agent`}
    >
      {promoting ? '...' : '🏠 Promote Agent'}
    </button>
  );
}
