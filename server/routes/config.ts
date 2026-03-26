import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const router = Router();
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CONFIG_FILE = join(HOME, '.copilot', 'copilot-town-config.json');

interface HubConfig {
  port: number;
  defaultSession: string;
  maxPanesPerWindow: number;
  autoOpenBrowser: boolean;
}

const DEFAULT_CONFIG: HubConfig = {
  port: 3848,
  defaultSession: 'town',
  maxPanesPerWindow: 4,
  autoOpenBrowser: false,
};

function readConfig(): HubConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function writeConfig(config: HubConfig): void {
  const dir = dirname(CONFIG_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

router.get('/', (_req, res) => {
  res.json(readConfig());
});

router.put('/', (req, res) => {
  const current = readConfig();
  const updates = req.body as Partial<HubConfig>;

  if (updates.port !== undefined) current.port = Number(updates.port);
  if (updates.defaultSession !== undefined) current.defaultSession = String(updates.defaultSession);
  if (updates.maxPanesPerWindow !== undefined) current.maxPanesPerWindow = Number(updates.maxPanesPerWindow);
  if (updates.autoOpenBrowser !== undefined) current.autoOpenBrowser = Boolean(updates.autoOpenBrowser);

  writeConfig(current);
  res.json(current);
});

export default router;
