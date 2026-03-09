/**
 * Tests for the Lark channel host-side modules.
 *
 * Section 1: Unit tests for pure helpers (markdown-style, message-guard).
 * Section 2: Integration tests for LarkChannel class.
 * Section 3: Standalone helper function tests (splitMarkdown).
 * Section 4: Inbound message converter tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (hoisted before any imports that depend on them)
// ---------------------------------------------------------------------------

vi.mock('../../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../db.js', () => ({
  updateChatNamesBatch: vi.fn(),
}));

// Mock http — capture the request handler from createServer
const httpServerRef = vi.hoisted(() => ({
  requestHandler: null as ((req: any, res: any) => void) | null,
}));

vi.mock('http', () => {
  const mockServer = {
    listen: vi.fn((_port: number, cb?: () => void) => {
      if (cb) cb();
      return mockServer;
    }),
    close: vi.fn(),
    closeAllConnections: vi.fn(),
    on: vi.fn(),
  };
  return {
    createServer: vi.fn((handler: (req: any, res: any) => void) => {
      httpServerRef.requestHandler = handler;
      return mockServer;
    }),
  };
});

// --- @larksuiteoapi/node-sdk mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@larksuiteoapi/node-sdk', () => {
  let messageHandler: Handler | null = null;

  return {
    Client: class MockClient {
      request = vi.fn().mockResolvedValue({
        bot: { open_id: 'ou_BOT_123' },
      });
      im = {
        v1: {
          message: {
            create: vi.fn().mockResolvedValue({ data: { message_id: 'om_placeholder_001' } }),
            reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_placeholder_002' } }),
            delete: vi.fn().mockResolvedValue(undefined),
            list: vi.fn().mockResolvedValue({ data: { items: [] } }),
            patch: vi.fn().mockResolvedValue(undefined),
          },
          chat: {
            list: vi.fn().mockResolvedValue({ data: { items: [] } }),
          },
          image: {
            create: vi.fn().mockResolvedValue({ image_key: 'img_test' }),
          },
          file: {
            create: vi.fn().mockResolvedValue({ file_key: 'file_test' }),
          },
          messageResource: {
            get: vi.fn().mockResolvedValue(null),
          },
        },
      };
      constructor() {
        clientRef.current = this;
      }
    },
    EventDispatcher: class MockEventDispatcher {
      _handler: Handler | null = null;
      register(handlers: Record<string, Handler>) {
        this._handler = handlers['im.message.receive_v1'] || null;
        messageHandler = this._handler;
        return this;
      }
    },
    CardActionHandler: class MockCardActionHandler {
      constructor(_config: any, _handler: Handler) {}
    },
    adaptDefault: vi.fn(
      (_path: string, _dispatcher: any, _opts: any) => {
        return async (_req: any, _res: any) => {};
      },
    ),
    Domain: { Lark: 'https://open.larksuite.com' },
    LoggerLevel: { error: 'error', info: 'info' },
    __getMessageHandler: () => messageHandler,
  };
});

vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    LARK_APP_ID: 'cli_test_app_id',
    LARK_APP_SECRET: 'test_app_secret',
    LARK_ENCRYPT_KEY: '',
    LARK_VERIFICATION_TOKEN: '',
    LARK_WEBHOOK_PORT: '3000',
    LARK_WEBHOOK_PATH: '/lark/events',
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { optimizeMarkdownStyle, stripInvalidImageKeys } from './markdown-style.js';
import {
  MessageUnavailableError,
  extractLarkApiCode,
  formatLarkError,
} from './message-guard.js';
import { LarkChannel, LarkChannelOpts, splitMarkdown } from './index.js';
import { updateChatNamesBatch } from '../../db.js';
import { readEnvFile } from '../../env.js';
import * as LarkSdk from '@larksuiteoapi/node-sdk';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestOpts(
  overrides?: Partial<LarkChannelOpts>,
): LarkChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'lark:oc_test123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageData(overrides: {
  chatId?: string;
  chatType?: string;
  messageId?: string;
  messageType?: string;
  content?: string;
  createTime?: string;
  senderOpenId?: string;
  mentions?: Array<{ key: string; id?: { open_id?: string }; name?: string }>;
}) {
  return {
    message: {
      chat_id: overrides.chatId ?? 'oc_test123',
      chat_type: overrides.chatType ?? 'group',
      message_id: overrides.messageId ?? 'om_test_msg_001',
      message_type: overrides.messageType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text: 'Hello everyone' }),
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions,
    },
    sender: {
      sender_id: {
        open_id: overrides.senderOpenId ?? 'ou_USER_456',
      },
    },
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessageEvent(data: ReturnType<typeof createMessageData>) {
  const handler = (LarkSdk as any).__getMessageHandler();
  if (handler) await handler(data);
}

// =========================================================================
// Section 1: Unit tests — pure helpers
// =========================================================================

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
    expect(optimizeMarkdownStyle('')).toBe('');
  });

  it('strips invalid image keys (non img_/http)', () => {
    const input = 'Look: ![alt](some_fake_key) and ![ok](img_v3_abc)';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('some_fake_key');
    expect(result).not.toContain('![alt](some_fake_key)');
    expect(result).toContain('![ok](img_v3_abc)');
  });

  it('preserves valid http image URLs', () => {
    const input = '![pic](https://example.com/img.png)';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('![pic](https://example.com/img.png)');
  });

  it('preserves text without images unchanged', () => {
    const input = 'Hello world';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toBe('Hello world');
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

describe('markdown optimization performance', () => {
  it('optimizeMarkdownStyle runs in < 1ms for typical content', () => {
    const content = '# Title\n## Section\nSome text with **bold** and _italic_\n\n```js\nconst x = 1;\n```\n\n> blockquote\n\n- list item';
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) optimizeMarkdownStyle(content, 1);
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    expect(avg).toBeLessThan(1);
  });
});

// =========================================================================
// Section 2: Integration tests — LarkChannel
// =========================================================================

describe('LarkChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when webhook server starts', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('gets bot info on connect', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      await channel.connect();

      const mockClient = currentClient();
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
        }),
      );
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ content: JSON.stringify({ text: 'Hello everyone' }) });
      await triggerMessageEvent(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.any(String),
        undefined,
        'lark',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          id: 'om_test_msg_001',
          chat_jid: 'lark:oc_test123',
          sender: 'ou_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ chatId: 'oc_unregistered' });
      await triggerMessageEvent(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_unregistered',
        expect.any(String),
        undefined,
        'lark',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips unsupported message types', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ messageType: 'share_calendar' });
      await triggerMessageEvent(data);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('skips messages with no content text', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ content: JSON.stringify({ text: '' }) });
      await triggerMessageEvent(data);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages with invalid JSON content', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ content: 'not-json' });
      await triggerMessageEvent(data);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by matching bot open_id', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        senderOpenId: 'ou_BOT_123',
        content: JSON.stringify({ text: 'Bot response' }),
      });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('identifies p2p chat as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'lark:oc_dm123': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        chatId: 'oc_dm123',
        chatType: 'p2p',
      });
      await triggerMessageEvent(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'lark:oc_dm123',
        expect.any(String),
        undefined,
        'lark',
        false,
      );
    });

    it('converts create_time to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ createTime: '1704067200000' });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('deduplicates messages by message_id', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ messageId: 'om_dup_001' });
      await triggerMessageEvent(data);
      await triggerMessageEvent(data); // duplicate

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('handles messages with no message data gracefully', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const handler = (LarkSdk as any).__getMessageHandler();
      await handler({}); // no message field

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('replaces bot mention placeholder with trigger name', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        content: JSON.stringify({ text: 'Hey @_user_1 what do you think?' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_BOT_123' }, name: 'Jonesy' },
        ],
      });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          content: '@Jonesy Hey @Jonesy what do you think?',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        content: JSON.stringify({ text: '@_user_1 look at this' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_OTHER_USER' }, name: 'Alice' },
        ],
      });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          content: '@_user_1 look at this',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        senderOpenId: 'ou_BOT_123',
        content: JSON.stringify({ text: '@_user_1 echo' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_BOT_123' }, name: 'Jonesy' },
        ],
      });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          content: '@_user_1 echo',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_BOT_123' }, name: 'Jonesy' },
        ],
      });
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          content: '@Jonesy hello',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends interactive card via im.message.create', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      mockClient.im.v1.message.create.mockClear();
      await channel.sendMessage('lark:oc_test123', 'Hello');

      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'oc_test123',
            msg_type: 'interactive',
          }),
        }),
      );
      // Verify the card JSON structure
      const callData = mockClient.im.v1.message.create.mock.calls[0][0].data;
      const cardJson = JSON.parse(callData.content);
      expect(cardJson.config).toEqual({ wide_screen_mode: true });
      expect(cardJson.elements).toEqual([
        { tag: 'markdown', content: 'Hello' },
      ]);
    });

    it('strips lark: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      mockClient.im.v1.message.create.mockClear();
      await channel.sendMessage('lark:oc_other456', 'Message');

      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_other456',
          }),
        }),
      );
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Queued message');

      expect(mockClient.im.v1.message.create).not.toHaveBeenCalled();
    });

    it('queues message when send fails', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      mockClient.im.v1.message.create
        .mockClear()
        .mockRejectedValueOnce(new Error('API error'));

      // Should not throw
      await expect(
        channel.sendMessage('lark:oc_test123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('replies when replyToMessageId is provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      mockClient.im.v1.message.create.mockClear();
      await channel.sendMessage('lark:oc_test123', 'Reply text', {
        replyToMessageId: 'om_trigger_msg_001',
      });

      // Card sent as reply
      expect(mockClient.im.v1.message.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'om_trigger_msg_001' },
          data: expect.objectContaining({
            msg_type: 'interactive',
          }),
        }),
      );
      expect(mockClient.im.v1.message.create).not.toHaveBeenCalled();
    });

    it('prepends @mention to card text when mentionUser is provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Hello there', {
        replyToMessageId: 'om_trigger_msg_010',
        mentionUser: { id: 'ou_USER_456', name: 'Alice' },
      });

      // Card content includes mention prefix
      const callData = mockClient.im.v1.message.reply.mock.calls[0][0].data;
      const cardJson = JSON.parse(callData.content);
      expect(cardJson.elements[0].content).toContain('<at user_id="ou_USER_456">');
      expect(cardJson.elements[0].content).toContain('Hello there');
    });

    it('does not use reply when replyToMessageId is not provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      mockClient.im.v1.message.create.mockClear();
      await channel.sendMessage('lark:oc_test123', 'Normal message');

      expect(mockClient.im.v1.message.reply).not.toHaveBeenCalled();
      expect(mockClient.im.v1.message.create).toHaveBeenCalled();
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();

      // Queue messages while disconnected
      await channel.sendMessage('lark:oc_test123', 'First queued');
      await channel.sendMessage('lark:oc_test123', 'Second queued');

      expect(mockClient.im.v1.message.create).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      // Both messages sent as interactive cards
      expect(mockClient.im.v1.message.create).toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns lark: JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('lark:oc_test123')).toBe(true);
    });

    it('owns lark: chat JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('lark:oc_abcdef')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Slack JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChatMetadata ---

  describe('syncChatMetadata', () => {
    it('calls chat.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      mockClient.im.v1.chat.list.mockResolvedValue({
        data: {
          items: [
            { chat_id: 'oc_001', name: 'General' },
            { chat_id: 'oc_002', name: 'Random' },
          ],
        },
      });

      await channel.connect();
      await new Promise((r) => setTimeout(r, 0));

      expect(updateChatNamesBatch).toHaveBeenCalledWith([
        { jid: 'lark:oc_001', name: 'General' },
        { jid: 'lark:oc_002', name: 'Random' },
      ]);
    });

    it('skips chats without chat_id or name', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      mockClient.im.v1.chat.list.mockResolvedValue({
        data: {
          items: [
            { chat_id: 'oc_001', name: 'Valid' },
            { chat_id: '', name: 'No ID' },
            { chat_id: 'oc_003' }, // no name
          ],
        },
      });

      await channel.connect();
      await new Promise((r) => setTimeout(r, 0));

      expect(updateChatNamesBatch).toHaveBeenCalledWith([
        { jid: 'lark:oc_001', name: 'Valid' },
      ]);
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      mockClient.im.v1.chat.list.mockRejectedValue(new Error('API error'));

      await channel.connect();
      await new Promise((r) => setTimeout(r, 0));
      await expect(channel.syncChatMetadata()).resolves.toBeUndefined();
    });

    it('paginates through multiple pages of chats', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      mockClient.im.v1.chat.list
        .mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_001', name: 'General' }],
            page_token: 'page2_token',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ chat_id: 'oc_002', name: 'Random' }],
          },
        });

      await channel.connect();
      await new Promise((r) => setTimeout(r, 0));

      expect(mockClient.im.v1.chat.list).toHaveBeenCalledTimes(2);
      expect(updateChatNamesBatch).toHaveBeenCalledWith([
        { jid: 'lark:oc_001', name: 'General' },
        { jid: 'lark:oc_002', name: 'Random' },
      ]);
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when LARK_APP_ID is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: '',
        LARK_APP_SECRET: 'test_secret',
      });

      expect(() => new LarkChannel(createTestOpts())).toThrow(
        'LARK_APP_ID and LARK_APP_SECRET must be set in .env',
      );
    });

    it('throws when LARK_APP_SECRET is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        LARK_APP_ID: 'cli_test_id',
        LARK_APP_SECRET: '',
      });

      expect(() => new LarkChannel(createTestOpts())).toThrow(
        'LARK_APP_ID and LARK_APP_SECRET must be set in .env',
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "lark"', () => {
      const channel = new LarkChannel(createTestOpts());
      expect(channel.name).toBe('lark');
    });
  });
});

// =========================================================================
// Section 3: Standalone helper function tests
// =========================================================================

describe('splitMarkdown', () => {
  it('returns single chunk when text fits', () => {
    const text = 'short text';
    expect(splitMarkdown(text, 100)).toEqual(['short text']);
  });

  it('splits at paragraph boundary (double newline)', () => {
    const text = 'para1\n\npara2\n\npara3';
    const chunks = splitMarkdown(text, 12);
    expect(chunks).toEqual(['para1\n\npara2', 'para3']);
  });

  it('splits at single newline when no paragraph boundary', () => {
    const text = 'line1\nline2\nline3';
    const chunks = splitMarkdown(text, 11);
    expect(chunks).toEqual(['line1\nline2', 'line3']);
  });

  it('hard-cuts when no newline within limit', () => {
    const text = 'A'.repeat(20);
    const chunks = splitMarkdown(text, 8);
    expect(chunks).toEqual(['A'.repeat(8), 'A'.repeat(8), 'A'.repeat(4)]);
  });

  it('returns empty array content for empty string', () => {
    expect(splitMarkdown('', 100)).toEqual(['']);
  });
});

// =========================================================================
// Section 4: Inbound message converter tests
// =========================================================================

describe('inbound message converters', () => {
  let channel: InstanceType<typeof LarkChannel>;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const opts = createTestOpts();
    onMessage = opts.onMessage as ReturnType<typeof vi.fn>;
    channel = new LarkChannel(opts);
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  const sendEvent = async (msgType: string, content: string) => {
    const handler = (LarkSdk as any).__getMessageHandler();
    await handler({
      sender: { sender_id: { open_id: 'ou_user1' } },
      message: {
        message_id: `msg_test_${Date.now()}_${Math.random()}`,
        chat_id: 'oc_test123',
        chat_type: 'group',
        message_type: msgType,
        content,
        create_time: String(Date.now()),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot123' }, name: 'Jonesy' },
        ],
      },
    });
  };

  it('parses system messages with template', async () => {
    const content = JSON.stringify({
      template: '{from_user} added {to_chatters} to the group',
      from_user: ['Alice'],
      to_chatters: ['Bob', 'Charlie'],
    });
    await sendEvent('system', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toBe('Alice added Bob, Charlie to the group');
  });

  it('falls back for system messages without template', async () => {
    await sendEvent('system', '{}');
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toBe('[system message]');
  });

  it('converts folder messages', async () => {
    const content = JSON.stringify({ file_key: 'fk_001', file_name: 'docs' });
    await sendEvent('folder', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toContain('<folder key="fk_001" name="docs"/>');
  });

  it('converts hongbao messages', async () => {
    const content = JSON.stringify({ text: 'Happy New Year' });
    await sendEvent('hongbao', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toContain('<hongbao text="Happy New Year"/>');
  });

  it('converts calendar messages', async () => {
    const content = JSON.stringify({
      summary: 'Team Meeting',
      start_time: '1709712000000',
      end_time: '1709715600000',
    });
    await sendEvent('calendar', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toContain('<calendar_invite>');
    expect(msg.content).toContain('📅 Team Meeting');
  });

  it('converts video_chat messages', async () => {
    const content = JSON.stringify({ topic: 'Standup', start_time: '1709712000000' });
    await sendEvent('video_chat', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toContain('<meeting>');
    expect(msg.content).toContain('📹 Standup');
  });

  it('converts vote messages', async () => {
    const content = JSON.stringify({ topic: 'Lunch?', options: ['Pizza', 'Sushi'] });
    await sendEvent('vote', content);
    expect(onMessage).toHaveBeenCalled();
    const msg = onMessage.mock.calls[0][1];
    expect(msg.content).toContain('<vote>');
    expect(msg.content).toContain('• Pizza');
    expect(msg.content).toContain('• Sushi');
  });
});
