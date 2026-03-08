import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { ChatHistoryMessage, RegisteredGroup } from './types.js';

/**
 * Resolve a container-internal path to the corresponding host path.
 * Supported container mount prefixes:
 *   /workspace/group/  → groups/{folder}/
 *   /workspace/project/ → project root (read-only)
 */
function resolveContainerPath(containerPath: string, groupFolder: string): string {
  if (containerPath.startsWith('/workspace/group/')) {
    const relative = containerPath.slice('/workspace/group/'.length);
    const groupDir = resolveGroupFolderPath(groupFolder);
    const resolved = path.resolve(groupDir, relative);
    if (!resolved.startsWith(groupDir + path.sep) && resolved !== groupDir) {
      throw new Error(`Path escapes group directory: ${containerPath}`);
    }
    return resolved;
  }

  if (containerPath.startsWith('/workspace/project/')) {
    const relative = containerPath.slice('/workspace/project/'.length);
    const projectRoot = process.cwd();
    const resolved = path.resolve(projectRoot, relative);
    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      throw new Error(`Path escapes project directory: ${containerPath}`);
    }
    return resolved;
  }

  if (containerPath.startsWith('/tmp/') || containerPath.startsWith('/home/')) {
    throw new Error(
      `Container path "${containerPath}" is not host-accessible. ` +
      `Files must be saved to /workspace/group/ (e.g. /workspace/group/tmp/) to be sendable.`,
    );
  }

  throw new Error(`Unsupported container path: ${containerPath}`);
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  addReaction?: (jid: string, messageId: string, emojiType: string) => Promise<void>;
  sendImage?: (jid: string, imagePath: string) => Promise<void>;
  sendFile?: (jid: string, filePath: string) => Promise<void>;
  editMessage?: (jid: string, messageId: string, text: string) => Promise<void>;
  getChatHistory?: (jid: string, count: number, beforeTimestamp?: string) => Promise<ChatHistoryMessage[]>;
  sendCard?: (jid: string, cardJson: object, replyToMessageId?: string) => Promise<void>;
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

/** Write an IPC response file atomically. */
function writeIpcResponse(responsePath: string, data: object): void {
  const dir = path.dirname(responsePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, responsePath);
}

/**
 * Process a single IPC message. Returns void; errors are thrown to caller.
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

  // --- Fire-and-forget message types (authorization required) ---
  if (!isAuthorized(isMain, sourceGroup, chatJid, registeredGroups)) {
    logger.warn({ type, chatJid, sourceGroup }, `Unauthorized IPC ${type} attempt blocked`);
    return;
  }

  switch (type) {
    case 'add_reaction': {
      if (!data.messageId || !data.emojiType) return;
      if (!deps.addReaction) {
        logger.warn({ chatJid, sourceGroup }, 'addReaction not available on channel');
        return;
      }
      await deps.addReaction(chatJid, data.messageId, data.emojiType);
      logger.info({ chatJid, messageId: data.messageId, emojiType: data.emojiType, sourceGroup }, 'IPC reaction added');
      return;
    }

    case 'edit_message': {
      if (!data.messageId || !data.text) return;
      if (!deps.editMessage) {
        logger.warn({ chatJid, sourceGroup }, 'editMessage not available on channel');
        return;
      }
      await deps.editMessage(chatJid, data.messageId, data.text);
      logger.info({ chatJid, messageId: data.messageId, sourceGroup }, 'IPC message edited');
      return;
    }

    case 'send_image': {
      if (!data.imagePath) return;
      if (!deps.sendImage) {
        logger.warn({ chatJid, sourceGroup }, 'sendImage not available on channel');
        return;
      }
      const hostPath = resolveContainerPath(data.imagePath, sourceGroup);
      await deps.sendImage(chatJid, hostPath);
      logger.info({ chatJid, imagePath: hostPath, sourceGroup }, 'IPC image sent');
      return;
    }

    case 'send_file': {
      if (!data.filePath) return;
      if (!deps.sendFile) {
        logger.warn({ chatJid, sourceGroup }, 'sendFile not available on channel');
        return;
      }
      const hostPath = resolveContainerPath(data.filePath, sourceGroup);
      await deps.sendFile(chatJid, hostPath);
      logger.info({ chatJid, filePath: hostPath, sourceGroup }, 'IPC file sent');
      return;
    }

    case 'send_card': {
      if (!data.cardJson) return;
      if (!deps.sendCard) {
        logger.warn({ chatJid, sourceGroup }, 'sendCard not available on channel');
        return;
      }
      await deps.sendCard(chatJid, data.cardJson, data.replyToMessageId);
      logger.info({ chatJid, sourceGroup }, 'IPC card sent');
      return;
    }

    case 'get_chat_history': {
      if (!data.requestId) return;
      // Write response to the slot's responses dir if slotId is present,
      // otherwise fall back to group-level responses dir.
      const groupIpcDir = path.join(ipcBaseDir, sourceGroup);
      const effectiveSlotId = slotId || data.slotId;
      const responseBase = effectiveSlotId
        ? path.join(groupIpcDir, 'slots', effectiveSlotId, 'responses')
        : path.join(groupIpcDir, 'responses');
      // Sanitize: ensure response path stays within the group's IPC directory
      const sanitizedRequestId = String(data.requestId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const responsePath = path.resolve(responseBase, `${sanitizedRequestId}.json`);
      const rel = path.relative(groupIpcDir, responsePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn({ sourceGroup, slotId: data.slotId, requestId: data.requestId }, 'IPC response path escapes group directory');
        return;
      }
      if (!deps.getChatHistory) {
        logger.warn({ chatJid, sourceGroup }, 'getChatHistory not available on channel');
        writeIpcResponse(responsePath, { status: 'error', error: 'getChatHistory not available on this channel' });
        return;
      }
      try {
        const messages = await deps.getChatHistory(chatJid, data.count || 20, data.beforeTimestamp || undefined);
        writeIpcResponse(responsePath, { status: 'ok', messages });
        logger.info({ chatJid, count: messages.length, requestId: data.requestId, sourceGroup }, 'IPC chat history fetched');
      } catch (err) {
        writeIpcResponse(responsePath, { status: 'error', error: String(err) });
        logger.error({ err, requestId: data.requestId, sourceGroup }, 'IPC chat history fetch failed');
      }
      return;
    }

    default:
      // Unknown message type — silently ignore (may be a future type)
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
