/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Detect the right bind address for the credential proxy.
 * - macOS / WSL: Docker Desktop routes host.docker.internal to loopback
 * - Bare-metal Linux: bind to docker0 bridge IP
 */
export function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL: Docker Desktop handles routing
  try {
    if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';
  } catch {}

  // Linux: bind to docker0 bridge IP so containers can reach the proxy
  const docker0 = os.networkInterfaces()['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  return '0.0.0.0';
}

/** Docker --add-host args for host.docker.internal on Linux. */
export function hostGatewayArgs(): string[] {
  // macOS/WSL Docker Desktop handles this automatically
  if (os.platform() === 'darwin') return [];
  try {
    if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return [];
  } catch {}
  return ['--add-host', `${CONTAINER_HOST_GATEWAY}:host-gateway`];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name (async, with callback). */
export function stopContainer(
  name: string,
  opts: { timeout?: number } = {},
  cb?: (err: Error | null) => void,
): void {
  execFile(CONTAINER_RUNTIME_BIN, ['stop', name], { timeout: opts.timeout }, (err) => {
    cb?.(err as Error | null);
  });
}

/** Stop a container by name (sync). */
export function stopContainerSync(name: string): void {
  execFileSync(CONTAINER_RUNTIME_BIN, ['stop', name], { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainerSync(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
