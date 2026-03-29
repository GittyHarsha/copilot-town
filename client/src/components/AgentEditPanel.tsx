import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import type { AgentData, AgentTemplate } from '../lib/api';
import { fetchModels, type ModelInfo } from '../lib/models';

interface Props {
  agent: AgentData;
  onClose: () => void;
  onSaved?: () => void;
}

const KNOWN_FLAGS = [
  { flag: '--yolo', label: 'YOLO', desc: 'Auto-approve everything' },
  { flag: '--allow-all-tools', label: 'All Tools', desc: 'Skip tool confirmations' },
  { flag: '--allow-all-paths', label: 'All Paths', desc: 'Allow file access everywhere' },
  { flag: '--no-ask-user', label: 'No Ask', desc: 'Never prompt user' },
  { flag: '--experimental', label: 'Experimental', desc: 'Enable experimental features' },
];

export default function AgentEditPanel({ agent, onClose, onSaved }: Props) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [model, setModel] = useState('');
  const [flags, setFlags] = useState<string[]>([]);
  const [customFlags, setCustomFlags] = useState('');
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getAgent(agent.id),
      api.getTemplates(),
      fetchModels(),
    ]).then(([detail, tmpl, mdls]) => {
      const d = detail as any;
      setDescription(d.description || agent.template?.description || '');
      setTemplate(d.template || agent.template?.name || '');
      setModel(d.model || agent.template?.model || '');
      setFlags(d.flags || []);
      if (d.envVars) {
        setEnvVars(Object.entries(d.envVars).map(([key, value]) => ({ key, value: value as string })));
      }
      setTemplates(tmpl);
      setModels(mdls);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [agent.id]);

  const toggleFlag = (flag: string) => {
    setFlags(prev => prev.includes(flag) ? prev.filter(f => f !== flag) : [...prev, flag]);
  };

  const addEnvVar = () => setEnvVars(prev => [...prev, { key: '', value: '' }]);
  const removeEnvVar = (i: number) => setEnvVars(prev => prev.filter((_, idx) => idx !== i));
  const updateEnvVar = (i: number, field: 'key' | 'value', val: string) => {
    setEnvVars(prev => prev.map((v, idx) => idx === i ? { ...v, [field]: val } : v));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const allFlags = [
        ...flags,
        ...customFlags.split(/\s+/).filter(f => f.startsWith('--')),
      ];
      const envObj: Record<string, string> = {};
      for (const { key, value } of envVars) {
        if (key.trim()) envObj[key.trim()] = value;
      }

      await api.updateAgentSettings(agent.id, {
        name: name !== agent.name ? name : undefined,
        description: description || undefined,
        template: template || undefined,
        model: model || undefined,
        flags: allFlags.length > 0 ? allFlags : undefined,
        envVars: Object.keys(envObj).length > 0 ? envObj : undefined,
      });
      onSaved?.();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="bg-bg border border-border rounded-xl p-6 w-[480px] text-center text-fg-2 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-bg border border-border rounded-xl shadow-2xl w-[500px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Edit Agent</h2>
          <button className="text-fg-2 hover:text-fg text-lg leading-none" onClick={onClose}>✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[10px] text-fg-2 uppercase tracking-wider mb-1">Name</label>
            <input className="w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-sm text-fg outline-none focus:border-blue"
              value={name} onChange={e => setName(e.target.value)} />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] text-fg-2 uppercase tracking-wider mb-1">Description</label>
            <textarea className="w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-xs text-fg outline-none focus:border-blue resize-none"
              rows={2} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What this agent does…" />
          </div>

          {/* Template */}
          <div>
            <label className="block text-[10px] text-fg-2 uppercase tracking-wider mb-1">Template</label>
            <select className="w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-sm text-fg outline-none focus:border-blue"
              value={template} onChange={e => setTemplate(e.target.value)}>
              <option value="">None (vanilla session)</option>
              {templates.map(t => (
                <option key={t.name} value={t.name}>{t.name} — {t.description?.slice(0, 50)}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-[10px] text-fg-2 uppercase tracking-wider mb-1">Model</label>
            <div className="flex items-center gap-2">
              <select className="flex-1 bg-bg-1 border border-border rounded px-3 py-1.5 text-sm text-fg outline-none focus:border-blue"
                value={model} onChange={e => setModel(e.target.value)}>
                <option value="">Default</option>
                {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <input className="w-40 bg-bg-1 border border-border rounded px-3 py-1.5 text-xs text-fg outline-none focus:border-blue"
                placeholder="Custom model…" value={models.some(m => m.value === model) ? '' : model}
                onChange={e => setModel(e.target.value)} />
            </div>
          </div>

          {/* Flags */}
          <div>
            <label className="block text-[10px] text-fg-2 uppercase tracking-wider mb-1">Flags</label>
            <div className="flex flex-wrap gap-1.5">
              {KNOWN_FLAGS.map(({ flag, label, desc }) => (
                <button key={flag}
                  className={`text-[10px] px-2.5 py-1 rounded border transition-colors ${
                    flags.includes(flag)
                      ? 'bg-blue/10 text-blue border-blue/30 font-medium'
                      : 'bg-bg-1 text-fg-2 border-border hover:border-border-1'
                  }`}
                  onClick={() => toggleFlag(flag)} title={desc}>
                  {label}
                </button>
              ))}
            </div>
            <input className="mt-2 w-full bg-bg-1 border border-border rounded px-3 py-1.5 text-xs text-fg outline-none focus:border-blue"
              placeholder="Additional flags (e.g. --effort=high --max-continues=5)"
              value={customFlags} onChange={e => setCustomFlags(e.target.value)} />
          </div>

          {/* Env vars */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] text-fg-2 uppercase tracking-wider">Environment Variables</label>
              <button className="text-[10px] text-blue hover:text-blue/80" onClick={addEnvVar}>+ Add</button>
            </div>
            {envVars.length === 0 && <p className="text-[10px] text-fg-2/50 italic">None configured</p>}
            {envVars.map((v, i) => (
              <div key={i} className="flex items-center gap-1.5 mb-1.5">
                <input className="flex-1 bg-bg-1 border border-border rounded px-2.5 py-1 text-xs text-fg outline-none focus:border-blue font-mono"
                  placeholder="KEY" value={v.key} onChange={e => updateEnvVar(i, 'key', e.target.value)} />
                <span className="text-fg-2/30">=</span>
                <input className="flex-[2] bg-bg-1 border border-border rounded px-2.5 py-1 text-xs text-fg outline-none focus:border-blue font-mono"
                  placeholder="value" value={v.value} onChange={e => updateEnvVar(i, 'value', e.target.value)} />
                <button className="text-fg-2/40 hover:text-red text-xs" onClick={() => removeEnvVar(i)}>✕</button>
              </div>
            ))}
          </div>

          {/* Session info (read-only) */}
          <div className="bg-bg-1 rounded px-3 py-2 text-[10px] text-fg-2 space-y-0.5">
            <p><span className="text-fg-2/50">Session:</span> <span className="font-mono">{agent.sessionId?.slice(0, 16)}…</span></p>
            <p><span className="text-fg-2/50">Status:</span> <span className={agent.status === 'running' ? 'text-green' : agent.status === 'idle' ? 'text-yellow' : 'text-fg-2'}>{agent.status}</span></p>
            {agent.pane && <p><span className="text-fg-2/50">Pane:</span> <span className="font-mono">{agent.pane.target}</span></p>}
          </div>

          {error && <p className="text-[10px] text-red">⚠ {error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="text-[10px] px-3 py-1.5 rounded text-fg-2 hover:text-fg" onClick={onClose}>Cancel</button>
          <button className="text-[10px] px-4 py-1.5 rounded bg-fg text-bg font-medium hover:opacity-90 disabled:opacity-30"
            onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
