import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { MarkdownContent } from '../components/ChatMarkdown';
import ConfirmDialog from '../components/ConfirmDialog';

/* ─── 1. Types ──────────────────────────────────────────────────── */

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

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/* ─── 2. Helpers ────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-fg-2', running: 'bg-blue-500 animate-pulse', complete: 'bg-emerald-500',
  failed: 'bg-red-500', skipped: 'bg-fg-2', cancelled: 'bg-amber-500',
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

/* ─── 3. Main Workflows Component ───────────────────────────────── */

export default function Workflows() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedWf, setSelectedWf] = useState<WorkflowDef | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<'list' | 'run-monitor' | 'editor'>('list');
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [steerStep, setSteerStep] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Editor state
  const [editorId, setEditorId] = useState('');
  const [editorYaml, setEditorYaml] = useState('');
  const [editorIsNew, setEditorIsNew] = useState(true);
  const [editorSaving, setEditorSaving] = useState(false);

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
    const defaultInputs: Record<string, string> = {};
    if (wf.inputs) {
      for (const [key, spec] of Object.entries(wf.inputs)) {
        defaultInputs[key] = spec.default || '';
      }
    }
    setInputs(defaultInputs);
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
    <div className="flex h-full bg-bg text-fg">
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

          {workflows.length === 0 && (
            <div className="px-4 py-8 text-center text-fg-2 text-sm">
              No workflows found.<br/>
              <span className="text-xs">Add YAML files to data/workflows/</span>
            </div>
          )}

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
          isStageEditor ? (
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
          )
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
          <RunMonitor
            run={selectedRun}
            expandedStep={expandedStep}
            setExpandedStep={setExpandedStep}
            steerStep={steerStep}
            setSteerStep={setSteerStep}
            onCancel={async () => {
              await api.cancelWorkflowRun(selectedRun.runId);
              load();
            }}
          />
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
              <h3 className="text-sm font-medium text-fg-1 mb-3 uppercase tracking-wider">Pipeline</h3>
              <div className="flex flex-wrap gap-2 items-center">
                {selectedWf.steps.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <div className="bg-bg-2 border border-border-1 rounded-lg px-3 py-2">
                      <div className="text-sm font-medium">{step.name || step.id}</div>
                      {step.agent?.model && (
                        <div className="text-xs text-fg-2">{step.agent.model}</div>
                      )}
                      {step.needs?.length ? (
                        <div className="text-xs text-fg-2 mt-1">← {step.needs.join(', ')}</div>
                      ) : null}
                    </div>
                    {i < selectedWf.steps.length - 1 && (
                      <span className="text-fg-2">→</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

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
          className="w-full h-[calc(100vh-240px)] bg-bg-1 border border-border-1 rounded-lg px-4 py-3 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500 resize-none leading-relaxed"
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
          <div className="font-mono text-[12px] overflow-auto p-4 bg-bg-1 rounded-lg border border-border min-h-[300px] h-[calc(100vh-380px)]">
            <MarkdownContent content={'```yaml\n' + props.yaml + '\n```'} />
          </div>
        ) : (
          <textarea
            value={props.yaml}
            onChange={e => props.onYamlChange(e.target.value)}
            className="w-full h-[calc(100vh-380px)] bg-bg-1 border border-border-1 rounded-lg px-4 py-3 text-sm text-fg font-mono focus:outline-none focus:border-emerald-500 resize-none leading-relaxed"
            placeholder="name: My Workflow&#10;steps:&#10;  - id: step1&#10;    prompt: |&#10;      ..."
            spellCheck={false}
          />
        )}
      </div>

      {/* Inline YAML Reference */}
      <details className="mt-3 bg-bg-1 border border-border rounded-lg">
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
type: step | gate        # gate = human approval
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
  run, expandedStep, setExpandedStep, steerStep, setSteerStep, onCancel,
}: {
  run: WorkflowRun;
  expandedStep: string | null;
  setExpandedStep: (id: string | null) => void;
  steerStep: string | null;
  setSteerStep: (id: string | null) => void;
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
          <div className="text-sm text-fg-1 mt-1">
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
        <div className="flex justify-between text-xs text-fg-2 mb-1">
          <span>{completedSteps}/{run.steps.length} steps</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-bg-2 rounded-full overflow-hidden">
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
        <div className="mb-6 bg-bg-1 rounded-lg border border-border p-4">
          <div className="text-xs font-medium text-fg-2 mb-2 uppercase tracking-wider">Inputs</div>
          {Object.entries(run.inputs).map(([k, v]) => (
            <div key={k} className="text-sm">
              <span className="text-fg-1">{k}:</span>{' '}
              <span className="text-fg-1">{v.length > 100 ? v.slice(0, 100) + '...' : v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {run.steps.map((step, i) => {
          const isActive = step.status === 'running' || step.status === 'reviewing';
          return (
            <div
              key={step.id}
              className={`bg-bg-1 border rounded-lg overflow-hidden transition-colors ${
                step.status === 'running' ? 'border-blue-500/50' :
                step.status === 'failed' ? 'border-red-500/30' :
                step.status === 'complete' ? 'border-emerald-500/20' : 'border-border'
              }`}
            >
              {/* Step header */}
              <button
                onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-bg-2/50 transition-colors"
              >
                <span className="text-lg font-mono">{STATUS_ICONS[step.status] || '○'}</span>
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <span className="text-fg-2 mr-1">#{i + 1}</span>
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
                    <div className="text-xs text-fg-2">
                      {elapsed(step.startedAt, step.finishedAt)}
                      {step.tokens ? ` · ${step.tokens} tokens` : ''}
                      {step.error ? ` · Error: ${step.error}` : ''}
                    </div>
                  )}
                </div>
                <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[step.status] || 'bg-fg-2'} text-white`}>
                  {step.status}
                </span>
                <span className="text-fg-2 text-sm">{expandedStep === step.id ? '▾' : '▸'}</span>
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
                    <pre className="text-sm text-fg-1 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                      {step.output}
                    </pre>
                  ) : step.status === 'running' ? (
                    <div className="text-sm text-fg-2 animate-pulse">Processing...</div>
                  ) : step.status === 'reviewing' ? (
                    <div className="text-sm text-purple-400 animate-pulse">🔍 Reviewing output against criteria...</div>
                  ) : step.status !== 'waiting' && (
                    <div className="text-sm text-fg-2">No output</div>
                  )}

                  {/* Live stream for running/reviewing steps */}
                  {isActive && step.agentName && (
                    <LiveStream agentName={step.agentName} isActive={isActive} />
                  )}

                  {/* Connect & Steer button */}
                  {isActive && step.agentName && (
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
                          🔗 Connect
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
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

/* ─── 6. LiveStream Component ───────────────────────────────────── */

function LiveStream({ agentName, isActive }: { agentName: string; isActive: boolean }) {
  const [text, setText] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const textRef = useRef('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !agentName) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/headless?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;
    textRef.current = '';
    setText('');

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          const delta = msg.delta || msg.text || '';
          textRef.current += delta;
          setText(textRef.current);
        } else if (msg.type === 'response') {
          const full = msg.text || msg.response || '';
          textRef.current = full;
          setText(full);
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
  }, [text]);

  if (!text) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-xs text-emerald-400 font-medium">● Live</span>
        <span className="text-[10px] text-fg-2">{agentName}</span>
      </div>
      <div
        ref={containerRef}
        className="bg-bg border border-border rounded-lg p-3 max-h-64 overflow-y-auto"
      >
        <pre className="text-xs text-fg-1 whitespace-pre-wrap font-mono leading-relaxed">
          {text}
        </pre>
      </div>
    </div>
  );
}

/* ─── 7. SteerPanel Component ───────────────────────────────────── */

function SteerPanel({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Connect WebSocket
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/headless?agent=${encodeURIComponent(agentName)}`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'message_delta' || msg.type === 'streaming_delta') {
          const delta = msg.delta || msg.text || '';
          streamRef.current += delta;
          setStreaming(streamRef.current);
        } else if (msg.type === 'response') {
          const full = msg.text || msg.response || streamRef.current;
          if (full) {
            setMessages(prev => [...prev, { role: 'assistant', text: full }]);
          }
          streamRef.current = '';
          setStreaming('');
        }
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [agentName]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  const send = () => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages(prev => [...prev, { role: 'user', text }]);
    wsRef.current.send(JSON.stringify({ prompt: text }));
    streamRef.current = '';
    setStreaming('');
    setInput('');
  };

  return (
    <div className="bg-bg border border-border-1 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-1 border-b border-border">
        <span className="text-xs font-medium text-fg-1 flex items-center gap-1.5">
          🔗 Connected to {agentName}
        </span>
        <button
          onClick={onClose}
          className="text-fg-2 hover:text-fg-1 text-xs transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className={`text-xs ${msg.role === 'user' ? 'text-blue-300' : 'text-fg-1'}`}>
            <span className="font-medium text-[10px] uppercase text-fg-2 mr-1">
              {msg.role === 'user' ? 'you' : 'agent'}:
            </span>
            <span className="whitespace-pre-wrap font-mono">{msg.text}</span>
          </div>
        ))}
        {streaming && (
          <div className="text-xs text-fg-1">
            <span className="font-medium text-[10px] uppercase text-fg-2 mr-1">agent:</span>
            <span className="whitespace-pre-wrap font-mono">{streaming}</span>
            <span className="animate-pulse">▊</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Send a message..."
          className="flex-1 bg-bg-1 border border-border-1 rounded px-2 py-1.5 text-xs text-fg font-mono focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={send}
          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
        >
          Send
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
