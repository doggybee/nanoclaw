import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock http module — capture the request handler from createServer
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
      // Create fresh mocks per instance (same pattern as Slack test's MockApp)
      request = vi.fn().mockResolvedValue({
        bot: { open_id: 'ou_BOT_123' },
      });
      im = {
        v1: {
          message: {
            create: vi.fn().mockResolvedValue(undefined),
            reply: vi.fn().mockResolvedValue(undefined),
          },
          chat: {
            list: vi.fn().mockResolvedValue({ data: { items: [] } }),
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
    adaptDefault: vi.fn(
      (_path: string, dispatcher: any, _opts: any) => {
        // Return a mock webhook handler that passes through to the dispatcher handler
        return async (_req: any, _res: any) => {
          // The actual adaptDefault parses HTTP body and calls dispatcher.
          // In tests we trigger events directly via __getMessageHandler().
        };
      },
    ),
    Domain: { Lark: 'https://open.larksuite.com' },
    LoggerLevel: { error: 'error', info: 'info' },
    __getMessageHandler: () => messageHandler,
  };
});

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    LARK_APP_ID: 'cli_test_app_id',
    LARK_APP_SECRET: 'test_app_secret',
    LARK_ENCRYPT_KEY: '',
    LARK_VERIFICATION_TOKEN: '',
    LARK_WEBHOOK_PORT: '3000',
    LARK_WEBHOOK_PATH: '/lark/events',
  }),
}));

import { LarkChannel, LarkChannelOpts, markdownToPostContent, splitMarkdown } from './lark.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import * as LarkSdk from '@larksuiteoapi/node-sdk';

// --- Test helpers ---

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

// --- Tests ---

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

    it('skips non-text message types', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const data = createMessageData({ messageType: 'image' });
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
        false, // p2p is not a group
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

      // Mention replaced and trigger prepended since content doesn't start with trigger
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

      // Bot messages skip mention translation
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
      // After replacement: "@Jonesy hello" — already matches TRIGGER_PATTERN
      await triggerMessageEvent(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'lark:oc_test123',
        expect.objectContaining({
          // Should not double-prepend since "@Jonesy hello" already matches trigger
          content: '@Jonesy hello',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message as post with markdown support', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Hello');

      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify(markdownToPostContent('Hello')),
          msg_type: 'post',
        },
      });
    });

    it('strips lark: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_other456', 'Message');

      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_other456',
            msg_type: 'post',
          }),
        }),
      );
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      // Don't connect — should queue
      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Queued message');

      expect(mockClient.im.v1.message.create).not.toHaveBeenCalled();
    });

    it('queues message when both send attempts fail', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      // First call fails, fallback retry also fails
      mockClient.im.v1.message.create
        .mockRejectedValueOnce(new Error('Send error'))
        .mockRejectedValueOnce(new Error('Retry error'));

      // Should not throw
      await expect(
        channel.sendMessage('lark:oc_test123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('retries as single unsplit message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      // First call fails, fallback retry succeeds
      mockClient.im.v1.message.create
        .mockRejectedValueOnce(new Error('Send error'))
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('lark:oc_test123', 'Retry message');

      // Second call is the fallback retry
      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(2);
      expect(mockClient.im.v1.message.create).toHaveBeenNthCalledWith(2, {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ text: 'Retry message' }),
          msg_type: 'text',
        },
      });
    });

    it('splits long messages into multiple post messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      // Create a message longer than 4000 chars (no newlines → hard cut)
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('lark:oc_test123', longText);

      // Should be split into 2 post messages: 4000 + 500
      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(2);
      expect(mockClient.im.v1.message.create).toHaveBeenNthCalledWith(1, {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify(markdownToPostContent('A'.repeat(4000))),
          msg_type: 'post',
        },
      });
      expect(mockClient.im.v1.message.create).toHaveBeenNthCalledWith(2, {
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify(markdownToPostContent('A'.repeat(500))),
          msg_type: 'post',
        },
      });
    });

    it('sends exactly-4000-char messages as a single post message', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      const text = 'B'.repeat(4000);
      await channel.sendMessage('lark:oc_test123', text);

      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'post' }),
        }),
      );
    });

    it('splits messages into 3 when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      const longText = 'C'.repeat(8500);
      await channel.sendMessage('lark:oc_test123', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(3);
    });

    it('replies to message when replyToMessageId is provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Reply text', {
        replyToMessageId: 'om_trigger_msg_001',
      });

      expect(mockClient.im.v1.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_trigger_msg_001' },
        data: {
          content: JSON.stringify(markdownToPostContent('Reply text')),
          msg_type: 'post',
        },
      });
      expect(mockClient.im.v1.message.create).not.toHaveBeenCalled();
    });

    it('replies first chunk and creates subsequent chunks for long messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('lark:oc_test123', longText, {
        replyToMessageId: 'om_trigger_msg_002',
      });

      // First chunk: reply
      expect(mockClient.im.v1.message.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.im.v1.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_trigger_msg_002' },
        data: {
          content: JSON.stringify(markdownToPostContent('A'.repeat(4000))),
          msg_type: 'post',
        },
      });

      // Second chunk: create
      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(1);
      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify(markdownToPostContent('A'.repeat(500))),
          msg_type: 'post',
        },
      });
    });

    it('prepends @mention to first chunk when mentionUser is provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Hello there', {
        replyToMessageId: 'om_trigger_msg_010',
        mentionUser: { id: 'ou_USER_456', name: 'Alice' },
      });

      expect(mockClient.im.v1.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_trigger_msg_010' },
        data: {
          content: JSON.stringify(markdownToPostContent('<at user_id="ou_USER_456">Alice</at> Hello there')),
          msg_type: 'post',
        },
      });
    });

    it('only prepends @mention to first chunk of split messages', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('lark:oc_test123', longText, {
        replyToMessageId: 'om_trigger_msg_011',
        mentionUser: { id: 'ou_USER_456', name: 'Alice' },
      });

      // First chunk: reply with @mention
      expect(mockClient.im.v1.message.reply).toHaveBeenCalledWith({
        path: { message_id: 'om_trigger_msg_011' },
        data: {
          content: JSON.stringify(markdownToPostContent('<at user_id="ou_USER_456">Alice</at> ' + 'A'.repeat(4000))),
          msg_type: 'post',
        },
      });

      // Second chunk: create without @mention
      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify(markdownToPostContent('A'.repeat(500))),
          msg_type: 'post',
        },
      });
    });

    it('does not use reply when replyToMessageId is not provided', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      await channel.sendMessage('lark:oc_test123', 'Normal message');

      expect(mockClient.im.v1.message.reply).not.toHaveBeenCalled();
      expect(mockClient.im.v1.message.create).toHaveBeenCalledTimes(1);
    });

    it('retries reply on send failure', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);
      await channel.connect();

      const mockClient = currentClient();
      // First reply fails, fallback reply succeeds
      mockClient.im.v1.message.reply
        .mockRejectedValueOnce(new Error('Send error'))
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('lark:oc_test123', 'Fallback reply', {
        replyToMessageId: 'om_trigger_msg_003',
      });

      // Second call to reply is the fallback retry
      expect(mockClient.im.v1.message.reply).toHaveBeenCalledTimes(2);
      expect(mockClient.im.v1.message.reply).toHaveBeenNthCalledWith(2, {
        path: { message_id: 'om_trigger_msg_003' },
        data: {
          content: JSON.stringify({ text: 'Fallback reply' }),
          msg_type: 'text',
        },
      });
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

      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify(markdownToPostContent('First queued')),
            msg_type: 'post',
          }),
        }),
      );
      expect(mockClient.im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify(markdownToPostContent('Second queued')),
            msg_type: 'post',
          }),
        }),
      );
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
      await channel.syncChatMetadata();

      expect(updateChatName).toHaveBeenCalledWith('lark:oc_001', 'General');
      expect(updateChatName).toHaveBeenCalledWith('lark:oc_002', 'Random');
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

      // connect() calls syncChatMetadata() internally
      await channel.connect();

      expect(updateChatName).toHaveBeenCalledWith('lark:oc_001', 'Valid');
      expect(updateChatName).toHaveBeenCalledTimes(1);
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      const mockClient = currentClient();
      mockClient.im.v1.chat.list.mockRejectedValue(new Error('API error'));

      await channel.connect();
      // Should not throw
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

      // connect() calls syncChatMetadata() internally — consumes both pages
      await channel.connect();

      expect(mockClient.im.v1.chat.list).toHaveBeenCalledTimes(2);
      expect(updateChatName).toHaveBeenCalledWith('lark:oc_001', 'General');
      expect(updateChatName).toHaveBeenCalledWith('lark:oc_002', 'Random');
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      await expect(
        channel.setTyping('lark:oc_test123', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new LarkChannel(opts);

      await expect(
        channel.setTyping('lark:oc_test123', false),
      ).resolves.toBeUndefined();
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

// --- Standalone helper function tests ---

describe('markdownToPostContent', () => {
  it('converts plain text to post content structure', () => {
    const result = markdownToPostContent('Hello world');
    expect(result).toEqual({
      zh_cn: { content: [[{ tag: 'text', text: 'Hello world' }]] },
      en_us: { content: [[{ tag: 'text', text: 'Hello world' }]] },
    });
  });

  it('converts bold text with ** and style', () => {
    const result = markdownToPostContent('**bold text**');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'bold text', style: ['bold'] }],
    ]);
  });

  it('converts italic text with * and style', () => {
    const result = markdownToPostContent('*italic text*');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'italic text', style: ['italic'] }],
    ]);
  });

  it('converts inline code with backticks and style', () => {
    const result = markdownToPostContent('`code block`');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'code block', style: ['code'] }],
    ]);
  });

  it('converts markdown links to a tags', () => {
    const result = markdownToPostContent('[click here](https://example.com)');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'a', text: 'click here', href: 'https://example.com' }],
    ]);
  });

  it('converts mixed inline formatting', () => {
    const result = markdownToPostContent('Normal **bold** and `code`');
    expect(result.zh_cn.content).toEqual([
      [
        { tag: 'text', text: 'Normal ' },
        { tag: 'text', text: 'bold', style: ['bold'] },
        { tag: 'text', text: ' and ' },
        { tag: 'text', text: 'code', style: ['code'] },
      ],
    ]);
  });

  it('handles multiple lines', () => {
    const result = markdownToPostContent('Line 1\nLine 2\nLine 3');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'Line 1' }],
      [{ tag: 'text', text: 'Line 2' }],
      [{ tag: 'text', text: 'Line 3' }],
    ]);
  });

  it('preserves empty lines as paragraph breaks', () => {
    const result = markdownToPostContent('Para 1\n\nPara 2');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'Para 1' }],
      [{ tag: 'text', text: '' }],
      [{ tag: 'text', text: 'Para 2' }],
    ]);
  });

  it('parses Lark <at> tags into proper at elements', () => {
    const result = markdownToPostContent('<at user_id="ou_123">Alice</at> hello');
    expect(result.zh_cn.content[0]).toEqual([
      { tag: 'at', user_id: 'ou_123', user_name: 'Alice' },
      { tag: 'text', text: ' hello' },
    ]);
  });

  it('converts headings to bold text', () => {
    const result = markdownToPostContent('## Section Title');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: 'Section Title', style: ['bold'] }],
    ]);
  });

  it('preserves fenced code blocks as raw text', () => {
    const result = markdownToPostContent('```python\nprint("hello")\nx = 1\n```');
    expect(result.zh_cn.content).toEqual([
      [{ tag: 'text', text: '```python' }],
      [{ tag: 'text', text: 'print("hello")' }],
      [{ tag: 'text', text: 'x = 1' }],
      [{ tag: 'text', text: '```' }],
    ]);
  });
});

describe('splitMarkdown', () => {
  it('returns single chunk when text fits', () => {
    const text = 'short text';
    expect(splitMarkdown(text, 100)).toEqual(['short text']);
  });

  it('splits at paragraph boundary (double newline)', () => {
    const text = 'para1\n\npara2\n\npara3';
    // maxLen=12: "para1\n\npara2" is 12 chars, fits
    const chunks = splitMarkdown(text, 12);
    expect(chunks).toEqual(['para1\n\npara2', 'para3']);
  });

  it('splits at single newline when no paragraph boundary', () => {
    const text = 'line1\nline2\nline3';
    // maxLen=11: "line1\nline2" is 11 chars, fits
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

