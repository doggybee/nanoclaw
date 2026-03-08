/**
 * Tests for the refactored Lark channel modules.
 * Tests card builder, markdown optimization, message guard, and reply session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { optimizeMarkdownStyle, stripInvalidImageKeys } from './markdown-style.js';
import {
  buildThinkingCardJson,
  buildCompleteCard,
  toCardKit2,
  splitReasoningText,
  stripReasoningTags,
  formatElapsed,
  formatReasoningDuration,
  STREAMING_ELEMENT_ID,
  LOADING_ELEMENT_ID,
} from './card-builder.js';
import {
  MessageUnavailableError,
  extractLarkApiCode,
  formatLarkError,
} from './message-guard.js';

// ---------------------------------------------------------------------------
// markdown-style.ts
// ---------------------------------------------------------------------------
describe('optimizeMarkdownStyle', () => {
  it('downgrades headings when H1-H3 present', () => {
    const input = '# Title\n## Subtitle\ntext';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('#### Title');
    expect(result).toContain('##### Subtitle');
  });

  it('does not downgrade when no H1-H3', () => {
    const input = '#### Already H4\ntext';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('#### Already H4');
  });

  it('preserves code blocks', () => {
    const input = '```js\n# not a heading\n```';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('# not a heading');
  });

  it('compresses excess blank lines', () => {
    const input = 'line1\n\n\n\n\nline2';
    const result = optimizeMarkdownStyle(input);
    expect(result).toBe('line1\n\nline2');
  });

  it('returns original on error', () => {
    // null input would throw — the function catches and returns original
    expect(optimizeMarkdownStyle('')).toBe('');
  });
});

describe('stripInvalidImageKeys', () => {
  it('keeps valid Feishu image keys', () => {
    expect(stripInvalidImageKeys('![alt](img_v3_xxx)')).toBe('![alt](img_v3_xxx)');
  });

  it('keeps http URLs', () => {
    expect(stripInvalidImageKeys('![](https://example.com/img.png)')).toBe('![](https://example.com/img.png)');
  });

  it('strips local paths', () => {
    expect(stripInvalidImageKeys('![alt](./local/path.png)')).toBe('./local/path.png');
  });

  it('returns text unchanged if no images', () => {
    expect(stripInvalidImageKeys('no images here')).toBe('no images here');
  });
});

// ---------------------------------------------------------------------------
// card-builder.ts
// ---------------------------------------------------------------------------
describe('buildThinkingCardJson', () => {
  it('returns a valid CardKit 2.0 card with streaming mode', () => {
    const card = buildThinkingCardJson();
    expect(card.schema).toBe('2.0');
    expect(card.config.streaming_mode).toBe(true);
    expect(card.body.elements).toHaveLength(2);
    expect(card.body.elements[0].element_id).toBe(STREAMING_ELEMENT_ID);
    expect(card.body.elements[1].element_id).toBe(LOADING_ELEMENT_ID);
  });

  it('includes streaming_config for fast animation', () => {
    const card = buildThinkingCardJson();
    expect(card.config.streaming_config.print_frequency_ms).toBe(20);
    expect(card.config.streaming_config.print_strategy).toBe('fast');
  });
});

describe('buildCompleteCard', () => {
  it('creates a complete card with content and footer', () => {
    const card = buildCompleteCard('Hello world', { elapsedMs: 1500 });
    expect(card.schema).toBe('2.0');
    expect(card.config.wide_screen_mode).toBe(true);
    const elements = card.body.elements;
    // Should have: content + hr + footer
    expect(elements.length).toBeGreaterThanOrEqual(2);
    // Content element
    expect(elements[0].tag).toBe('markdown');
    expect(elements[0].element_id).toBe(STREAMING_ELEMENT_ID);
  });

  it('shows error state in footer', () => {
    const card = buildCompleteCard('oops', { isError: true, elapsedMs: 500 });
    const elements = card.body.elements;
    const footer = elements.find((e: any) => e.tag === 'markdown' && e.text_size === 'notation');
    expect(footer?.content).toContain('出错');
  });

  it('includes collapsible reasoning panel', () => {
    const card = buildCompleteCard('answer', {
      reasoningText: 'I thought about it',
      reasoningElapsedMs: 3000,
    });
    const panel = card.body.elements.find((e: any) => e.tag === 'collapsible_panel');
    expect(panel).toBeDefined();
    expect(panel.header.title.content).toContain('Thought for 3.0s');
  });

  it('generates feed summary', () => {
    const card = buildCompleteCard('This is the answer text');
    expect(card.config.summary.content).toContain('This is the answer text');
  });
});

describe('toCardKit2', () => {
  it('converts old format to CardKit 2.0', () => {
    const old = { config: {}, elements: [{ tag: 'markdown', content: 'hi' }] };
    const result = toCardKit2(old);
    expect(result.schema).toBe('2.0');
    expect(result.body.elements).toEqual(old.elements);
  });

  it('returns already-v2 cards unchanged', () => {
    const v2 = { schema: '2.0', body: { elements: [] } };
    expect(toCardKit2(v2)).toBe(v2);
  });
});

describe('splitReasoningText', () => {
  it('extracts XML-style thinking tags', () => {
    const result = splitReasoningText('<think>pondering</think>The answer is 42');
    expect(result.reasoningText).toBe('pondering');
    expect(result.answerText).toBe('The answer is 42');
  });

  it('handles unclosed thinking tags (streaming)', () => {
    const result = splitReasoningText('<thinking>still thinking');
    expect(result.reasoningText).toBe('still thinking');
  });

  it('handles prefix format', () => {
    const result = splitReasoningText('Reasoning:\n_some reasoning here_');
    expect(result.reasoningText).toBe('some reasoning here');
    expect(result.answerText).toBeUndefined();
  });

  it('returns answerText for normal text', () => {
    const result = splitReasoningText('just a normal answer');
    expect(result.answerText).toBe('just a normal answer');
    expect(result.reasoningText).toBeUndefined();
  });
});

describe('stripReasoningTags', () => {
  it('strips thinking tags', () => {
    expect(stripReasoningTags('<think>reasoning</think>answer')).toBe('answer');
  });

  it('returns text unchanged if no tags', () => {
    expect(stripReasoningTags('no tags here')).toBe('no tags here');
  });
});

describe('formatElapsed', () => {
  it('formats seconds', () => {
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(500)).toBe('0.5s');
  });

  it('formats minutes', () => {
    expect(formatElapsed(90000)).toBe('1m 30s');
  });

  it('handles undefined', () => {
    expect(formatElapsed(undefined)).toBe('0s');
  });
});

describe('formatReasoningDuration', () => {
  it('formats duration', () => {
    expect(formatReasoningDuration(3000)).toBe('Thought for 3.0s');
  });

  it('handles zero/undefined', () => {
    expect(formatReasoningDuration(0)).toBe('Thought');
    expect(formatReasoningDuration(undefined)).toBe('Thought');
  });
});

// ---------------------------------------------------------------------------
// message-guard.ts
// ---------------------------------------------------------------------------
describe('MessageUnavailableError', () => {
  it('creates error with correct properties', () => {
    const err = new MessageUnavailableError({
      messageId: 'om_123',
      apiCode: 230011,
      operation: 'test',
    });
    expect(err.messageId).toBe('om_123');
    expect(err.apiCode).toBe(230011);
    expect(err.name).toBe('MessageUnavailableError');
    expect(err.message).toContain('om_123');
  });
});

describe('extractLarkApiCode', () => {
  it('extracts code from top-level', () => {
    expect(extractLarkApiCode({ code: 230011 })).toBe(230011);
  });

  it('extracts code from response.data', () => {
    expect(extractLarkApiCode({ response: { data: { code: 231003 } } })).toBe(231003);
  });

  it('extracts code from data.code', () => {
    expect(extractLarkApiCode({ data: { code: '99991672' } })).toBe(99991672);
  });

  it('returns undefined for non-objects', () => {
    expect(extractLarkApiCode(null)).toBeUndefined();
    expect(extractLarkApiCode('string')).toBeUndefined();
  });
});

describe('formatLarkError', () => {
  it('formats permission error with scopes', () => {
    const err = { code: 99991672, msg: 'need [im:message] scope https://example.com/app/xxx' };
    const result = formatLarkError(err);
    expect(result).toContain('权限不足');
    expect(result).toContain('im:message');
  });

  it('formats regular error', () => {
    expect(formatLarkError({ code: 230011, msg: 'message deleted' })).toBe('message deleted');
  });

  it('handles non-object errors', () => {
    expect(formatLarkError('string error')).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// reply-session.ts — lifecycle and timing tests with mocked Lark client
// ---------------------------------------------------------------------------
import { ReplySession } from './reply-session.js';

function createMockClient() {
  const calls: Array<{ method: string; args: any[]; ts: number }> = [];
  const start = Date.now();
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args, ts: Date.now() - start });
    return Promise.resolve({ data: { card_id: `card_${calls.length}` }, code: 0 });
  };

  const client = {
    cardkit: {
      v1: {
        card: {
          create: track('card.create'),
          update: track('card.update'),
          settings: track('card.settings'),
        },
        cardElement: {
          content: track('cardElement.content'),
        },
      },
    },
    im: {
      v1: {
        message: {
          reply: track('im.message.reply'),
          create: track('im.message.create'),
        },
      },
    },
  };

  return { client: client as any, calls };
}

describe('ReplySession lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates card lazily on first pushContent', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    // No API calls yet
    expect(calls).toHaveLength(0);

    // First push triggers card creation
    await session.pushContent('Hello');
    expect(calls.some(c => c.method === 'card.create')).toBe(true);
    expect(calls.some(c => c.method === 'im.message.create')).toBe(true);
  });

  it('uses pool card when available, skipping card.create', async () => {
    const { client, calls } = createMockClient();
    const pool = ['prebuilt_card_1'];
    const session = new ReplySession(client, 'lark:chat123', {
      cardPool: pool,
      refillCardPool: () => {},
    });

    await session.pushContent('Hello');
    // Pool was used — no card.create call needed
    expect(calls.some(c => c.method === 'card.create')).toBe(false);
    // IM send still happens
    expect(calls.some(c => c.method === 'im.message.create')).toBe(true);
    // Pool is drained
    expect(pool).toHaveLength(0);
  });

  it('calls refillCardPool after borrowing from pool', async () => {
    const { client } = createMockClient();
    const refillFn = vi.fn();
    const session = new ReplySession(client, 'lark:chat123', {
      cardPool: ['prebuilt_card_1'],
      refillCardPool: refillFn,
    });

    await session.pushContent('Hello');
    expect(refillFn).toHaveBeenCalledTimes(1);
  });

  it('replies to message when replyToMessageId is set', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {
      replyToMessageId: 'om_msg_123',
    });

    await session.pushContent('Hello');
    // Should use im.message.reply instead of im.message.create
    expect(calls.some(c => c.method === 'im.message.reply')).toBe(true);
    expect(calls.some(c => c.method === 'im.message.create')).toBe(false);
  });

  it('prevents duplicate card creation on concurrent pushContent', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    // Push concurrently
    const p1 = session.pushContent('Hello');
    const p2 = session.pushContent('World');
    await Promise.all([p1, p2]);

    // Only one card.create
    const createCalls = calls.filter(c => c.method === 'card.create');
    expect(createCalls).toHaveLength(1);
  });

  it('throttles streaming updates', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    // First push creates card + streams
    await session.pushContent('chunk1');
    const streamCalls1 = calls.filter(c => c.method === 'cardElement.content');
    expect(streamCalls1).toHaveLength(1);

    // Immediate second push should be throttled (no extra API call yet)
    await session.pushContent('chunk1chunk2');
    const streamCalls2 = calls.filter(c => c.method === 'cardElement.content');
    expect(streamCalls2).toHaveLength(1); // Still just the first one

    // After throttle interval, deferred flush should fire
    await vi.advanceTimersByTimeAsync(150);
    const streamCalls3 = calls.filter(c => c.method === 'cardElement.content');
    expect(streamCalls3).toHaveLength(2);
  });

  it('finalize closes streaming and updates card', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', { startedAt: Date.now() });

    await session.pushContent('Final answer');
    calls.length = 0; // Reset tracked calls

    await session.finalize();

    // Should close streaming mode, then update card
    expect(calls.some(c => c.method === 'card.settings')).toBe(true);
    expect(calls.some(c => c.method === 'card.update')).toBe(true);
    // Settings called before update
    const settingsIdx = calls.findIndex(c => c.method === 'card.settings');
    const updateIdx = calls.findIndex(c => c.method === 'card.update');
    expect(settingsIdx).toBeLessThan(updateIdx);
  });

  it('finalize is idempotent', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    await session.pushContent('answer');
    calls.length = 0;

    await session.finalize();
    const firstCalls = calls.length;

    await session.finalize();
    expect(calls.length).toBe(firstCalls); // No additional calls
  });

  it('does not finalize when no card was created', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    // Never pushed content — no card exists
    await session.finalize();
    expect(calls).toHaveLength(0);
  });

  it('marks session as inactive after finalize', async () => {
    const { client } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});
    expect(session.isActive).toBe(true);

    await session.pushContent('test');
    await session.finalize();
    expect(session.isActive).toBe(false);
  });

  it('destroy cleans up without API calls', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    await session.pushContent('test');
    calls.length = 0;

    session.destroy();
    expect(session.isActive).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('abort calls finalize with isError', async () => {
    const { client, calls } = createMockClient();
    const session = new ReplySession(client, 'lark:chat123', {});

    await session.pushContent('test');
    calls.length = 0;

    await session.abort();
    expect(calls.some(c => c.method === 'card.update')).toBe(true);
    expect(session.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Performance: card builder computation time
// ---------------------------------------------------------------------------
describe('card builder performance', () => {
  it('buildThinkingCardJson runs in < 1ms', () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) buildThinkingCardJson();
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    expect(avg).toBeLessThan(1); // < 1ms per call
  });

  it('buildCompleteCard runs in < 1ms for typical content', () => {
    const content = 'This is a typical response from the AI assistant. '.repeat(20);
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      buildCompleteCard(content, {
        elapsedMs: 2500,
        reasoningText: 'Some reasoning text here',
        reasoningElapsedMs: 1000,
      });
    }
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    expect(avg).toBeLessThan(1); // < 1ms per call
  });

  it('optimizeMarkdownStyle runs in < 1ms for typical content', () => {
    const content = '# Title\n## Section\nSome text with **bold** and _italic_\n\n```js\nconst x = 1;\n```\n\n> blockquote\n\n- list item';
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) optimizeMarkdownStyle(content, 1);
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    expect(avg).toBeLessThan(1); // < 1ms per call
  });
});
