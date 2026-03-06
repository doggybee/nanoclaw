import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'MAX_CONTAINERS_PER_GROUP',
  'WARM_POOL_SIZE',
  'CONTAINER_MEMORY',
  'CONTAINER_CPUS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 1000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 50;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10) || 3,
);
export const MAX_CONTAINERS_PER_GROUP = Math.max(
  1,
  parseInt(process.env.MAX_CONTAINERS_PER_GROUP || envConfig.MAX_CONTAINERS_PER_GROUP || '2', 10) || 2,
);
export const WARM_POOL_SIZE = Math.max(
  0,
  parseInt(process.env.WARM_POOL_SIZE || envConfig.WARM_POOL_SIZE || '1', 10) || 0,
);
export const CONTAINER_MEMORY =
  process.env.CONTAINER_MEMORY || envConfig.CONTAINER_MEMORY || '1g';
export const CONTAINER_CPUS =
  process.env.CONTAINER_CPUS || envConfig.CONTAINER_CPUS || '0.5';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Model routing configuration
// MODEL_ROUTER: 'auto' = heuristic-based routing, 'off' = always use CLAUDE_MODEL
// MODEL_FAST: model for simple Q&A (e.g. claude-haiku-4-5-20251001)
// MODEL_FULL: model for complex tasks (defaults to CLAUDE_MODEL)
const routerEnv = readEnvFile(['MODEL_ROUTER', 'MODEL_FAST', 'MODEL_FULL']);
export const MODEL_ROUTER = (process.env.MODEL_ROUTER || routerEnv.MODEL_ROUTER || 'off') as 'auto' | 'off';
export const MODEL_FAST = process.env.MODEL_FAST || routerEnv.MODEL_FAST || '';
export const MODEL_FULL = process.env.MODEL_FULL || routerEnv.MODEL_FULL || '';

// Lark configuration
// LARK_APP_ID and LARK_APP_SECRET are read directly by LarkChannel
// from .env via readEnvFile() to keep secrets off the config module entirely.
