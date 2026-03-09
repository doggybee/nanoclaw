import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getRecentMessages, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

/** Check if sourceGroup is authorized to act on chatJid. */
function isAuthorized(
  isMain: boolean,
  sourceGroup: string,
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (isMain) return true;
  const target = registeredGroups[chatJid];
  return !!target && target.folder === sourceGroup;
}

/** Write a response file for the container to read. Atomic write via temp+rename. */
function writeIpcResponse(responsesDir: string, requestId: string, data: object): void {
  fs.mkdirSync(responsesDir, { recursive: true });
  const filepath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);
}

/**
 * Process a single IPC message. Handles send_message fallback and
 * request/response queries (get_chat_history).
 * All other Lark tools (add_reaction, edit_message, send_image, etc.) are
 * handled directly by the container's MCP server via the Lark SDK.
 */
async function processIpcMessage(
  data: any,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  ipcBaseDir: string,
  slotId?: string,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const { type, chatJid } = data;

  if (!chatJid) return;

  if (!isAuthorized(isMain, sourceGroup, chatJid, registeredGroups)) {
    logger.warn({ type, chatJid, sourceGroup }, `Unauthorized IPC ${type} attempt blocked`);
    return;
  }

  switch (type) {
    case 'send_message': {
      if (!data.text) return;
      await deps.sendMessage(chatJid, data.text);
      logger.info({ chatJid, sourceGroup, textLen: data.text.length }, 'IPC send_message (fallback)');
      return;
    }

    case 'get_chat_history': {
      const requestId = data.requestId as string;
      if (!requestId) return;

      const count = Math.min(Math.max(data.count || 20, 1), 50);
      const beforeTimestamp = data.before_timestamp as string | undefined;

      const messages = getRecentMessages(chatJid, count, beforeTimestamp);

      // Resolve the responses directory for this slot
      const responsesDir = slotId
        ? path.join(ipcBaseDir, sourceGroup, 'slots', slotId, 'responses')
        : path.join(ipcBaseDir, sourceGroup, 'responses');

      writeIpcResponse(responsesDir, requestId, {
        requestId,
        messages: messages.map((m) => ({
          sender_name: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          is_bot_message: !!m.is_bot_message,
        })),
      });

      logger.debug(
        { chatJid, sourceGroup, count: messages.length, requestId },
        'IPC get_chat_history response written',
      );
      return;
    }

    default:
      // Unknown or removed message type — silently ignore
      return;
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });

  /** Read and process all .json files in a directory, moving failures to errors/. */
  const processDir = async (
    dir: string,
    sourceGroup: string,
    handler: (data: any) => Promise<void>,
  ) => {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return; // Directory doesn't exist yet
    }
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await handler(data);
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error({ file, sourceGroup, err }, `Error processing IPC file in ${path.basename(dir)}`);
        fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
      }
    }
  };

  let processing = false;
  const processIpcFiles = async () => {
    if (processing) return;
    processing = true;
    try {
      // Scan all group IPC directories (identity determined by directory)
      let groupFolders: string[];
      try {
        groupFolders = fs.readdirSync(ipcBaseDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== 'errors')
          .map((d) => d.name);
      } catch (err) {
        logger.error({ err }, 'Error reading IPC base directory');
        return;
      }

      for (const sourceGroup of groupFolders) {
        const isMain = sourceGroup === MAIN_GROUP_FOLDER;

        // Scan legacy (non-slot) directories
        const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
        const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

        await processDir(messagesDir, sourceGroup, (data) =>
          processIpcMessage(data, sourceGroup, isMain, deps, ipcBaseDir),
        );
        await processDir(tasksDir, sourceGroup, (data) =>
          processTaskIpc(data, sourceGroup, isMain, deps),
        );

        // Scan per-slot directories: {groupFolder}/slots/*/messages/ and tasks/
        const slotsDir = path.join(ipcBaseDir, sourceGroup, 'slots');
        let slotIds: string[];
        try {
          slotIds = fs.readdirSync(slotsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          slotIds = []; // slots/ doesn't exist yet
        }
        for (const slotId of slotIds) {
          const slotMessagesDir = path.join(slotsDir, slotId, 'messages');
          const slotTasksDir = path.join(slotsDir, slotId, 'tasks');

          await processDir(slotMessagesDir, sourceGroup, (data) =>
            processIpcMessage(data, sourceGroup, isMain, deps, ipcBaseDir, slotId),
          );
          await processDir(slotTasksDir, sourceGroup, (data) =>
            processTaskIpc(data, sourceGroup, isMain, deps),
          );
        }
      }
    } finally {
      processing = false;
    }
  };

  // Use fs.watch for low-latency event-driven processing, with fallback polling.
  try {
    const watcher = fs.watch(ipcBaseDir, { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith('.json') && !filename.includes('responses')) {
        processIpcFiles();
      }
    });
    watcher.on('error', (err) => {
      logger.warn({ err }, 'IPC fs.watch error, relying on fallback polling');
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to start IPC fs.watch, using polling only');
  }

  // Fallback poll every 5s to catch any events fs.watch might miss
  const FALLBACK_POLL_INTERVAL = 5000;
  setInterval(processIpcFiles, FALLBACK_POLL_INTERVAL);

  // Initial scan
  processIpcFiles();
  logger.info('IPC watcher started (fs.watch + fallback polling)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const taskToUpdate = getTaskById(data.taskId);
        if (!taskToUpdate) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && taskToUpdate.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...taskToUpdate,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
