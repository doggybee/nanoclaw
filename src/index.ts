import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MODEL_FAST,
  POLL_INTERVAL,
  SESSION_IDLE_TIMEOUT,
  SESSION_MAX_BYTES,
  TRIGGER_PATTERN,
  WARM_POOL_SIZE,
} from './config.js';
import { LarkChannel } from './channels/lark/index.js';
import {
  ContainerOutput,
  WarmContainerHandle,
  runContainerAgent,
  spawnWarmContainer,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  detectProxyBindHost,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  chatVersion,
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  taskVersion,
} from './db.js';
import { GroupQueue, makeSlotKey } from './group-queue.js';
import { resolveGroupFolderPath, resolveSlotIpcPath, TASK_SENDER_ID, WARM_SENDER_PREFIX } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { selectModel } from './model-router.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { extractSessionCommand, findSessionCommand } from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// Per-slot (chatJid::senderId) timestamps for cursor tracking
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Snapshot dirty tracking — skip DB queries when data hasn't changed
let lastSeenTaskVersion = -1;
let lastSeenChatVersion = -1;
let cachedTasksSnapshot: Array<{
  id: string; groupFolder: string; prompt: string;
  schedule_type: string; schedule_value: string; status: string; next_run: string | null;
}> = [];
let cachedAvailableGroups: import('./container-runner.js').AvailableGroup[] = [];

// Per-slot reply target: shared between processUserSlot callback and
// startMessageLoop piping path so piped messages also get reply-to.
let pendingReplyTo: Record<string, { messageId: string; senderId: string; senderName: string } | undefined> = {};

// Session activity tracking: last time a session was used (epoch ms)
const sessionLastActivity: Record<string, number> = {};

let lark: LarkChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

// --- Shared Warm Pool (Step 7) ---

interface WarmPoolEntry {
  handle: WarmContainerHandle;
  chatJid: string;
  groupFolder: string;
  createdAt: number;
}

const warmPool: WarmPoolEntry[] = [];
const warmFailures = new Map<string, number>(); // chatJid -> consecutive failures
const MAX_WARM_FAILURES = 5;

/** Claim a warm container from the pool for the given chatJid. */
function claimWarm(chatJid: string): WarmContainerHandle | undefined {
  const idx = warmPool.findIndex((e) => e.chatJid === chatJid);
  if (idx === -1) return undefined;
  const entry = warmPool.splice(idx, 1)[0];
  // Verify the container process is still alive
  if (entry.handle.process.killed || entry.handle.process.exitCode !== null) {
    logger.warn({ chatJid }, 'Warm container already dead, discarding');
    setTimeout(() => replenishWarmPool(), 1000);
    return undefined;
  }
  // Replenish the pool after claiming
  setTimeout(() => replenishWarmPool(), 2000);
  return entry.handle;
}

/** Replenish the warm pool up to WARM_POOL_SIZE. */
function replenishWarmPool(): void {
  if (WARM_POOL_SIZE <= 0) return;
  while (warmPool.length < WARM_POOL_SIZE) {
    // Pick the most recently active registered group not already in the pool
    const poolJids = new Set(warmPool.map((e) => e.chatJid));
    const candidates = Object.keys(registeredGroups).filter((jid) => !poolJids.has(jid));
    if (candidates.length === 0) break;

    // Prefer the group with the most recent agent activity.
    // Timestamps are stored under slotKeys (chatJid::senderId), so aggregate.
    const maxSlotTimestamp = (jid: string): string => {
      let max = lastAgentTimestamp[jid] || '';
      for (const [key, ts] of Object.entries(lastAgentTimestamp)) {
        if (key.startsWith(`${jid}::`) && ts > max) max = ts;
      }
      return max;
    };
    candidates.sort((a, b) => maxSlotTimestamp(b).localeCompare(maxSlotTimestamp(a)));
    const chatJid = candidates[0];
    warmUpForPool(chatJid);
    break; // One at a time to avoid burst
  }
}

function warmUpForPool(chatJid: string): void {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const failures = warmFailures.get(chatJid) || 0;
  if (failures >= MAX_WARM_FAILURES) {
    logger.warn({ chatJid, failures }, 'Warm container disabled after repeated failures');
    return;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  // No session for warm containers — fresh session means fast SDK init.
  // Group CLAUDE.md provides cross-session memory.
  const warmSlotId = `${WARM_SENDER_PREFIX}${Date.now()}`;

  spawnWarmContainer(group, chatJid, isMain, ASSISTANT_NAME, undefined, warmSlotId, MODEL_FAST || undefined)
    .then((handle) => {
      warmPool.push({
        handle,
        chatJid,
        groupFolder: group.folder,
        createdAt: Date.now(),
      });
      warmFailures.delete(chatJid);
      logger.info({ chatJid, group: group.name, poolSize: warmPool.length }, 'Warm container added to pool');

      // When this warm container exits, remove from pool and replenish
      handle.exited.then((output) => {
        const idx = warmPool.findIndex((e) => e.handle === handle);
        if (idx !== -1) warmPool.splice(idx, 1);

        if (output.status === 'error' && !output.result) {
          const count = (warmFailures.get(chatJid) || 0) + 1;
          warmFailures.set(chatJid, count);
          const delay = Math.min(2000 * 2 ** count, 60_000);
          logger.warn({ chatJid, failures: count, delay }, 'Warm container failed, backing off');
          setTimeout(() => replenishWarmPool(), delay);
        } else {
          setTimeout(() => replenishWarmPool(), 2000);
        }
      });
    })
    .catch((err) => {
      const count = (warmFailures.get(chatJid) || 0) + 1;
      warmFailures.set(chatJid, count);
      logger.warn({ chatJid, err, failures: count }, 'Failed to spawn warm container');
    });
}

// Wake signal: resolves immediately to interrupt the polling sleep
let wakeResolve: (() => void) | null = null;

function wakeMessageLoop(): void {
  if (wakeResolve) {
    wakeResolve();
    wakeResolve = null;
  }
}

function sleepUntilWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeResolve = null;
      resolve();
    }, ms);
    wakeResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Seed session activity from JSONL modification times so restarts
  // don't treat long-idle sessions as "just used".
  for (const [sKey, sessionId] of Object.entries(sessions)) {
    const groupFolder = sKey.includes(':') ? sKey.split(':')[0] : sKey;
    const jsonlPath = path.join(
      DATA_DIR, 'sessions', groupFolder, '.claude',
      'projects', '-workspace-group', `${sessionId}.jsonl`,
    );
    try {
      const stat = fs.statSync(jsonlPath);
      sessionLastActivity[sKey] = stat.mtimeMs;
    } catch {
      // File missing — treat as no recent activity
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced state persistence — coalesces writes within 1s window. */
function saveState(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  }, 1000);
}

/** Immediate state flush — call on shutdown or critical rollback. */
function saveStateFlush(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Find the message to reply to (quote-reply + @mention target).
 * For trigger-required groups: the last message matching the trigger.
 * For always-on groups: the last non-bot message.
 */
function findReplyTarget(
  messages: NewMessage[],
  requiresTrigger: boolean,
): { messageId: string; senderId: string; senderName: string } | undefined {
  if (requiresTrigger) {
    for (let i = messages.length - 1; i >= 0; i--) {
      // Skip synthetic card-action messages — their IDs aren't valid Lark message IDs
      if (messages[i].id.startsWith('card-action-')) continue;
      if (TRIGGER_PATTERN.test(messages[i].content.trim())) {
        return { messageId: messages[i].id, senderId: messages[i].sender, senderName: messages[i].sender_name };
      }
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id.startsWith('card-action-')) continue;
      if (!messages[i].is_bot_message) {
        return { messageId: messages[i].id, senderId: messages[i].sender, senderName: messages[i].sender_name };
      }
    }
  }
  return undefined;
}

/** Session key for a user slot. */
function sessionKey(groupFolder: string, senderId: string): string {
  return senderId ? `${groupFolder}:${senderId}` : groupFolder;
}

/**
 * Check if a session should be rotated (idle timeout or size limit).
 * If so, clear the session ID so the SDK creates a fresh one.
 * Group CLAUDE.md provides persistent memory across sessions.
 */
function maybeRotateSession(sKey: string, groupFolder: string, senderId: string): void {
  const sessionId = sessions[sKey];
  if (!sessionId) return;

  const rotate = (reason: string, extra: Record<string, unknown> = {}) => {
    logger.info({ sessionKey: sKey, sessionId, ...extra }, `Session rotated: ${reason}`);
    delete sessions[sKey];
    deleteSession(groupFolder, senderId);
  };

  // Check idle timeout
  const lastActive = sessionLastActivity[sKey];
  if (lastActive && SESSION_IDLE_TIMEOUT > 0) {
    const idleMs = Date.now() - lastActive;
    if (idleMs > SESSION_IDLE_TIMEOUT) {
      rotate('idle timeout exceeded', { idleHours: (idleMs / 3600000).toFixed(1) });
      return;
    }
  }

  // Check file size
  if (SESSION_MAX_BYTES > 0) {
    const jsonlPath = path.join(
      DATA_DIR, 'sessions', groupFolder, '.claude',
      'projects', '-workspace-group', `${sessionId}.jsonl`,
    );
    try {
      const stat = fs.statSync(jsonlPath);
      if (stat.size > SESSION_MAX_BYTES) {
        rotate('size limit exceeded', { sizeMB: (stat.size / 1048576).toFixed(1) });
      }
    } catch {
      // File doesn't exist or can't be read — skip size check
    }
  }
}

/**
 * Process all pending messages for a user slot in a group.
 * Called by the GroupQueue when it's this slot's turn.
 */
async function processUserSlot(chatJid: string, senderId: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const slotKey = makeSlotKey(chatJid, senderId);

  // Use per-slot cursor for timestamp tracking; filter by sender in SQL
  const sinceTimestamp = lastAgentTimestamp[slotKey] || lastAgentTimestamp[chatJid] || '';
  const senderMessages = getMessagesSince(chatJid, sinceTimestamp, senderId);
  if (senderMessages.length === 0) return true;

  // Check if trigger is required and present (session commands always pass)
  if (group.requiresTrigger !== false) {
    const hasTrigger = senderMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()) ||
      extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
    );
    if (!hasTrigger) return true;
  }

  // For trigger-required groups, only send messages that contain the trigger or a session command.
  const relevantMessages = group.requiresTrigger !== false
    ? senderMessages.filter((m) =>
        TRIGGER_PATTERN.test(m.content.trim()) ||
        extractSessionCommand(m.content, TRIGGER_PATTERN) !== null)
    : senderMessages;

  // Intercept session commands (e.g. /compact)
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionCmd = findSessionCommand(relevantMessages, TRIGGER_PATTERN, isMain);
  if (sessionCmd && 'denied' in sessionCmd) {
    // Unauthorized — advance cursor, silently consume
    const slotKey = makeSlotKey(chatJid, senderId);
    lastAgentTimestamp[slotKey] = sessionCmd.denied.timestamp;
    saveState();
    const channel = findChannel(channels, chatJid);
    if (channel) await channel.sendMessage(chatJid, 'Session commands require admin access.');
    return true;
  }

  // If a session command is found, send it as the raw prompt (container handles it)
  const prompt = sessionCmd
    ? sessionCmd.command
    : formatMessages(relevantMessages);

  // Select model based on message complexity
  const model = sessionCmd ? undefined : selectModel(relevantMessages);

  // Rotate session if idle too long or context too large
  const sKey = sessionKey(group.folder, senderId);
  maybeRotateSession(sKey, group.folder, senderId);

  // Advance cursor for this slot
  const previousCursor = lastAgentTimestamp[slotKey] || '';
  lastAgentTimestamp[slotKey] =
    senderMessages[senderMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, senderId, messageCount: senderMessages.length },
    'Processing messages for user slot',
  );

  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name, slotKey }, 'Idle timeout, closing container stdin');
      queue.closeStdin(slotKey);
    }, IDLE_TIMEOUT);
  };

  // Set reply target
  if (!pendingReplyTo[slotKey]) {
    pendingReplyTo[slotKey] = findReplyTarget(relevantMessages, group.requiresTrigger !== false);
  }

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, senderId, async (result) => {
    // Container handles all message sending (CardKit streaming cards).
    // Host only tracks state.
    if (result.outputDelivered || result.result) {
      outputSentToUser = true;
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(slotKey);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, model);

  const isErrorState = output === 'error' || hadError;
  if (idleTimer) clearTimeout(idleTimer);

  if (isErrorState) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name, senderId },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      sessionLastActivity[sKey] = Date.now();
      return true;
    }
    lastAgentTimestamp[slotKey] = previousCursor;
    saveStateFlush();
    logger.warn(
      { group: group.name, senderId },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  sessionLastActivity[sKey] = Date.now();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  senderId: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  model?: string,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sKey = sessionKey(group.folder, senderId);
  const sessionId = sessions[sKey];
  const slotKey = makeSlotKey(chatJid, senderId);

  // Update snapshots only when underlying data has changed
  if (taskVersion !== lastSeenTaskVersion) {
    cachedTasksSnapshot = getAllTasks().map((t) => ({
      id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
      schedule_type: t.schedule_type, schedule_value: t.schedule_value,
      status: t.status, next_run: t.next_run,
    }));
    lastSeenTaskVersion = taskVersion;
  }
  writeTasksSnapshot(group.folder, isMain, cachedTasksSnapshot);

  if (chatVersion !== lastSeenChatVersion) {
    cachedAvailableGroups = getAvailableGroups();
    lastSeenChatVersion = chatVersion;
  }
  writeGroupsSnapshot(
    group.folder, isMain,
    cachedAvailableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sKey] = output.newSessionId;
          setSession(group.folder, output.newSessionId, senderId);
        }
        await onOutput(output);
      }
    : undefined;

  // Use warm container if available
  const warmHandle = claimWarm(chatJid);
  if (warmHandle) {
    logger.info({ group: group.name, senderId }, 'Using warm container');
  }

  // For IPC paths: if using a warm container, follow-up messages must go to
  // the warm container's mounted IPC path (fixed at spawn time), not the sender's.
  const effectiveSlotId = warmHandle?.slotId || senderId;

  try {
    // Pass replyToMessageId so the container can reply to the correct message
    const replyTarget = pendingReplyTo[slotKey];

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model,
        slotId: senderId, // Used for cold-start containers only (warm ignores this)
        replyToMessageId: replyTarget?.messageId,
      },
      (proc, containerName) => {
        queue.registerProcess(slotKey, proc, containerName, group.folder);
        // Set the IPC path for the slot so sendMessage/closeStdin use the right directory.
        // Must use effectiveSlotId (warm container's path) not senderId.
        const ipcPath = resolveSlotIpcPath(group.folder, effectiveSlotId);
        queue.setSlotIpcPath(slotKey, ipcPath);
      },
      wrappedOnOutput,
      warmHandle,
    );

    if (output.newSessionId) {
      sessions[sKey] = output.newSessionId;
      setSession(group.folder, output.newSessionId, senderId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Group by chatJid
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const needsTrigger = group.requiresTrigger !== false;

          // Filter to trigger messages only when required (session commands always pass)
          const triggerMessages = needsTrigger
            ? groupMessages.filter((m) =>
                TRIGGER_PATTERN.test(m.content.trim()) ||
                extractSessionCommand(m.content, TRIGGER_PATTERN) !== null)
            : groupMessages;

          if (triggerMessages.length === 0) continue;

          // Sub-group by sender for per-user slot routing
          const bySender = new Map<string, NewMessage[]>();
          for (const msg of triggerMessages) {
            const existing = bySender.get(msg.sender);
            if (existing) {
              existing.push(msg);
            } else {
              bySender.set(msg.sender, [msg]);
            }
          }

          for (const [senderId, senderMsgs] of bySender) {
            const slotKey = makeSlotKey(chatJid, senderId);
            const formatted = formatMessages(senderMsgs);

            // Find reply target for piped messages
            const pipedReplyTarget = findReplyTarget(senderMsgs, needsTrigger);
            if (queue.sendMessage(chatJid, senderId, formatted, { replyToMessageId: pipedReplyTarget?.messageId })) {
              logger.debug(
                { slotKey, count: senderMsgs.length },
                'Piped messages to active container',
              );
              // Advance cursor for this slot
              lastAgentTimestamp[slotKey] =
                senderMsgs[senderMsgs.length - 1].timestamp;
              saveState();
              // Update reply target for host fallback path
              pendingReplyTo[slotKey] = pipedReplyTarget;
            } else {
              // No active container for this sender — enqueue
              queue.enqueueMessageCheck(chatJid, senderId);
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await sleepUntilWake(POLL_INTERVAL);
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Use group-level cursor as baseline
    const groupCursor = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, groupCursor);
    if (pending.length === 0) continue;

    // Group by sender for per-user recovery
    const senders = new Set(pending.map((m) => m.sender));
    for (const senderId of senders) {
      // Check per-sender: slot cursor may be ahead of group cursor
      const slotKey = makeSlotKey(chatJid, senderId);
      const slotCursor = lastAgentTimestamp[slotKey] || groupCursor;
      const senderPending = pending.filter(
        (m) => m.sender === senderId && m.timestamp > slotCursor,
      );
      if (senderPending.length === 0) continue;

      const hasTrigger = group.requiresTrigger === false ||
        senderPending.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
      if (hasTrigger) {
        logger.info(
          { group: group.name, senderId, pendingCount: senderPending.length },
          'Recovery: found unprocessed messages for user',
        );
        queue.enqueueMessageCheck(chatJid, senderId);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();

  // Start credential proxy before any containers are spawned
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    detectProxyBindHost(),
  );

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    saveStateFlush();
    proxyServer.close();
    // Kill warm pool containers
    for (const entry of warmPool) {
      try { entry.handle.process.kill('SIGTERM'); } catch { /* already dead */ }
    }
    warmPool.length = 0;
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      wakeMessageLoop();
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onCardAction: async (chatJid: string, action: { actionId: string; value?: Record<string, string>; userId: string; messageId?: string }) => {
      const group = registeredGroups[chatJid];
      if (!group) return;

      // Agent-controlled ownership: if the card action value contains _owner,
      // only that user can interact. No _owner = anyone can click.
      const owner = action.value?._owner;
      if (owner && owner !== action.userId) {
        return { toast: { type: 'warning' as const, content: '仅发起者可操作此卡片' } };
      }

      const actionText = `@${ASSISTANT_NAME} [Card action: ${action.actionId}${action.value ? ` data=${JSON.stringify(action.value)}` : ''} by user ${action.userId}]`;
      const syntheticId = `card-action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      storeMessage({
        id: syntheticId,
        chat_jid: chatJid,
        sender: action.userId,
        sender_name: action.userId,
        content: actionText,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
      // Pre-set reply target for this user's slot
      const slotKey = makeSlotKey(chatJid, action.userId);
      if (action.messageId) {
        pendingReplyTo[slotKey] = { messageId: action.messageId, senderId: action.userId, senderName: action.userId };
      }
      wakeMessageLoop();
    },
    onNewChat: (jid: string, isGroup: boolean) => {
      // Auto-register: generate a folder name from the chat ID
      const chatId = jid.replace(/^lark:/, '');
      const folder = (isGroup ? 'g-' : 'dm-') + chatId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
      const group: RegisteredGroup = {
        name: folder,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup, // groups need @mention, DMs respond directly
      };
      registerGroup(jid, group);
      logger.info({ jid, folder, isGroup }, 'Auto-registered new chat');
      return group;
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect Lark channel
  lark = new LarkChannel(channelOpts);
  channels.push(lark);
  await lark.connect();

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => {
      const taskSlotKey = makeSlotKey(groupJid, TASK_SENDER_ID);
      queue.registerProcess(taskSlotKey, proc, containerName, groupFolder);
    },
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (_force) => {
      await lark.syncChatMetadata();
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processUserSlot);
  queue.setOnMaxRetriesFn((chatJid, senderId) => {
    const channel = findChannel(channels, chatJid);
    if (channel) {
      channel.sendMessage(chatJid, '⚠️ Message processing failed after multiple retries. Please try again.', {}).catch(() => {});
    }
  });
  recoverPendingMessages();

  // Warm pool: pre-warm containers for registered groups
  replenishWarmPool();

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
