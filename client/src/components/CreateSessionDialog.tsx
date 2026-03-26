import { useState, useEffect, useMemo } from 'react';
import { api, type AgentData, type AgentTemplate } from '../lib/api';

const MODELS = [
  { value: '', label: 'Default (copilot default)' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { value: 'claude-opus-4.5', label: 'Claude Opus 4.5' },
  { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { value: 'gpt-5.1', label: 'GPT-5.1' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onLaunched: () => void;
}

export default function CreateSessionDialog({ open, onClose, onLaunched }: Props) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [stoppedAgents, setStoppedAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [template, setTemplate] = useState('');
  const [model, setModel] = useState('');
  const [resumeId, setResumeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [allowAll, setAllowAll] = useState(false);
  const [experimental, setExperimental] = useState(false);
  const [yolo, setYolo] = useState(false);
  const [customFlags, setCustomFlags] = useState('');

  // Fetch templates and stopped agents when dialog opens
  useEffect(() => {
    if (!open) return;
    api.getTemplates().then(setTemplates).catch(() => {});
    api.getAgents().then(agents => {
      setStoppedAgents(agents.filter(a => a.status === 'stopped'));
    }).catch(() => {});
  }, [open]);

  // Reset form on open
  useEffect(() => {
    if (open) {
      setTemplate('');
      setModel('');
      setResumeId('');
      setDisplayName('');
      setAllowAll(false);
      setExperimental(false);
      setYolo(false);
      setCustomFlags('');
      setError('');
    }
  }, [open]);

  const command = useMemo(() => {
    const parts = ['copilot'];
    if (template) parts.push(`--agent=${template}`);
    if (model) parts.push(`--model=${model}`);
    if (resumeId) parts.push(`--resume=${resumeId}`);
    if (yolo) parts.push('--yolo');
    else if (allowAll) parts.push('--allow-all');
    if (experimental) parts.push('--experimental');
    if (customFlags.trim()) parts.push(customFlags.trim());
    return parts.join(' ');
  }, [template, model, resumeId, allowAll, experimental, yolo, customFlags]);

  const handleLaunch = async () => {
    setLoading(true);
    setError('');
    try {
      if (resumeId) {
        // Resume a stopped agent
        const agent = stoppedAgents.find(a => a.sessionId === resumeId || a.id === resumeId);
        const id = agent?.id ?? resumeId;
        await api.resumeAgent(id, undefined, undefined, undefined, command);
      } else if (template) {
        await api.startAgent(template, undefined);
      } else {
        // Vanilla session — start with command override via a generic start
        await api.startAgent('_new', undefined);
      }
      onLaunched();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Launch failed');
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  const inputCls = 'w-full bg-bg border border-border rounded px-2.5 py-1.5 text-[11px] text-fg focus:outline-none focus:border-border-1';
  const labelCls = 'block text-[10px] text-fg-2 mb-1 uppercase tracking-wider';
  const toggleCls = (on: boolean) =>
    `px-2.5 py-1.5 rounded text-[11px] border cursor-pointer transition-colors select-none ${
      on
        ? 'bg-bg-3 border-border-1 text-fg'
        : 'bg-bg border-border text-fg-2 hover:text-fg-1'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-bg-1 border border-border rounded-lg w-[460px] max-h-[85vh] overflow-auto shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-xs font-semibold">New Session</h2>
          <button onClick={onClose} className="text-fg-2 hover:text-fg text-xs">✕</button>
        </div>

        <div className="p-4 space-y-3">
          {/* Template */}
          <div>
            <label className={labelCls}>Template</label>
            <select className={inputCls} value={template} onChange={e => setTemplate(e.target.value)}>
              <option value="">None (vanilla)</option>
              {templates.map(t => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className={labelCls}>Model</label>
            <select className={inputCls} value={model} onChange={e => setModel(e.target.value)}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          {/* Resume Session */}
          <div>
            <label className={labelCls}>Resume Session</label>
            <select className={inputCls} value={resumeId} onChange={e => setResumeId(e.target.value)}>
              <option value="">None (new session)</option>
              {stoppedAgents.map(a => (
                <option key={a.id} value={a.sessionId}>
                  {a.name} — {a.sessionId.slice(0, 12)}…
                </option>
              ))}
            </select>
          </div>

          {/* Display Name */}
          <div>
            <label className={labelCls}>Display Name</label>
            <input type="text" className={inputCls} value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Optional friendly name" />
          </div>

          {/* Flags */}
          <div>
            <label className={labelCls}>Flags</label>
            <div className="flex gap-1.5">
              <button type="button" className={toggleCls(allowAll)}
                onClick={() => setAllowAll(v => !v)}>--allow-all</button>
              <button type="button" className={toggleCls(experimental)}
                onClick={() => setExperimental(v => !v)}>--experimental</button>
              <button type="button" className={toggleCls(yolo)}
                onClick={() => { setYolo(v => !v); }}>--yolo</button>
            </div>
          </div>

          {/* Custom Flags */}
          <div>
            <label className={labelCls}>Custom Flags</label>
            <input type="text" className={inputCls} value={customFlags}
              onChange={e => setCustomFlags(e.target.value)}
              placeholder="e.g. --autopilot --effort=low" />
          </div>

          {/* Preview */}
          <div>
            <label className={labelCls}>Command Preview</label>
            <pre className="bg-bg rounded border border-border p-2.5 text-[10px] font-mono text-green overflow-x-auto whitespace-pre-wrap break-all select-all">
              {command}
            </pre>
          </div>

          {error && (
            <p className="text-[10px] text-red">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <button onClick={onClose}
            className="px-3 py-1.5 text-[11px] rounded bg-bg border border-border text-fg-2 hover:text-fg transition-colors">
            Cancel
          </button>
          <button onClick={handleLaunch} disabled={loading}
            className="px-3 py-1.5 text-[11px] rounded bg-fg text-bg font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
            {loading ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  );
}
