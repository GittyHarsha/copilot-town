import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type AgentData } from '../lib/api';
import ConfirmDialog from '../components/ConfirmDialog';

interface Config {
  port: number;
  defaultSession: string;
  maxPanesPerWindow: number;
  autoOpenBrowser: boolean;
}

// ── Inline editable text ──────────────────────────────────────────
function InlineEdit({ value, onSave, placeholder, multiline }: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };

  if (!editing) {
    return (
      <span
        className="cursor-pointer hover:text-blue px-1 py-0.5 rounded border border-transparent hover:border-border transition-colors"
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {value || <span className="text-fg-2 italic">{placeholder || 'click to set'}</span>}
      </span>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        className="bg-bg-2 border border-border px-2.5 py-1.5 text-xs text-fg w-full resize-y min-h-[48px]"
        style={{ borderRadius: 'var(--shape-md)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        placeholder={placeholder}
      />
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className="bg-bg-2 border border-border px-2.5 py-1.5 text-xs text-fg w-full max-w-[200px]"
      style={{ borderRadius: 'var(--shape-sm)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setDraft(value); setEditing(false); }
      }}
      placeholder={placeholder}
    />
  );
}

// ── General section ───────────────────────────────────────────────
function GeneralSection({ config, setConfig }: { config: Config; setConfig: (c: Config) => void }) {
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestConfig = useRef(config);
  latestConfig.current = config;

  // Debounced auto-save: persists 400ms after last change
  const debouncedSave = useCallback((updates: Partial<Config>) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await api.updateConfig(updates);
        setConfig(updated);
      } catch { /* ignore */ }
      setSaving(false);
    }, 400);
  }, [setConfig]);

  // Flush pending save on unmount / page unload
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        // Fire-and-forget save with latest config
        api.updateConfig(latestConfig.current).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      flush();
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  return (
    <section className="space-y-3" style={{ background: 'var(--color-bg-1)', borderRadius: 'var(--shape-lg)', padding: '20px 24px', border: '1px solid var(--color-border)', boxShadow: 'var(--card-shadow)' }}>
      <h2 className="text-xs font-semibold text-fg-1 uppercase tracking-wider" style={{ fontSize: '0.9rem', fontWeight: 600, borderBottom: '1px solid var(--color-border)', paddingBottom: 8, marginBottom: 16 }}>General</h2>
      {saving && <span className="text-[10px] text-blue animate-pulse">Saving…</span>}
      <div className="grid grid-cols-[180px_1fr] gap-y-2.5 gap-x-4 items-center text-xs">
        <label className="text-fg-2">Hub Port</label>
        <input
          type="number"
          className="bg-bg-2 border border-border px-2.5 py-1.5 text-xs text-fg w-24"
          style={{ borderRadius: 'var(--shape-sm)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
          value={config.port}
          onChange={e => {
            const v = parseInt(e.target.value) || 3848;
            setConfig({ ...config, port: v });
            debouncedSave({ port: v });
          }}
        />

        <label className="text-fg-2">Default psmux session</label>
        <input
          type="text"
          className="bg-bg-2 border border-border px-2.5 py-1.5 text-xs text-fg w-40"
          style={{ borderRadius: 'var(--shape-sm)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
          value={config.defaultSession}
          onChange={e => {
            setConfig({ ...config, defaultSession: e.target.value });
            debouncedSave({ defaultSession: e.target.value });
          }}
        />

        <label className="text-fg-2">Max panes per window</label>
        <input
          type="number"
          className="bg-bg-2 border border-border px-2.5 py-1.5 text-xs text-fg w-24"
          style={{ borderRadius: 'var(--shape-sm)', transition: 'border-color var(--duration-short) var(--ease-standard)' }}
          min={1}
          max={16}
          value={config.maxPanesPerWindow}
          onChange={e => {
            const v = parseInt(e.target.value) || 4;
            setConfig({ ...config, maxPanesPerWindow: v });
            debouncedSave({ maxPanesPerWindow: v });
          }}
        />

        <label className="text-fg-2">Auto-open browser on start</label>
        <button
          className={`w-[40px] h-[22px] rounded-full relative ${config.autoOpenBrowser ? 'bg-blue' : 'bg-bg-2 border border-border'}`}
          style={{ transition: 'background-color var(--duration-short) var(--ease-standard)' }}
          onClick={() => {
            const next = !config.autoOpenBrowser;
            setConfig({ ...config, autoOpenBrowser: next });
            debouncedSave({ autoOpenBrowser: next });
          }}
          aria-pressed={config.autoOpenBrowser}
          disabled={saving}
        >
          <span
            className={`absolute top-0.5 w-[18px] h-[18px] rounded-full bg-white shadow ${config.autoOpenBrowser ? 'translate-x-5' : 'translate-x-0.5'}`}
            style={{ transition: 'transform var(--duration-short) var(--ease-standard)' }}
          />
        </button>
      </div>
    </section>
  );
}

// ── Sessions section ──────────────────────────────────────────────
function SessionsSection() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmState, setConfirmState] = useState<{action: () => void, title: string, message: string} | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);

  const fetchAgents = useCallback(() => {
    api.getAgents().then(a => { setAgents(a); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleExport = () => {
    const exportData = agents.map(a => ({
      name: a.name,
      description: a.description,
      model: a.model,
      type: a.type,
      flags: a.flags,
      reasoningEffort: a.reasoningEffort,
      agentMode: a.agentMode,
      task: a.task,
    }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `copilot-town-agents-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const imported = JSON.parse(text) as Array<{ name: string; model?: string; [k: string]: any }>;
      if (!Array.isArray(imported)) throw new Error('Invalid format');

      let spawned = 0;
      for (const agent of imported) {
        try {
          await api.spawnAgent({
            name: agent.name,
            model: agent.model,
            headless: true,
            reasoningEffort: agent.reasoningEffort,
          });
          spawned++;
        } catch { /* skip duplicates */ }
      }

      setImportResult(`Spawned ${spawned} of ${imported.length} agents`);
      setTimeout(() => setImportResult(null), 5000);
      fetchAgents();
    } catch (e: any) {
      setImportResult(`Import failed: ${e.message}`);
      setTimeout(() => setImportResult(null), 5000);
    }
  };

  const updateAgent = useCallback(async (id: string, settings: { name?: string; description?: string }) => {
    try {
      const updated = await api.updateAgentSettings(id, settings);
      setAgents(prev => prev.map(a => a.id === id ? { ...a, ...updated } : a));
    } catch { /* ignore */ }
  }, []);

  const deleteAgent = useCallback((id: string) => {
    setConfirmState({
      title: 'Remove Agent',
      message: 'Remove this agent from agent-sessions.json?',
      action: async () => {
        try {
          await api.deleteAgentSettings(id);
          setAgents(prev => prev.filter(a => a.id !== id));
        } catch { /* ignore */ }
      },
    });
  }, []);

  if (loading) {
    const Skeleton = ({ width = '100%', height = 14, style = {} }: { width?: string | number; height?: number; style?: React.CSSProperties }) => (
      <div style={{
        width, height, borderRadius: 6,
        background: 'linear-gradient(90deg, var(--color-bg-2) 25%, var(--color-bg-3) 50%, var(--color-bg-2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        ...style,
      }} />
    );
    return (
      <section className="space-y-3" style={{ background: 'var(--color-bg-1)', borderRadius: 'var(--shape-lg)', padding: '20px 24px', border: '1px solid var(--color-border)', boxShadow: 'var(--card-shadow)' }}>
        <h2 className="text-xs font-semibold text-fg-1 uppercase tracking-wider" style={{ fontSize: '0.9rem', fontWeight: 600, borderBottom: '1px solid var(--color-border)', paddingBottom: 8, marginBottom: 16 }}>Sessions</h2>
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-2 text-fg-2">
                <th className="text-left px-3 py-1.5 font-medium">Name</th>
                <th className="text-left px-3 py-1.5 font-medium">Session ID</th>
                <th className="text-left px-3 py-1.5 font-medium">Status</th>
                <th className="text-left px-3 py-1.5 font-medium">Template</th>
                <th className="text-right px-3 py-1.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2"><Skeleton width="70%" /></td>
                  <td className="px-3 py-2"><Skeleton width="60%" /></td>
                  <td className="px-3 py-2"><Skeleton width="50%" /></td>
                  <td className="px-3 py-2"><Skeleton width="40%" /></td>
                  <td className="px-3 py-2"><Skeleton width={32} style={{ marginLeft: 'auto' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" style={{ background: 'var(--color-bg-1)', borderRadius: 'var(--shape-lg)', padding: '20px 24px', border: '1px solid var(--color-border)', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h2 className="text-xs font-semibold text-fg-1 uppercase tracking-wider" style={{ flex: 1, margin: 0, fontSize: '0.9rem', fontWeight: 600, borderBottom: '1px solid var(--color-border)', paddingBottom: 8, marginBottom: 16 }}>Sessions</h2>
        <button className="btn" onClick={handleExport} title="Export agent configs as JSON">
          📥 Export
        </button>
        <label className="btn" style={{ cursor: 'pointer' }} title="Import agents from JSON">
          📤 Import
          <input
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.[0]) handleImport(e.target.files[0]); e.target.value = ''; }}
          />
        </label>
      </div>
      {importResult && (
        <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: '0.85rem',
          background: importResult.includes('failed') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          color: importResult.includes('failed') ? '#ef4444' : '#22c55e',
          border: `1px solid ${importResult.includes('failed') ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
        }}>
          {importResult}
        </div>
      )}
      {agents.length === 0 ? (
        <p className="text-xs text-fg-2">No agents found in agent-sessions.json</p>
      ) : (
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-2 text-fg-2">
                <th className="text-left px-3 py-1.5 font-medium">Name</th>
                <th className="text-left px-3 py-1.5 font-medium">Session ID</th>
                <th className="text-left px-3 py-1.5 font-medium">Status</th>
                <th className="text-left px-3 py-1.5 font-medium">Template</th>
                <th className="text-right px-3 py-1.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(agent => (
                <tr key={agent.id} className="border-t border-border hover:bg-bg-2/50">
                  <td className="px-3 py-1.5">
                    <InlineEdit
                      value={agent.name}
                      onSave={name => updateAgent(agent.id, { name })}
                      placeholder="unnamed"
                    />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-fg-2" title={agent.sessionId}>
                    {agent.sessionId?.slice(0, 8) || '—'}…
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
                      agent.status === 'running' ? 'bg-green' : agent.status === 'idle' ? 'bg-yellow' : 'bg-fg-2/40'
                    }`} />
                    {agent.status}
                  </td>
                  <td className="px-3 py-1.5 text-fg-2">
                    {agent.template?.name || '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right space-x-2">
                    <button
                      className="text-fg-2 hover:text-fg transition-colors"
                      onClick={() => setExpanded(expanded === agent.id ? null : agent.id)}
                      title="Edit description"
                    >
                      {expanded === agent.id ? '▾' : '▸'}
                    </button>
                    <button
                      className="text-red/70 hover:text-red transition-colors"
                      onClick={() => deleteAgent(agent.id)}
                      title="Delete agent"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {expanded && (() => {
            const agent = agents.find(a => a.id === expanded);
            if (!agent) return null;
            return (
              <div className="px-3 py-2 border-t border-border bg-bg-2/30">
                <label className="text-[10px] text-fg-2 uppercase tracking-wider block mb-1">Description</label>
                <InlineEdit
                  value={agent.description || ''}
                  onSave={description => updateAgent(agent.id, { description })}
                  placeholder="Add a description…"
                  multiline
                />
              </div>
            );
          })()}
        </div>
      )}
      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title || ''}
        message={confirmState?.message || ''}
        variant="danger"
        confirmLabel="Remove"
        onConfirm={() => { confirmState?.action(); setConfirmState(null); }}
        onCancel={() => setConfirmState(null)}
      />
    </section>
  );
}

// ── About section─────────────────────────────────────────────────
function AboutSection() {
  return (
    <section className="space-y-3" style={{ background: 'var(--color-bg-1)', borderRadius: 'var(--shape-lg)', padding: '20px 24px', border: '1px solid var(--color-border)', boxShadow: 'var(--card-shadow)' }}>
      <h2 className="text-xs font-semibold text-fg-1 uppercase tracking-wider" style={{ fontSize: '0.9rem', fontWeight: 600, borderBottom: '1px solid var(--color-border)', paddingBottom: 8, marginBottom: 16 }}>About</h2>
      <div className="text-xs space-y-1.5 text-fg-2">
        <p><span className="text-fg-1 font-medium">Copilot Town</span> — Copilot CLI Plugin</p>
        <p>Version <span className="font-mono text-fg-1">0.1.0</span></p>
        <div className="flex gap-4 pt-1">
          <a href="https://github.com/nicholasgasior/copilot-town" target="_blank" rel="noopener noreferrer"
            className="text-blue hover:underline">GitHub Repo</a>
          <a href="https://github.com/nicholasgasior/copilot-town#readme" target="_blank" rel="noopener noreferrer"
            className="text-blue hover:underline">Documentation</a>
        </div>
      </div>
    </section>
  );
}

// ── Main ──────────────────────────────────────────────────────────
export default function Settings() {
  const [config, setConfig] = useState<Config>({
    port: 3848,
    defaultSession: 'town',
    maxPanesPerWindow: 4,
    autoOpenBrowser: false,
  });

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-sm font-semibold text-fg">Settings</h1>
      <GeneralSection config={config} setConfig={setConfig} />
      <hr className="border-border" />
      <SessionsSection />
      <hr className="border-border" />
      <AboutSection />
    </div>
  );
}
