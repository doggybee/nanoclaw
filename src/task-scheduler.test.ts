import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getDueTasks,
  getTaskById,
  updateTaskAfterRun,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('enqueues a due task to the GroupQueue', async () => {
    createTask({
      id: 'task-happy',
      group_folder: 'mygroup',
      chat_jid: 'group@g.us',
      prompt: 'say hello',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith('group@g.us', 'task-happy', expect.any(Function));
  });

  it('marks once-tasks as completed via updateTaskAfterRun', () => {
    createTask({
      id: 'task-once-done',
      group_folder: 'mygroup',
      chat_jid: 'group@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-once-done')!;
    const nextRun = computeNextRun(task);
    expect(nextRun).toBeNull();

    updateTaskAfterRun(task.id, nextRun, 'Done');
    const updated = getTaskById('task-once-done')!;
    expect(updated.status).toBe('completed');
    expect(updated.next_run).toBeNull();
    expect(updated.last_run).not.toBeNull();
  });

  it('sets correct next_run for interval tasks after run', () => {
    const scheduledTime = new Date(Date.now() - 5000).toISOString();
    createTask({
      id: 'task-interval',
      group_folder: 'mygroup',
      chat_jid: 'group@g.us',
      prompt: 'recurring',
      schedule_type: 'interval',
      schedule_value: '120000',
      context_mode: 'isolated',
      next_run: scheduledTime,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-interval')!;
    const nextRun = computeNextRun(task);
    expect(new Date(nextRun!).getTime()).toBe(new Date(scheduledTime).getTime() + 120000);

    updateTaskAfterRun(task.id, nextRun, 'OK');
    const updated = getTaskById('task-interval')!;
    expect(updated.status).toBe('active');
    expect(updated.next_run).toBe(nextRun);
  });

  it('computes correct next_run for cron tasks', () => {
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    const task = {
      id: 'cron-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'cron',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextDate = new Date(nextRun!);
    expect(nextDate.getTime()).toBeGreaterThan(Date.now());
    expect(nextDate.getMinutes()).toBe(0);
  });

  it('paused tasks are not picked up by getDueTasks', () => {
    createTask({
      id: 'task-paused',
      group_folder: 'mygroup',
      chat_jid: 'group@g.us',
      prompt: 'paused',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'paused',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-active',
      group_folder: 'mygroup',
      chat_jid: 'group@g.us',
      prompt: 'active',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const due = getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('task-active');
  });

  it('enqueues multiple due tasks in one tick', async () => {
    for (const [id, jid] of [['t1', 'g1@g.us'], ['t2', 'g1@g.us'], ['t3', 'g2@g.us']]) {
      createTask({
        id,
        group_folder: 'mygroup',
        chat_jid: jid,
        prompt: id,
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 60_000).toISOString(),
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }

    const enqueueTask = vi.fn();
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(enqueueTask).toHaveBeenCalledTimes(3);
  });
});
