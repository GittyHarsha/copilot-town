// Available Copilot CLI models — fetched dynamically from SDK, with hardcoded fallback
export interface ModelInfo {
  value: string;
  label: string;
  tier: 'premium' | 'standard' | 'fast';
}

// Hardcoded fallback (used until API response arrives)
const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'claude-opus-4.6', label: 'Claude Opus 4.6', tier: 'premium' },
  { value: 'claude-opus-4.5', label: 'Claude Opus 4.5', tier: 'premium' },
  { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', tier: 'standard' },
  { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'standard' },
  { value: 'claude-sonnet-4', label: 'Claude Sonnet 4', tier: 'standard' },
  { value: 'gpt-5.4', label: 'GPT-5.4', tier: 'standard' },
  { value: 'gpt-5.1', label: 'GPT-5.1', tier: 'standard' },
  { value: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', tier: 'fast' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', tier: 'fast' },
  { value: 'gpt-4.1', label: 'GPT-4.1', tier: 'fast' },
];

// Dynamic models from API — populated after first fetch
let _dynamicModels: ModelInfo[] | null = null;
let _fetchPromise: Promise<ModelInfo[]> | null = null;

function classifyTier(model: any): 'premium' | 'standard' | 'fast' {
  if (model.billing?.is_premium) return 'premium';
  const id = (model.id || '').toLowerCase();
  if (id.includes('haiku') || id.includes('mini') || id === 'gpt-4.1') return 'fast';
  return 'standard';
}

export async function fetchModels(): Promise<ModelInfo[]> {
  if (_dynamicModels) return _dynamicModels;
  if (_fetchPromise) return _fetchPromise;

  _fetchPromise = fetch('/api/models')
    .then(r => r.json())
    .then((models: any[]) => {
      _dynamicModels = models.map(m => ({
        value: m.id,
        label: m.name || m.id,
        tier: classifyTier(m),
      }));
      _fetchPromise = null;
      return _dynamicModels;
    })
    .catch(() => {
      _fetchPromise = null;
      _dynamicModels = FALLBACK_MODELS;
      return FALLBACK_MODELS;
    });

  return _fetchPromise;
}

// Synchronous access — returns whatever we have cached, or fallback
export const MODELS: ModelInfo[] = FALLBACK_MODELS;

export function getCachedModels(): ModelInfo[] {
  return _dynamicModels || FALLBACK_MODELS;
}

export const MODEL_IDS = FALLBACK_MODELS.map(m => m.value);

