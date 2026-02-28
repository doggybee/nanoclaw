import * as http from 'http';
import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Lark text messages: conservative split limit to stay within API payload size.
const MAX_TEXT_LENGTH = 4000;

// Dedup window: ignore duplicate message_id within this TTL (ms)
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse a single line of text into an array of Lark post elements.
 * Handles:
 * - <at user_id="...">name</at> → {tag: "at", user_id: "..."}
 * - [text](url)                 → {tag: "a", text, href}
 * - **bold**                    → {tag: "text", text, style: ["bold"]}
 * - *italic*                    → {tag: "text", text, style: ["italic"]}
 * - `code`                      → {tag: "text", text, style: ["code"]}
 * - Plain text                  → {tag: "text", text}
 */
function parseLineToElements(line: string): any[] {
  const elements: any[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    // Lark @mention: <at user_id="...">name</at>
    const atMatch = remaining.match(/^<at user_id="([^"]+)">([^<]*)<\/at>/);
    if (atMatch) {
      elements.push({ tag: 'at', user_id: atMatch[1], user_name: atMatch[2] });
      remaining = remaining.slice(atMatch[0].length);
      continue;
    }

    // Markdown links: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      elements.push({ tag: 'a', text: linkMatch[1], href: linkMatch[2] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      elements.push({ tag: 'text', text: codeMatch[1], style: ['code'] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold: **text**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      elements.push({ tag: 'text', text: boldMatch[1], style: ['bold'] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* (but not **)
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      elements.push({ tag: 'text', text: italicMatch[1], style: ['italic'] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text: consume until next special character
    const plainMatch = remaining.match(/^([^*`\[<]+)/);
    if (plainMatch) {
      elements.push({ tag: 'text', text: plainMatch[1] });
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Fallback: consume one character
    elements.push({ tag: 'text', text: remaining[0] });
    remaining = remaining.slice(1);
  }

  return elements;
}

/**
 * Convert markdown text to Lark post message content structure.
 * Post messages are rich text (NOT cards).
 *
 * Supported: text (with bold/italic/code styles), a (links), at (@mentions).
 * Headings (# ...) → bold text.
 * Fenced code blocks (```) → preserved as plain text lines.
 */
export function markdownToPostContent(text: string): any {
  const lines = text.split('\n');
  const content: any[][] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Fenced code block toggle: ```
    // Post format has no code_block tag, so preserve raw text as-is.
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      content.push([{ tag: 'text', text: line }]);
      continue;
    }

    // Inside code block: emit raw text without markdown parsing
    if (inCodeBlock) {
      content.push([{ tag: 'text', text: line }]);
      continue;
    }

    // Heading: "## Title" → bold text
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const headingElements = parseLineToElements(headingMatch[2]);
      // Wrap all elements with bold style
      for (const el of headingElements) {
        if (el.tag === 'text') {
          el.style = el.style ? [...el.style, 'bold'] : ['bold'];
        }
      }
      content.push(headingElements);
      continue;
    }

    // Empty line → paragraph break
    if (line.length === 0) {
      content.push([{ tag: 'text', text: '' }]);
      continue;
    }

    const elements = parseLineToElements(line);
    if (elements.length > 0) {
      content.push(elements);
    }
  }

  return {
    zh_cn: { content },
    en_us: { content },
  };
}

/**
 * Split markdown text at paragraph / line boundaries so each chunk
 * fits within maxLen. Falls back to hard-cut if a single paragraph exceeds maxLen.
 */
export function splitMarkdown(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a double-newline (paragraph boundary) within the limit
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx > 0) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2); // skip the \n\n
      continue;
    }

    // Try to split at a single newline within the limit
    splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx > 0) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Hard cut — no good boundary found
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  return chunks;
}

export interface LarkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LarkChannel implements Channel {
  name = 'lark';

  private client: Lark.Client;
  private server: http.Server | undefined;
  private botOpenId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private seenMessages = new Map<string, number>();
  private dedupTimer: ReturnType<typeof setInterval> | undefined;

  private appId: string;
  private appSecret: string;
  private opts: LarkChannelOpts;

  constructor(opts: LarkChannelOpts) {
    this.opts = opts;

    // Read credentials from .env (not process.env — keeps secrets off the
    // environment so they don't leak to child processes)
    const env = readEnvFile([
      'LARK_APP_ID',
      'LARK_APP_SECRET',
      'LARK_ENCRYPT_KEY',
      'LARK_VERIFICATION_TOKEN',
      'LARK_WEBHOOK_PORT',
      'LARK_WEBHOOK_PATH',
    ]);
    this.appId = env.LARK_APP_ID;
    this.appSecret = env.LARK_APP_SECRET;

    if (!this.appId || !this.appSecret) {
      throw new Error(
        'LARK_APP_ID and LARK_APP_SECRET must be set in .env',
      );
    }

    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Lark,
    });

    // Start dedup cleanup timer
    this.dedupTimer = setInterval(() => this.cleanupDedup(), DEDUP_CLEANUP_INTERVAL_MS);
  }

  async connect(): Promise<void> {
    const env = readEnvFile([
      'LARK_ENCRYPT_KEY',
      'LARK_VERIFICATION_TOKEN',
      'LARK_WEBHOOK_PORT',
      'LARK_WEBHOOK_PATH',
    ]);

    const port = parseInt(env.LARK_WEBHOOK_PORT || '3000', 10);
    const webhookPath = env.LARK_WEBHOOK_PATH || '/lark/events';

    // EventDispatcher is transport-agnostic — works with both WSClient and HTTP adapter.
    // Lark international (Domain.Lark) does NOT support WebSocket for events,
    // so we use the Webhook HTTP adapter mode.
    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: env.LARK_ENCRYPT_KEY || undefined,
      verificationToken: env.LARK_VERIFICATION_TOKEN || undefined,
    }).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingMessage(data);
      },
    });

    // Create HTTP webhook handler using Lark SDK adapter
    const webhookHandler = (Lark as any).adaptDefault(
      webhookPath,
      eventDispatcher,
      { autoChallenge: true },
    );

    // Start HTTP server for receiving Lark event callbacks
    this.server = http.createServer((req, res) => {
      if (req.url && !req.url.startsWith(webhookPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      webhookHandler(req, res).catch((err: Error) => {
        logger.error({ err }, 'Lark webhook handler error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(
            { port },
            `Lark webhook port ${port} is already in use`,
          );
        } else {
          logger.error({ err }, 'Lark webhook server error');
        }
        reject(err);
      });
      this.server!.listen(port, () => {
        logger.info(
          { port, webhookPath },
          `Lark webhook server listening on port ${port}, path ${webhookPath}`,
        );
        resolve();
      });
    });

    // Get bot info for self-message detection via raw API call
    // (the SDK doesn't expose bot.v3.botInfo as a typed method)
    try {
      const botInfo = await this.client.request<{ bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: undefined,
      });
      this.botOpenId = (botInfo as { bot?: { open_id?: string } })?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Connected to Lark via Webhook');
    } catch (err) {
      logger.warn(
        { err },
        'Lark webhook started but failed to get bot info',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync chat names on startup
    await this.syncChatMetadata();
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) return;

    const messageId = message.message_id;

    // Dedup by message_id
    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) this.seenMessages.set(messageId, Date.now());

    // Only process text messages
    if (message.message_type !== 'text') return;

    // Parse content JSON: {"text": "..."}
    let textContent: string;
    try {
      const parsed = JSON.parse(message.content);
      textContent = parsed.text;
    } catch {
      return;
    }

    if (!textContent) return;

    const chatId = message.chat_id;
    if (!chatId) return;

    const jid = `lark:${chatId}`;
    const chatType = message.chat_type; // 'p2p' or 'group'
    const isGroup = chatType !== 'p2p';
    const timestamp = new Date(
      parseInt(message.create_time, 10) || Date.now(),
    ).toISOString();

    // Always report metadata for group discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'lark', isGroup);

    // Only deliver full messages for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    // Detect self-messages (sent by our bot)
    const sender = data.sender;
    const senderOpenId = sender?.sender_id?.open_id;
    const isBotMessage = !!(
      this.botOpenId &&
      senderOpenId === this.botOpenId
    );

    const senderName = isBotMessage
      ? ASSISTANT_NAME
      : sender?.sender_id?.open_id || 'unknown';

    // Normalize @mentions: Lark uses @_user_N placeholder in text
    // Replace mentions of our bot with the trigger pattern
    let content = textContent;
    if (!isBotMessage) {
      // Lark @mentions appear as @_user_N in text, with mention details in
      // message.mentions array. Check if our bot is mentioned.
      const mentions = message.mentions as
        | Array<{ key: string; id?: { open_id?: string }; name?: string }>
        | undefined;
      if (mentions && this.botOpenId) {
        for (const mention of mentions) {
          if (mention.id?.open_id === this.botOpenId && mention.key) {
            content = content.replace(mention.key, `@${ASSISTANT_NAME}`);
          }
        }
      }
      // If bot was @mentioned but content doesn't start with trigger, prepend it
      if (
        content !== textContent &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(jid, {
      id: messageId || message.create_time || '',
      chat_jid: jid,
      sender: senderOpenId || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string, opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string } }): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Lark disconnected, message queued',
      );
      return;
    }

    try {
      await this._sendDirect(jid, text, opts?.replyToMessageId, opts?.mentionUser);
    } catch (err) {
      // Fallback: retry as a plain text message (without markdown parsing)
      logger.warn({ jid, err }, 'Send failed, retrying as plain text');
      try {
        const fallbackText = opts?.mentionUser
          ? `<at user_id="${opts.mentionUser.id}">${opts.mentionUser.name}</at> ${text}`
          : text;
        if (opts?.replyToMessageId) {
          await this.client.im.v1.message.reply({
            path: { message_id: opts.replyToMessageId },
            data: {
              content: JSON.stringify({ text: fallbackText }),
              msg_type: 'text',
            },
          });
        } else {
          const chatId = jid.replace(/^lark:/, '');
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text: fallbackText }),
              msg_type: 'text',
            },
          });
        }
        logger.info({ jid, length: text.length }, 'Lark message sent (text fallback)');
      } catch (fallbackErr) {
        this.outgoingQueue.push({ jid, text });
        logger.warn(
          { jid, err: fallbackErr, queueSize: this.outgoingQueue.length },
          'Failed to send Lark message, queued',
        );
      }
    }
  }

  /**
   * Core send logic: split long text and send as post (rich text) messages with markdown support.
   * When replyToMessageId is provided, the first chunk is sent as a reply
   * (quote-reply) to that message; subsequent chunks use message.create.
   * When mentionUser is provided, the first chunk is prefixed with an @mention.
   */
  private async _sendDirect(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
  ): Promise<void> {
    const chatId = jid.replace(/^lark:/, '');
    const chunks = splitMarkdown(text, MAX_TEXT_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      // Prepend @mention to the first chunk only
      const chunkText = i === 0 && mentionUser
        ? `<at user_id="${mentionUser.id}">${mentionUser.name}</at> ${chunks[i]}`
        : chunks[i];

      // Convert markdown to post message content
      const postContent = markdownToPostContent(chunkText);
      const content = JSON.stringify(postContent);

      if (i === 0 && replyToMessageId) {
        await this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post' },
        });
      } else {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content, msg_type: 'post' },
        });
      }
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Lark message sent (post with markdown)');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('lark:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = undefined;
    }
    if (this.server) {
      this.server.closeAllConnections();
      this.server.close();
      this.server = undefined;
    }
  }

  // Lark does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Lark Bot API has no typing indicator endpoint
  }

  async addReaction(_jid: string, messageId: string, emojiType: string): Promise<void> {
    await this.client.request({
      method: 'POST',
      url: `/open-apis/im/v1/messages/${messageId}/reactions`,
      data: { reaction_type: { emoji_type: emojiType } },
    });
    logger.info({ messageId, emojiType }, 'Lark reaction added');
  }

  /**
   * Sync chat metadata from Lark.
   * Fetches chats the bot is a member of and stores their names in the DB.
   */
  async syncChatMetadata(): Promise<void> {
    try {
      logger.info('Syncing chat metadata from Lark...');
      let pageToken: string | undefined;
      let count = 0;

      do {
        const result = await this.client.im.v1.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        const items = result?.data?.items || [];
        for (const chat of items) {
          if (chat.chat_id && chat.name) {
            updateChatName(`lark:${chat.chat_id}`, chat.name);
            count++;
          }
        }

        pageToken = result?.data?.page_token || undefined;
      } while (pageToken);

      logger.info({ count }, 'Lark chat metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Lark chat metadata');
    }
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Lark outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this._sendDirect(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
