/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_MEMORY,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath, resolveSlotIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';

const PARSE_BUFFER_MAX = 10 * 1024 * 1024; // 10MB — prevent unbounded growth
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// In-memory caches to avoid redundant FS operations across spawns.
// Reset naturally on process restart.
const createdDirs = new Set<string>();
const chownedDirs = new Set<string>();

const CONTAINER_HOME = '/home/node';

// RTK source files (checked once per process)
const rtkSrcDir = path.join(process.cwd(), 'container', 'rtk');
const rtkAvailable = fs.existsSync(rtkSrcDir);

// Pre-compute desired settings.json content (includes RTK hook only if available)
const desiredSettings: Record<string, unknown> = {
  env: {
    // Enable agent swarms (subagent orchestration)
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Load CLAUDE.md from additional mounted directories
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    // Enable Claude's memory feature
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};
if (rtkAvailable) {
  desiredSettings.hooks = {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${CONTAINER_HOME}/.claude/hooks/rtk-rewrite.sh` }],
      },
    ],
  };
}
const DESIRED_SETTINGS_STR = JSON.stringify(desiredSettings, null, 2) + '\n';

/** Recursively chown a directory tree so the container's node user can write.
 *  Skips files/dirs that already have the correct ownership. */
function chownRecursive(dir: string, uid: number, gid: number): void {
  try {
    const stat = fs.statSync(dir);
    if (stat.uid !== uid || stat.gid !== gid) {
      fs.chownSync(dir, uid, gid);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        chownRecursive(full, uid, gid);
      } else {
        const s = fs.statSync(full);
        if (s.uid !== uid || s.gid !== gid) {
          fs.chownSync(full, uid, gid);
        }
      }
    }
  } catch {
    // Best-effort: don't crash if chown fails (e.g. on non-Linux)
  }
}

/** Recursively chmod a directory tree — used when host is non-root so the
 *  container's node user (different uid) can still read/write mounted dirs. */
function chmodRecursive(dir: string, mode: number): void {
  try {
    fs.chmodSync(dir, mode);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        chmodRecursive(full, mode);
      } else {
        fs.chmodSync(full, mode);
      }
    }
  } catch {
    // Best-effort: don't crash
  }
}

/** mkdir with in-memory cache — skips syscall if already created this process. */
function cachedMkdir(dir: string): void {
  if (createdDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.add(dir);
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Override model for this run (from model router). */
  model?: string;
  /** Slot ID for per-user IPC isolation. */
  slotId?: string;
  /** Message ID to reply to (for streaming card reply). */
  replyToMessageId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Container already delivered output to user (via CardKit streaming). Host should NOT re-send. */
  outputDelivered?: boolean;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  slotId?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never stored in containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Global directory (read-only for all) — shared CLAUDE.md + instructions
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });

    // Knowledge subdirectory: writable overlay so all agents can accumulate knowledge.
    // Docker overlays the more specific mount path on top of the read-only parent.
    const knowledgeDir = path.join(globalDir, 'knowledge');
    cachedMkdir(knowledgeDir);
    mounts.push({
      hostPath: knowledgeDir,
      containerPath: '/workspace/global/knowledge',
      readonly: false,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  cachedMkdir(groupSessionsDir);
  // Write settings.json if content differs (uses snapshotCache to avoid disk reads)
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (snapshotCache.get(settingsFile) !== DESIRED_SETTINGS_STR) {
    let needsWrite = true;
    try { needsWrite = fs.readFileSync(settingsFile, 'utf8') !== DESIRED_SETTINGS_STR; } catch { /* missing */ }
    if (needsWrite) fs.writeFileSync(settingsFile, DESIRED_SETTINGS_STR);
    snapshotCache.set(settingsFile, DESIRED_SETTINGS_STR);
  }

  // Sync RTK hook and RTK.md into group's .claude/ directory
  if (rtkAvailable) {
    cachedMkdir(path.join(groupSessionsDir, 'hooks'));
    copyIfNewer(path.join(rtkSrcDir, 'rtk-rewrite.sh'), path.join(groupSessionsDir, 'hooks', 'rtk-rewrite.sh'), { chmod: 0o755 });
    copyIfNewer(path.join(rtkSrcDir, 'RTK.md'), path.join(groupSessionsDir, 'RTK.md'));
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  try {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      if (!fs.existsSync(dstDir)) {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } else {
        for (const file of fs.readdirSync(srcDir)) {
          copyIfNewer(path.join(srcDir, file), path.join(dstDir, file));
        }
      }
    }
  } catch { /* skillsSrc missing, skip */ }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: `${CONTAINER_HOME}/.claude`,
    readonly: false,
  });

  // Per-group QMD cache: persist index + downloaded models across conversations
  const qmdCacheDir = path.join(DATA_DIR, 'sessions', group.folder, '.qmd-cache');
  cachedMkdir(qmdCacheDir);
  mounts.push({
    hostPath: qmdCacheDir,
    containerPath: `${CONTAINER_HOME}/.cache/qmd`,
    readonly: false,
  });

  // Per-slot IPC namespace (read-write): each user slot gets its own IPC directory
  // to prevent concurrent containers from conflicting on input/output files.
  // Secondary read-only mount at /workspace/ipc-group contains shared group-level files.
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const slotIpcDir = slotId
    ? resolveSlotIpcPath(group.folder, slotId)
    : groupIpcDir;
  cachedMkdir(path.join(slotIpcDir, 'messages'));
  cachedMkdir(path.join(slotIpcDir, 'tasks'));
  cachedMkdir(path.join(slotIpcDir, 'input'));
  cachedMkdir(path.join(slotIpcDir, 'responses'));
  mounts.push({
    hostPath: slotIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  // Also mount group-level IPC for shared files (tasks snapshot, groups snapshot)
  // that are written at group level, not per-slot.
  // Mount read-only at a secondary path so container can read but not interfere.
  cachedMkdir(groupIpcDir);
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc-group',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Ensure ALL writable mount directories are accessible to the container's
  // node user (uid 1000).  Root host → chown to 1000; non-root host → chmod
  // world-writable so the different uid inside the container can still write.
  // Cached: only fix on first spawn per mount path to avoid redundant tree walks.
  const isRoot = process.getuid?.() === 0;
  for (const mount of mounts) {
    if (!mount.readonly && !chownedDirs.has(mount.hostPath)) {
      if (isRoot) {
        chownRecursive(mount.hostPath, 1000, 1000);
      } else {
        chmodRecursive(mount.hostPath, 0o777);
      }
      chownedDirs.add(mount.hostPath);
    }
  }

  return mounts;
}

/** Detect auth mode to tell the container which placeholder to use. */
function detectAuthMode(): 'api-key' | 'oauth' {
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  return 'oauth'; // default: OAuth (either from .env or CLI credentials)
}

/** Batch-add `-e KEY=VALUE` args, skipping undefined values. */
function addEnvArgs(args: string[], env: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined) args.push('-e', `${key}=${val}`);
  }
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName, '--memory', CONTAINER_MEMORY, '--cpus', CONTAINER_CPUS];

  // Allow containers to reach the host (for credential proxy)
  args.push(...hostGatewayArgs());

  // Route API traffic through the credential proxy — containers never see real keys
  const proxyUrl = `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`;
  const authMode = detectAuthMode();
  addEnvArgs(args, {
    ANTHROPIC_BASE_URL: proxyUrl,
    ...(authMode === 'api-key' ? { ANTHROPIC_API_KEY: 'placeholder' } : { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' }),
    TZ: TIMEZONE,
  });

  // Pass model override and Lark credentials so container can call Lark API directly
  const env = readEnvFile(['CLAUDE_MODEL', 'LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_DOMAIN']);
  addEnvArgs(args, env);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', `HOME=${CONTAINER_HOME}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/** Manages a resettable timeout that kills a container. */
function createTimeoutManager(
  ms: number,
  group: RegisteredGroup,
  containerName: string,
  container: ChildProcess,
) {
  let timedOut = false;
  const kill = () => {
    timedOut = true;
    logger.error({ group: group.name, containerName }, 'Container timeout, stopping');
    stopContainer(containerName, { timeout: 15000 }, (err) => {
      if (err) container.kill('SIGKILL');
    });
  };
  let timer = setTimeout(kill, ms);
  return {
    get timedOut() { return timedOut; },
    reset() { clearTimeout(timer); timer = setTimeout(kill, ms); },
    clear() { clearTimeout(timer); },
  };
}

/**
 * Warm container handle — returned by spawnWarmContainer().
 * Allows setting the output callback later when the first real message arrives.
 */
export interface WarmContainerHandle {
  containerName: string;
  process: ChildProcess;
  groupFolder: string;
  /** The slot ID used for this container's IPC mount path. */
  slotId?: string;
  /** Set the output callback. Must be called before piping the first message. */
  setOnOutput(cb: (output: ContainerOutput) => Promise<void>): void;
  /** Promise that resolves when the container exits. */
  exited: Promise<ContainerOutput>;
}

/**
 * Spawn a warm (pre-heated) container that waits for its first message via IPC.
 * The container boots Node.js + agent-runner immediately but does NOT start a
 * Claude query until a message is piped into /workspace/ipc/input/.
 */
export async function spawnWarmContainer(
  group: RegisteredGroup,
  chatJid: string,
  isMain: boolean,
  assistantName: string,
  sessionId?: string,
  slotId?: string,
  model?: string,
): Promise<WarmContainerHandle> {
  const groupDir = resolveGroupFolderPath(group.folder);
  cachedMkdir(groupDir);

  const mounts = buildVolumeMounts(group, isMain, slotId);

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-warm-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
  const logsDir = path.join(groupDir, 'logs');
  cachedMkdir(logsDir);

  logger.info({ group: group.name, containerName }, 'Spawning warm container');

  const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Send config with empty prompt (warm mode)
  const warmInput: ContainerInput = {
    prompt: '',
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    assistantName,
    model,
  };
  container.stdin.write(JSON.stringify(warmInput));
  container.stdin.end();

  // Mutable output callback — set when container is activated
  let onOutput: ((output: ContainerOutput) => Promise<void>) | null = null;
  let outputChain = Promise.resolve();
  let parseBuffer = '';
  let newSessionId: string | undefined;
  let hadOutput = false;

  // Timeout management
  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
  const tm = createTimeoutManager(timeoutMs, group, containerName, container);

  container.stdout.on('data', (data) => {
    const chunk = data.toString();
    parseBuffer += chunk;
    if (parseBuffer.length > PARSE_BUFFER_MAX) {
      parseBuffer = parseBuffer.slice(-PARSE_BUFFER_MAX / 2);
    }
    let startIdx: number;
    while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) break;
      const jsonStr = parseBuffer.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
      parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
      try {
        const parsed: ContainerOutput = JSON.parse(jsonStr);
        if (parsed.newSessionId) newSessionId = parsed.newSessionId;
        hadOutput = true;
        tm.reset();
        if (onOutput) {
          outputChain = outputChain.then(() => onOutput!(parsed));
        }
      } catch (err) {
        logger.warn({ group: group.name, error: err }, 'Failed to parse warm container output');
      }
    }
  });

  container.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      // Surface timing/thinking lines at info level for diagnostics
      if (line.includes('[timing]') || line.includes('[thinking]')) {
        logger.info({ container: group.folder }, line);
      } else {
        logger.debug({ container: group.folder }, line);
      }
    }
  });

  const exited = new Promise<ContainerOutput>((resolve) => {
    container.on('close', (code) => {
      tm.clear();
      outputChain.then(() => {
        if (tm.timedOut && hadOutput) {
          resolve({ status: 'success', result: null, newSessionId });
        } else if (tm.timedOut) {
          resolve({ status: 'error', result: null, error: 'Warm container timed out' });
        } else {
          resolve({
            status: code === 0 ? 'success' : 'error',
            result: null,
            newSessionId,
            error: code !== 0 ? `Container exited with code ${code}` : undefined,
          });
        }
      });
    });
    container.on('error', (err) => {
      tm.clear();
      resolve({ status: 'error', result: null, error: err.message });
    });
  });

  return {
    containerName,
    process: container,
    groupFolder: group.folder,
    slotId,
    setOnOutput(cb) { onOutput = cb; },
    exited,
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  warmHandle?: WarmContainerHandle,
): Promise<ContainerOutput> {
  // Fast path: activate a pre-warmed container instead of cold-starting
  if (warmHandle) {
    onProcess(warmHandle.process, warmHandle.containerName);
    if (onOutput) warmHandle.setOnOutput(onOutput);

    // Pipe the prompt via IPC — must write to the warm container's mounted IPC path,
    // not the sender's slot path, because the container's bind mount is fixed at spawn time.
    const warmSlotId = warmHandle.slotId;
    const inputDir = warmSlotId
      ? path.join(resolveSlotIpcPath(group.folder, warmSlotId), 'input')
      : path.join(resolveGroupIpcPath(group.folder), 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text: input.prompt, model: input.model, sessionId: input.sessionId, replyToMessageId: input.replyToMessageId }));
    fs.renameSync(tempPath, filepath);

    logger.info(
      { group: group.name, containerName: warmHandle.containerName },
      'Activated warm container',
    );
    return warmHandle.exited;
  }

  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  cachedMkdir(groupDir);

  const mounts = buildVolumeMounts(group, input.isMain, input.slotId);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  cachedMkdir(logsDir);

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    let hadOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
    const tm = createTimeoutManager(timeoutMs, group, containerName, container);

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        // Prevent unbounded growth if no markers are found
        if (parseBuffer.length > PARSE_BUFFER_MAX) {
          parseBuffer = parseBuffer.slice(-PARSE_BUFFER_MAX / 2);
        }
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadOutput = true;
            tm.reset();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      tm.clear();
      const duration = Date.now() - startTime;

      if (tm.timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Output: ${hadOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      tm.clear();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

// Cache last-written content per file to skip redundant disk writes
const snapshotCache = new Map<string, string>();

/** Copy src to dst only if src is newer (by mtime). Returns true if copied. */
function copyIfNewer(src: string, dst: string, opts?: { chmod?: number }): boolean {
  try {
    const srcStat = fs.statSync(src);
    let dstMtime = 0;
    try { dstMtime = fs.statSync(dst).mtimeMs; } catch { /* dst missing */ }
    if (srcStat.mtimeMs > dstMtime) {
      fs.cpSync(src, dst, { recursive: true });
      if (opts?.chmod) fs.chmodSync(dst, opts.chmod);
      return true;
    }
  } catch { /* src missing, skip */ }
  return false;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  cachedMkdir(groupIpcDir);

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  const content = JSON.stringify(filteredTasks, null, 2);
  if (snapshotCache.get(tasksFile) === content) return;
  fs.writeFileSync(tasksFile, content);
  snapshotCache.set(tasksFile, content);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  cachedMkdir(groupIpcDir);

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  // Cache by group data to avoid redundant disk writes (exclude lastSync from cache key)
  const cacheKey = JSON.stringify(visibleGroups);
  if (snapshotCache.get(groupsFile) === cacheKey) return;
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  snapshotCache.set(groupsFile, cacheKey);
}
