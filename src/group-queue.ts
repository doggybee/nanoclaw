import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { MAX_CONCURRENT_CONTAINERS, MAX_CONTAINERS_PER_GROUP } from './config.js';
import { resolveSlotIpcPath } from './group-folder.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

export type SlotKey = string; // `${chatJid}::${senderId}`

export function makeSlotKey(chatJid: string, senderId: string): SlotKey {
  return `${chatJid}::${senderId}`;
}

export function parseSlotKey(slotKey: SlotKey): { chatJid: string; senderId: string } {
  const idx = slotKey.indexOf('::');
  return { chatJid: slotKey.slice(0, idx), senderId: slotKey.slice(idx + 2) };
}

interface SlotState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  chatJid: string;
  senderId: string;
  ipcPath: string | null;
}

export class GroupQueue {
  private slots = new Map<SlotKey, SlotState>();
  private activeCount = 0;
  private groupActiveCount = new Map<string, number>(); // chatJid -> active slot count
  private waitingSlots: SlotKey[] = [];
  private processMessagesFn: ((chatJid: string, senderId: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getSlot(slotKey: SlotKey): SlotState {
    let state = this.slots.get(slotKey);
    if (!state) {
      const { chatJid, senderId } = parseSlotKey(slotKey);
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        chatJid,
        senderId,
        ipcPath: null,
      };
      this.slots.set(slotKey, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (chatJid: string, senderId: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(chatJid: string, senderId: string): void {
    if (this.shuttingDown) return;

    const slotKey = makeSlotKey(chatJid, senderId);
    const state = this.getSlot(slotKey);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ slotKey }, 'Container active, message queued');
      return;
    }

    const groupActive = this.groupActiveCount.get(chatJid) || 0;

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS || groupActive >= MAX_CONTAINERS_PER_GROUP) {
      state.pendingMessages = true;
      if (!this.waitingSlots.includes(slotKey)) {
        this.waitingSlots.push(slotKey);
      }
      logger.debug(
        { slotKey, activeCount: this.activeCount, groupActive },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForSlot(slotKey, 'messages').catch((err) =>
      logger.error({ slotKey, err }, 'Unhandled error in runForSlot'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    // Tasks use a special sender ID
    const senderId = '__task__';
    const slotKey = makeSlotKey(groupJid, senderId);
    const state = this.getSlot(slotKey);

    // Prevent double-queuing
    if (state.runningTaskId === taskId) {
      logger.debug({ slotKey, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ slotKey, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(slotKey);
      }
      logger.debug({ slotKey, taskId }, 'Container active, task queued');
      return;
    }

    const groupActive = this.groupActiveCount.get(groupJid) || 0;

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS || groupActive >= MAX_CONTAINERS_PER_GROUP) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingSlots.includes(slotKey)) {
        this.waitingSlots.push(slotKey);
      }
      logger.debug(
        { slotKey, taskId, activeCount: this.activeCount, groupActive },
        'At concurrency limit, task queued',
      );
      return;
    }

    this.runTask(slotKey, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ slotKey, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    slotKey: SlotKey,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getSlot(slotKey);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  notifyIdle(slotKey: SlotKey): void {
    const state = this.getSlot(slotKey);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(slotKey);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(chatJid: string, senderId: string, text: string): boolean {
    const slotKey = makeSlotKey(chatJid, senderId);
    const state = this.getSlot(slotKey);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false;

    const inputDir = this.getSlotIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(slotKey: SlotKey): void {
    const state = this.getSlot(slotKey);
    if (!state.active || !state.groupFolder) return;

    const inputDir = this.getSlotIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /** Get the IPC input directory for a slot. Uses per-slot IPC path. */
  private getSlotIpcInputDir(state: SlotState): string {
    if (state.ipcPath) {
      return path.join(state.ipcPath, 'input');
    }
    // Fallback: per-slot directory under group IPC
    return path.join(resolveSlotIpcPath(state.groupFolder!, state.senderId), 'input');
  }

  /** Set the IPC path for a slot (used when container is spawned). */
  setSlotIpcPath(slotKey: SlotKey, ipcPath: string): void {
    const state = this.getSlot(slotKey);
    state.ipcPath = ipcPath;
  }

  private incrementGroupActive(chatJid: string): void {
    this.groupActiveCount.set(chatJid, (this.groupActiveCount.get(chatJid) || 0) + 1);
  }

  private decrementGroupActive(chatJid: string): void {
    const count = (this.groupActiveCount.get(chatJid) || 1) - 1;
    if (count <= 0) {
      this.groupActiveCount.delete(chatJid);
    } else {
      this.groupActiveCount.set(chatJid, count);
    }
  }

  private async runForSlot(
    slotKey: SlotKey,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getSlot(slotKey);
    const { chatJid } = parseSlotKey(slotKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;
    this.incrementGroupActive(chatJid);

    logger.debug(
      { slotKey, reason, activeCount: this.activeCount, groupActive: this.groupActiveCount.get(chatJid) },
      'Starting container for slot',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatJid, state.senderId);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(slotKey, state);
        }
      }
    } catch (err) {
      logger.error({ slotKey, err }, 'Error processing messages for slot');
      this.scheduleRetry(slotKey, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.ipcPath = null;
      this.activeCount--;
      this.decrementGroupActive(chatJid);
      this.drainSlot(slotKey);
    }
  }

  private async runTask(slotKey: SlotKey, task: QueuedTask): Promise<void> {
    const state = this.getSlot(slotKey);
    const { chatJid } = parseSlotKey(slotKey);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;
    this.incrementGroupActive(chatJid);

    logger.debug(
      { slotKey, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ slotKey, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.ipcPath = null;
      this.activeCount--;
      this.decrementGroupActive(chatJid);
      this.drainSlot(slotKey);
    }
  }

  private scheduleRetry(slotKey: SlotKey, state: SlotState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { slotKey, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { slotKey, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(state.chatJid, state.senderId);
      }
    }, delayMs);
  }

  private drainSlot(slotKey: SlotKey): void {
    if (this.shuttingDown) return;

    const state = this.getSlot(slotKey);

    // Tasks first
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(slotKey, task).catch((err) =>
        logger.error(
          { slotKey, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForSlot(slotKey, 'drain').catch((err) =>
        logger.error(
          { slotKey, err },
          'Unhandled error in runForSlot (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this slot; check if other slots are waiting
    this.drainWaiting();
  }

  private drainWaiting(): void {
    const len = this.waitingSlots.length;
    let checked = 0;
    while (
      checked < len &&
      this.waitingSlots.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextSlotKey = this.waitingSlots.shift()!;
      const state = this.getSlot(nextSlotKey);
      const { chatJid } = parseSlotKey(nextSlotKey);
      const groupActive = this.groupActiveCount.get(chatJid) || 0;

      // Check per-group limit
      if (groupActive >= MAX_CONTAINERS_PER_GROUP) {
        // Put back at end of waiting list
        this.waitingSlots.push(nextSlotKey);
        checked++;
        continue;
      }

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextSlotKey, task).catch((err) =>
          logger.error(
            { slotKey: nextSlotKey, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForSlot(nextSlotKey, 'drain').catch((err) =>
          logger.error(
            { slotKey: nextSlotKey, err },
            'Unhandled error in runForSlot (waiting)',
          ),
        );
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [_slotKey, state] of this.slots) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
