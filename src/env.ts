import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Results are cached in memory — the .env file is only read once per process.
 */

let envCache: Record<string, string> | null = null;

function loadEnvFile(): Record<string, string> {
  if (envCache) return envCache;

  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    envCache = {};
    return envCache;
  }

  const parsed: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) parsed[key] = value;
  }

  envCache = parsed;
  return envCache;
}

export function readEnvFile(keys: string[]): Record<string, string> {
  const all = loadEnvFile();
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (all[key]) result[key] = all[key];
  }
  return result;
}
