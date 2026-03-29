// Available Copilot CLI models — single source of truth
// Run `copilot -p "list available models"` to verify/update
export const MODELS: { value: string; label: string; tier: 'premium' | 'standard' | 'fast' }[] = [
  // Premium
  { value: 'claude-opus-4.6', label: 'Claude Opus 4.6', tier: 'premium' },
  { value: 'claude-opus-4.6-1m', label: 'Claude Opus 4.6 (1M)', tier: 'premium' },
  { value: 'claude-opus-4.5', label: 'Claude Opus 4.5', tier: 'premium' },
  // Standard
  { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', tier: 'standard' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'standard' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4', tier: 'standard' },
  { value: 'gpt-5.4', label: 'GPT-5.4', tier: 'standard' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', tier: 'standard' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', tier: 'standard' },
  { value: 'gpt-5.2', label: 'GPT-5.2', tier: 'standard' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', tier: 'standard' },
  { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', tier: 'standard' },
  { value: 'gpt-5.1', label: 'GPT-5.1', tier: 'standard' },
  // Fast / cheap
  { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', tier: 'fast' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', tier: 'fast' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', tier: 'fast' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast' },
  { value: 'gpt-4.1', label: 'GPT-4.1', tier: 'fast' },
];

export const MODEL_IDS = MODELS.map(m => m.value);
