import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue, makeSlotKey } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  MAX_CONTAINERS_PER_GROUP: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single user slot at a time ---

  it('only runs one container per user slot at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_chatJid: string, _senderId: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same user slot
    queue.enqueueMessageCheck('group1@g.us', 'user1');
    queue.enqueueMessageCheck('group1@g.us', 'user1');

    await vi.advanceTimersByTimeAsync(200);

    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_chatJid: string, _senderId: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 different user slots (limit is 2)
    queue.enqueueMessageCheck('group1@g.us', 'user1');
    queue.enqueueMessageCheck('group2@g.us', 'user2');
    queue.enqueueMessageCheck('group3@g.us', 'user3');

    await vi.advanceTimersByTimeAsync(10);

    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same slot', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    // Tasks now use their own __task__ slot, so test that within
    // the __task__ slot, tasks drain before pending messages.
    const processMessages = vi.fn(async (_chatJid: string, senderId: string) => {
      if (executionOrder.length === 0 && senderId === '__task__') {
        // Block the first task-slot processing
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push(`messages:${senderId}`);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a task (uses __task__ slot)
    const taskFn1 = vi.fn(async () => {
      executionOrder.push('task1');
    });
    // Use enqueueMessageCheck for __task__ slot first to create a message-type container
    queue.enqueueMessageCheck('group1@g.us', '__task__');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue a task and more messages for same slot
    const taskFn2 = vi.fn(async () => {
      executionOrder.push('task2');
    });
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);
    queue.enqueueMessageCheck('group1@g.us', '__task__');

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should drain before messages
    expect(executionOrder[0]).toBe('messages:__task__');
    expect(executionOrder[1]).toBe('task2');
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', 'user1');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us', 'user1');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', 'user1');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting slots get drained when slots free up ---

  it('drains waiting slots when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (chatJid: string, senderId: string) => {
      processed.push(`${chatJid}::${senderId}`);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both global slots
    queue.enqueueMessageCheck('group1@g.us', 'user1');
    queue.enqueueMessageCheck('group2@g.us', 'user2');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us', 'user3');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us::user1', 'group2@g.us::user2']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us::user3');
  });

  // --- Running task dedup ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(dupFn).not.toHaveBeenCalled();

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us', 'user1');
    await vi.advanceTimersByTimeAsync(10);

    const slotKey = makeSlotKey('group1@g.us', 'user1');
    queue.registerProcess(
      slotKey,
      {} as any,
      'container-1',
      'test-group',
    );

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle __task__ container when new task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing for __task__ slot (simulating a completed task that's now idle)
    queue.enqueueMessageCheck('group1@g.us', '__task__');
    await vi.advanceTimersByTimeAsync(10);

    const taskSlotKey = makeSlotKey('group1@g.us', '__task__');
    queue.registerProcess(
      taskSlotKey,
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle(taskSlotKey);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Enqueue a task — should preempt the idle __task__ container
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us', 'user1');
    await vi.advanceTimersByTimeAsync(10);

    const slotKey = makeSlotKey('group1@g.us', 'user1');
    queue.registerProcess(
      slotKey,
      {} as any,
      'container-1',
      'test-group',
    );

    queue.notifyIdle(slotKey);

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'user1', 'hello');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    const taskSlotKey = makeSlotKey('group1@g.us', '__task__');
    queue.registerProcess(
      taskSlotKey,
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage for a user slot should return false (no active container for this user)
    const result = queue.sendMessage('group1@g.us', 'user1', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks in __task__ slot', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start the __task__ slot processing
    queue.enqueueMessageCheck('group1@g.us', '__task__');
    await vi.advanceTimersByTimeAsync(10);

    const taskSlotKey = makeSlotKey('group1@g.us', '__task__');
    queue.registerProcess(
      taskSlotKey,
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle(taskSlotKey);

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Per-group concurrency limit ---

  it('allows concurrent slots for different users in the same group', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (chatJid: string, senderId: string) => {
      processed.push(`${chatJid}::${senderId}`);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Two users in the same group should run concurrently (MAX_CONTAINERS_PER_GROUP = 2)
    queue.enqueueMessageCheck('group1@g.us', 'user1');
    queue.enqueueMessageCheck('group1@g.us', 'user2');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us::user1', 'group1@g.us::user2']);

    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
  });
});
