import { useState, useEffect } from 'react';
import { MODELS as ALL_MODELS } from '../lib/models';

export interface LaunchConfig {
  model: string;
  effort: 'low' | 'medium' | 'high';
  autopilot: boolean;
  maxContinues: number;
  yolo: boolean;
  allowAllTools: boolean;
  allowAllPaths: boolean;
  noCustomInstructions: boolean;
  noAskUser: boolean;
  experimental: boolean;
  pluginDir: string;
  extraFlags: string;
}

const DEFAULT_CONFIG: LaunchConfig = {
  model: '',
  effort: 'high',
  autopilot: false,
  maxContinues: 5,
  yolo: false,
  allowAllTools: false,
  allowAllPaths: false,
  noCustomInstructions: false,
  noAskUser: false,
  experimental: false,
  pluginDir: '',
  extraFlags: '',
};

const MODELS = [
  { value: '', label: 'Default' },
  ...ALL_MODELS,
];

interface Props {
  agentName: string;
  sessionId?: string;
  isResume: boolean;
  onLaunch: (cmd: string, config: LaunchConfig) => void;
  onCancel: () => void;
}

export function LaunchConfigPanel({ agentName, sessionId, isResume, onLaunch, onCancel }: Props) {
  const [config, setConfig] = useState<LaunchConfig>(() => {
    try {
      const saved = localStorage.getItem(`agent-config:${agentName}`);
      if (saved) return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    } catch { /* ignore */ }
    return { ...DEFAULT_CONFIG };
  });
  const [saveDefaults, setSaveDefaults] = useState(true);

  const buildCommand = (cfg: LaunchConfig) => {
    const parts = ['copilot', `--agent=${agentName}`];
    if (isResume && sessionId) parts.push(`--resume=${sessionId}`);
    if (cfg.model) parts.push(`--model=${cfg.model}`);
    if (cfg.effort !== 'high') parts.push(`--effort=${cfg.effort}`);
    if (cfg.autopilot) {
      parts.push('--autopilot');
      if (cfg.maxContinues !== 5) parts.push(`--max-autopilot-continues=${cfg.maxContinues}`);
    }
    if (cfg.yolo) parts.push('--yolo');
    else {
      if (cfg.allowAllTools) parts.push('--allow-all-tools');
      if (cfg.allowAllPaths) parts.push('--allow-all-paths');
    }
    if (cfg.noCustomInstructions) parts.push('--no-custom-instructions');
    if (cfg.noAskUser) parts.push('--no-ask-user');
    if (cfg.experimental) parts.push('--experimental');
    if (cfg.pluginDir) parts.push(`--plugin-dir="${cfg.pluginDir}"`);
    if (cfg.extraFlags) parts.push(cfg.extraFlags);
    return parts.join(' ');
  };

  const command = buildCommand(config);

  const handleLaunch = () => {
    if (saveDefaults) localStorage.setItem(`agent-config:${agentName}`, JSON.stringify(config));
    onLaunch(command, config);
  };

  const set = <K extends keyof LaunchConfig>(key: K, value: LaunchConfig[K]) =>
    setConfig(prev => ({ ...prev, [key]: value }));

  const inputCls = 'w-full bg-bg border border-border rounded px-2.5 py-1.5 text-xs text-fg focus:outline-none focus:border-border-1';
  const checkCls = 'flex items-center gap-2 cursor-pointer text-xs text-fg-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-bg-1 border border-border rounded-lg w-[480px] max-h-[80vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold">{isResume ? 'Resume' : 'Launch'} {agentName}</h2>
            {sessionId && <p className="text-[10px] text-fg-2 font-mono mt-0.5">{sessionId.slice(0, 24)}…</p>}
          </div>
          <button onClick={onCancel} className="text-fg-2 hover:text-fg text-xs">✕</button>
        </div>

        <div className="p-4 space-y-3">
          {/* Model */}
          <div>
            <label className="block text-[11px] text-fg-2 mb-1">Model</label>
            <select className={inputCls} value={config.model} onChange={e => set('model', e.target.value)}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          {/* Effort */}
          <div>
            <label className="block text-[11px] text-fg-2 mb-1">Effort</label>
            <div className="flex gap-1.5">
              {(['low', 'medium', 'high'] as const).map(level => (
                <button key={level}
                  className={`flex-1 px-2 py-1.5 rounded text-xs border transition-colors ${
                    config.effort === level
                      ? 'bg-bg-3 border-border-1 text-fg'
                      : 'bg-bg border-border text-fg-2 hover:text-fg-1'
                  }`}
                  onClick={() => set('effort', level)}>{level}</button>
              ))}
            </div>
          </div>

          {/* Autopilot */}
          <div className="flex items-center gap-3">
            <label className={checkCls}>
              <input type="checkbox" checked={config.autopilot} onChange={e => set('autopilot', e.target.checked)} />
              Autopilot
            </label>
            {config.autopilot && (
              <div className="flex items-center gap-1.5 text-[10px] text-fg-2">
                <span>Max:</span>
                <input type="number" min={1} max={100} value={config.maxContinues}
                  onChange={e => set('maxContinues', parseInt(e.target.value) || 5)}
                  className="w-12 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-center" />
              </div>
            )}
          </div>

          {/* Permissions */}
          <div className="grid grid-cols-2 gap-1.5">
            <label className={checkCls + ' p-2 rounded bg-bg-2 border border-border'}>
              <input type="checkbox" checked={config.yolo} onChange={e => {
                set('yolo', e.target.checked);
                if (e.target.checked) { set('allowAllTools', true); set('allowAllPaths', true); }
              }} /> YOLO
            </label>
            <label className={checkCls + ' p-2 rounded bg-bg-2 border border-border' + (config.yolo ? ' opacity-40' : '')}>
              <input type="checkbox" checked={config.allowAllTools} disabled={config.yolo}
                onChange={e => set('allowAllTools', e.target.checked)} /> All Tools
            </label>
            <label className={checkCls + ' p-2 rounded bg-bg-2 border border-border' + (config.yolo ? ' opacity-40' : '')}>
              <input type="checkbox" checked={config.allowAllPaths} disabled={config.yolo}
                onChange={e => set('allowAllPaths', e.target.checked)} /> All Paths
            </label>
            <label className={checkCls + ' p-2 rounded bg-bg-2 border border-border'}>
              <input type="checkbox" checked={config.noAskUser}
                onChange={e => set('noAskUser', e.target.checked)} /> No Ask User
            </label>
          </div>

          {/* Advanced */}
          <details>
            <summary className="text-[11px] text-fg-2 cursor-pointer hover:text-fg-1">Advanced…</summary>
            <div className="mt-2 space-y-2 pl-3 border-l border-border">
              <label className={checkCls}>
                <input type="checkbox" checked={config.noCustomInstructions}
                  onChange={e => set('noCustomInstructions', e.target.checked)} /> Skip custom instructions
              </label>
              <label className={checkCls}>
                <input type="checkbox" checked={config.experimental}
                  onChange={e => set('experimental', e.target.checked)} /> Experimental
              </label>
              <input type="text" value={config.pluginDir} onChange={e => set('pluginDir', e.target.value)}
                placeholder="Plugin directory" className={inputCls} />
              <input type="text" value={config.extraFlags} onChange={e => set('extraFlags', e.target.value)}
                placeholder="Extra flags" className={inputCls} />
            </div>
          </details>

          {/* Command preview */}
          <pre className="bg-bg rounded border border-border p-2.5 text-[10px] font-mono text-green overflow-x-auto whitespace-pre-wrap break-all">
            {command}
          </pre>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <label className={checkCls + ' text-[10px]'}>
            <input type="checkbox" checked={saveDefaults} onChange={e => setSaveDefaults(e.target.checked)} />
            <span className="text-fg-2">Save defaults</span>
          </label>
          <div className="flex gap-2">
            <button onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded bg-bg border border-border text-fg-2 hover:text-fg transition-colors">Cancel</button>
            <button onClick={handleLaunch}
              className="px-3 py-1.5 text-xs rounded bg-fg text-bg font-medium hover:opacity-90 transition-opacity">
              {isResume ? 'Resume' : 'Launch'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
