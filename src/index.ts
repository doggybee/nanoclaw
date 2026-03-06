import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  WARM_POOL_SIZE,
} from './config.js';
import { LarkChannel } from './channels/lark.js';
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
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
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
} from './db.js';
import { GroupQueue, makeSlotKey } from './group-queue.js';
import { resolveGroupFolderPath, resolveSlotIpcPath, TASK_SENDER_ID, WARM_SENDER_PREFIX } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { selectModel } from './model-router.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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

// Per-slot reply target: shared between processUserSlot callback and
// startMessageLoop piping path so piped messages also get reply-to.
let pendingReplyTo: Record<string, { messageId: string; senderId: string; senderName: string } | undefined> = {};

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

    // Use the first candidate (groups are loaded from DB ordered by registration)
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
  // Use group-level session for warm container (no specific user yet)
  const sessionId = sessions[group.folder];
  const warmSlotId = `${WARM_SENDER_PREFIX}${Date.now()}`;

  spawnWarmContainer(group, chatJid, isMain, ASSISTANT_NAME, sessionId, warmSlotId)
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
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
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
 * Process all pending messages for a user slot in a group.
 * Called by the GroupQueue when it's this slot's turn.
 */
async function processUserSlot(chatJid: string, senderId: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const slotKey = makeSlotKey(chatJid, senderId);

  // Use per-slot cursor for timestamp tracking
  const sinceTimestamp = lastAgentTimestamp[slotKey] || lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Filter to only this sender's messages
  const senderMessages = missedMessages.filter((m) => m.sender === senderId);
  if (senderMessages.length === 0) return true;

  // Check if trigger is required and present
  if (group.requiresTrigger !== false) {
    const hasTrigger = senderMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // For trigger-required groups, only send messages that contain the trigger.
  const relevantMessages = group.requiresTrigger !== false
    ? senderMessages.filter((m) => TRIGGER_PATTERN.test(m.content.trim()))
    : senderMessages;

  const prompt = formatMessages(relevantMessages);

  // Select model based on message complexity
  const model = selectModel(relevantMessages);

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

  await channel.setTyping?.(chatJid, true);

  // Pre-create streaming card (using slotKey for isolation)
  const replyTarget = pendingReplyTo[slotKey];
  if (channel.beginStreaming) {
    channel.beginStreaming(slotKey, replyTarget
      ? { replyToMessageId: replyTarget.messageId, mentionUser: { id: replyTarget.senderId, name: replyTarget.senderName } }
      : undefined,
    ).catch((err) => {
      logger.warn({ slotKey, err }, 'Failed to pre-create streaming card, will create on first chunk');
    });
  }

  let hadError = false;
  let outputSentToUser = false;
  let lastStreamedText = '';

  const output = await runAgent(group, prompt, chatJid, senderId, async (result) => {
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

      if (text) {
        if (result.isStreaming) {
          logger.info({ group: group.name, senderId }, `Streaming chunk: ${text.slice(0, 100)}`);
          lastStreamedText = text;
          const target = pendingReplyTo[slotKey];
          pendingReplyTo[slotKey] = undefined;
          const opts: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; slotKey?: string } = target
            ? { replyToMessageId: target.messageId, mentionUser: { id: target.senderId, name: target.senderName }, slotKey }
            : { slotKey };
          await channel.sendMessage(chatJid, text, opts);
          outputSentToUser = true;
        } else {
          logger.info({ group: group.name, senderId }, `Agent output: ${raw.slice(0, 200)}`);
          if (text !== lastStreamedText) {
            const target = pendingReplyTo[slotKey];
            pendingReplyTo[slotKey] = undefined;
            const opts: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; slotKey?: string } = target
              ? { replyToMessageId: target.messageId, mentionUser: { id: target.senderId, name: target.senderName }, slotKey }
              : { slotKey };
            await channel.sendMessage(chatJid, text, opts);
            outputSentToUser = true;
          }
          channel.endStreaming?.(slotKey)?.catch((err) =>
            logger.warn({ slotKey, err }, 'Failed to end streaming on final result'));
        }
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(slotKey);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, model);

  await channel.setTyping?.(chatJid, false);
  await channel.endStreaming?.(slotKey);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name, senderId },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[slotKey] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name, senderId },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

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
  const sessionId = sessions[sKey] || sessions[group.folder];
  const slotKey = makeSlotKey(chatJid, senderId);

  // Update tasks snapshot
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
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
        ASSISTANT_NAME,
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

          // Filter to trigger messages only when required
          const triggerMessages = needsTrigger
            ? groupMessages.filter((m) => TRIGGER_PATTERN.test(m.content.trim()))
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

            if (queue.sendMessage(chatJid, senderId, formatted)) {
              // End current streaming card so the next reply creates a new one
              await channel.endStreaming?.(slotKey);

              logger.debug(
                { slotKey, count: senderMsgs.length },
                'Piped messages to active container',
              );
              // Advance cursor for this slot
              lastAgentTimestamp[slotKey] =
                senderMsgs[senderMsgs.length - 1].timestamp;
              saveState();
              // Update reply target
              pendingReplyTo[slotKey] = findReplyTarget(senderMsgs, needsTrigger);
              // Show typing indicator
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
                );
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
    // Check group-level cursor for recovery
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      // Group by sender for per-user recovery
      const senders = new Set(pending.map((m) => m.sender));
      for (const senderId of senders) {
        const senderPending = pending.filter((m) => m.sender === senderId);
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
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
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
    onCardAction: (chatJid: string, action: { actionId: string; value?: Record<string, string>; userId: string; messageId?: string }) => {
      const group = registeredGroups[chatJid];
      if (!group) return;
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
    addReaction: (jid, messageId, emojiType) => {
      const channel = findChannel(channels, jid);
      if (!channel?.addReaction) throw new Error(`No channel with reaction support for JID: ${jid}`);
      return channel.addReaction(jid, messageId, emojiType);
    },
    sendImage: (jid, imagePath) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendImage) throw new Error(`No channel with image support for JID: ${jid}`);
      return channel.sendImage(jid, imagePath);
    },
    sendFile: (jid, filePath) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendFile) throw new Error(`No channel with file support for JID: ${jid}`);
      return channel.sendFile(jid, filePath);
    },
    editMessage: (jid, messageId, text) => {
      const channel = findChannel(channels, jid);
      if (!channel?.editMessage) throw new Error(`No channel with edit support for JID: ${jid}`);
      return channel.editMessage(jid, messageId, text);
    },
    getChatHistory: (jid, count, beforeTimestamp) => {
      const channel = findChannel(channels, jid);
      if (!channel?.getChatHistory) throw new Error(`No channel with chat history support for JID: ${jid}`);
      return channel.getChatHistory(jid, count, beforeTimestamp);
    },
    sendCard: (jid, cardJson, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendCard) throw new Error(`No channel with card support for JID: ${jid}`);
      return channel.sendCard(jid, cardJson, replyToMessageId);
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
