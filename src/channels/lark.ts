import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  ChatHistoryMessage,
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

export type OnCardAction = (chatJid: string, action: {
  actionId: string;
  value?: Record<string, string>;
  userId: string;
  messageId?: string;
}) => void;

export interface LarkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onCardAction?: OnCardAction;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Streaming card element ID
const STREAMING_ELEMENT_ID = 'streaming_md';

interface StreamingCard {
  cardId: string;
  accumulatedText: string;
  sequence: number;
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
  private streamingCards = new Map<string, StreamingCard>();

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

    // Card action handler for interactive card callbacks
    const cardActionPath = env.LARK_WEBHOOK_PATH
      ? `${env.LARK_WEBHOOK_PATH.replace(/\/$/, '')}/card`
      : '/lark/card';
    const cardActionHandler = new Lark.CardActionHandler(
      {
        encryptKey: env.LARK_ENCRYPT_KEY || undefined,
        verificationToken: env.LARK_VERIFICATION_TOKEN || undefined,
      },
      async (data: any) => {
        await this.handleCardAction(data);
        // Return empty to acknowledge without updating card
        return undefined as any;
      },
    );

    // Create HTTP webhook handler using Lark SDK adapter
    const webhookHandler = (Lark as any).adaptDefault(
      webhookPath,
      eventDispatcher,
      { autoChallenge: true },
    );
    const cardWebhookHandler = (Lark as any).adaptDefault(
      cardActionPath,
      cardActionHandler,
      { autoChallenge: true },
    );

    // Start HTTP server for receiving Lark event callbacks and card actions
    this.server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith(cardActionPath)) {
        cardWebhookHandler(req, res).catch((err: Error) => {
          logger.error({ err }, 'Lark card action handler error');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        });
        return;
      }
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
    logger.info({ messageId, messageType: message.message_type, content: message.content?.slice?.(0, 200) }, 'Incoming Lark message');

    // Dedup by message_id
    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) this.seenMessages.set(messageId, Date.now());

    const messageType = message.message_type; // 'text', 'image', 'file', 'post'
    // Only process text, image, file, and post (rich text with images) messages
    if (!['text', 'image', 'file', 'post'].includes(messageType)) return;

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

    // --- Extract content and embedded image keys based on message type ---
    let content = '';
    let hasTrigger = false;
    const embeddedImageKeys: string[] = [];

    if (messageType === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        content = parsed.text || '';
      } catch {
        return;
      }
    } else if (messageType === 'image') {
      try {
        const parsed = JSON.parse(message.content);
        content = `[image:${parsed.image_key}]`;
        embeddedImageKeys.push(parsed.image_key);
      } catch {
        return;
      }
    } else if (messageType === 'file') {
      try {
        const parsed = JSON.parse(message.content);
        content = `[file:${parsed.file_key}:${parsed.file_name || 'unknown'}]`;
      } catch {
        return;
      }
    } else if (messageType === 'post') {
      // Rich text: extract text and image_keys from nested content array
      try {
        const parsed = JSON.parse(message.content);
        // Post content structure: { title, content: [[{tag, ...}]] }
        const rows = parsed.content as Array<Array<{ tag: string; text?: string; image_key?: string; user_id?: string }>>;
        const textParts: string[] = [];
        if (parsed.title) textParts.push(parsed.title);
        for (const row of rows || []) {
          for (const el of row) {
            if (el.tag === 'text' && el.text) {
              textParts.push(el.text);
            } else if (el.tag === 'at' && el.user_id) {
              textParts.push(el.user_id); // @_user_N placeholder
            } else if (el.tag === 'img' && el.image_key) {
              embeddedImageKeys.push(el.image_key);
            }
          }
        }
        content = textParts.join('');
      } catch {
        return;
      }
    }

    if (!content && embeddedImageKeys.length === 0) return;

    // Normalize @mentions: Lark uses @_user_N placeholder in text
    // Replace mentions of our bot with the trigger pattern
    if (!isBotMessage) {
      const mentions = message.mentions as
        | Array<{ key: string; id?: { open_id?: string }; name?: string }>
        | undefined;
      if (mentions && this.botOpenId) {
        for (const mention of mentions) {
          if (mention.id?.open_id === this.botOpenId && mention.key) {
            content = content.replace(mention.key, `@${ASSISTANT_NAME}`);
            hasTrigger = true;
          }
        }
      }
      if (
        hasTrigger &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // For media messages without trigger, check if group requires trigger
    const hasMedia = embeddedImageKeys.length > 0 || messageType === 'file';
    const group = groups[jid];
    if (hasMedia && !hasTrigger && !content) {
      if (group?.requiresTrigger !== false) {
        return;
      }
    }

    // Download images/files when triggered (or in non-trigger groups)
    if (embeddedImageKeys.length > 0 && (hasTrigger || group?.requiresTrigger === false)) {
      try {
        const groupFolder = group?.folder || 'main';
        const tmpDir = path.join(process.cwd(), 'groups', groupFolder, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });

        const downloadedPaths: string[] = [];
        for (const imageKey of embeddedImageKeys) {
          const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
          const destPath = path.join(tmpDir, filename);

          const resp = await this.client.im.v1.messageResource.get({
            path: { message_id: messageId, file_key: imageKey },
            params: { type: 'image' },
          });

          if (resp) {
            await resp.writeFile(destPath);
            try { fs.chownSync(destPath, 1000, 1000); } catch { /* non-root */ }
            downloadedPaths.push(`/workspace/group/tmp/${filename}`);
            logger.info({ jid, imageKey, destPath }, 'Image downloaded for agent');
          }
        }

        if (downloadedPaths.length > 0) {
          const imageRef = downloadedPaths.length === 1
            ? `[User sent an image. File saved at: ${downloadedPaths[0]} — use the Read tool to view it]`
            : `[User sent ${downloadedPaths.length} images. Files saved at: ${downloadedPaths.join(', ')} — use the Read tool to view them]`;
          // Prepend trigger if not already present
          content = content
            ? `${content}\n${imageRef}`
            : `@${ASSISTANT_NAME} ${imageRef}`;
        }
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to download image');
      }
    }

    if (messageType === 'file' && (hasTrigger || group?.requiresTrigger === false)) {
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        const fileName = parsed.file_name || `file_${Date.now()}`;
        const groupFolder = group?.folder || 'main';
        const tmpDir = path.join(process.cwd(), 'groups', groupFolder, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const destPath = path.join(tmpDir, fileName);

        const resp = await this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: 'file' },
        });

        if (resp) {
          await resp.writeFile(destPath);
          try { fs.chownSync(destPath, 1000, 1000); } catch { /* non-root */ }
          content = content
            ? `${content}\n[User sent a file: ${fileName}. File saved at: /workspace/group/tmp/${fileName} — use the Read tool to view it]`
            : `@${ASSISTANT_NAME} [User sent a file: ${fileName}. File saved at: /workspace/group/tmp/${fileName} — use the Read tool to view it]`;
          logger.info({ jid, fileKey, destPath }, 'File downloaded for agent');
        }
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to download file');
      }
    }

    if (!content) return;

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

  private async handleCardAction(data: any): Promise<void> {
    try {
      const action = data?.action;
      const operatorId = data?.operator?.open_id;
      // Schema 2.0 uses open_chat_id at top level; also check context.open_chat_id
      const chatId = data?.open_chat_id || data?.context?.open_chat_id;
      const messageId = data?.open_message_id || data?.context?.open_message_id;

      if (!action || !operatorId) return;

      const actionTag = action.tag; // 'button', 'select_static', etc.
      // Schema 2.0 behaviors put value in action.value; also check action.behaviors
      const actionValue = action.value || {};
      const actionId = actionValue.action_id || action.name || actionTag;

      logger.info(
        { actionId, actionTag, operatorId, chatId, messageId },
        'Card action received',
      );

      if (chatId && this.opts.onCardAction) {
        const jid = `lark:${chatId}`;
        this.opts.onCardAction(jid, {
          actionId,
          value: actionValue,
          userId: operatorId,
          messageId,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error handling card action');
    }
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
      await this._sendStreaming(jid, text, opts?.replyToMessageId, opts?.mentionUser);
    } catch (err) {
      logger.warn({ jid, err }, 'Streaming card send failed, falling back to post');
      try {
        await this._sendPostFallback(jid, text, opts?.replyToMessageId, opts?.mentionUser);
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
   * Send or append text via streaming card.
   * First call for a jid: creates card entity, sends it, pushes initial text.
   * Subsequent calls: appends text to the same card with typewriter effect.
   */
  private async _sendStreaming(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
  ): Promise<void> {
    const existing = this.streamingCards.get(jid);

    if (existing) {
      // Replace with latest full text (API calculates diff for typewriter effect)
      existing.accumulatedText = text;
      existing.sequence++;
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: existing.cardId, element_id: STREAMING_ELEMENT_ID },
        data: { content: text, sequence: existing.sequence },
      });
      logger.info({ jid, cardId: existing.cardId, length: text.length }, 'Streaming card text updated');
    } else {
      // Create new streaming card
      const mentionPrefix = mentionUser
        ? `<at id=${mentionUser.id}></at> `
        : '';

      const cardJson = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          summary: { content: '' },
          streaming_config: {
            print_frequency_ms: { default: 50 },
            print_step: { default: 2 },
            print_strategy: 'fast',
          },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: ' ',
            element_id: STREAMING_ELEMENT_ID,
          }],
        },
      };

      const createResult = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardJson),
        },
      });

      const cardId = createResult?.data?.card_id;
      if (!cardId) throw new Error('Failed to create card entity');

      // Send the card as a message
      const chatId = jid.replace(/^lark:/, '');
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });

      if (replyToMessageId) {
        await this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'interactive' },
        });
      } else {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content, msg_type: 'interactive' },
        });
      }

      const fullText = mentionPrefix + text;
      this.streamingCards.set(jid, { cardId, accumulatedText: fullText, sequence: 1 });

      // Push initial text with typewriter effect
      await this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAMING_ELEMENT_ID },
        data: { content: fullText, sequence: 1 },
      });

      logger.info({ jid, cardId, length: fullText.length }, 'Streaming card created and sent');
    }
  }

  /**
   * End the streaming session for a chat: disable streaming mode and clean up.
   */
  async endStreaming(jid: string): Promise<void> {
    const card = this.streamingCards.get(jid);
    if (!card) return;

    try {
      card.sequence++;
      await this.client.cardkit.v1.card.settings({
        path: { card_id: card.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: card.sequence,
        },
      });
      logger.info({ jid, cardId: card.cardId }, 'Streaming mode disabled');
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to disable streaming mode');
    }
    this.streamingCards.delete(jid);
  }

  /**
   * Fallback: send as post (rich text) messages when streaming card fails.
   */
  private async _sendPostFallback(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
  ): Promise<void> {
    const chatId = jid.replace(/^lark:/, '');
    const chunks = splitMarkdown(text, MAX_TEXT_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = i === 0 && mentionUser
        ? `<at user_id="${mentionUser.id}">${mentionUser.name}</at> ${chunks[i]}`
        : chunks[i];

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
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Lark message sent (post fallback)');
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

  /**
   * Send an interactive card with buttons/selects.
   * cardJson should be a Lark Card JSON schema 2.0 object.
   */
  async sendCard(jid: string, cardJson: object, replyToMessageId?: string): Promise<void> {
    const chatId = jid.replace(/^lark:/, '');

    const createResult = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });
    const cardId = createResult?.data?.card_id;
    if (!cardId) throw new Error('Failed to create interactive card');

    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });

    if (replyToMessageId) {
      await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'interactive' },
      });
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'interactive' },
      });
    }
    logger.info({ jid, cardId }, 'Lark interactive card sent');
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
   * Send an image file to a chat.
   * Uploads the image first via im.v1.image.create, then sends it as a message.
   */
  async sendImage(jid: string, imagePath: string, replyToMessageId?: string): Promise<void> {
    const imageData = fs.readFileSync(imagePath);
    const uploadResp = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: Buffer.from(imageData),
      },
    });

    const imageKey = uploadResp?.image_key;
    if (!imageKey) throw new Error('Failed to upload image');

    const chatId = jid.replace(/^lark:/, '');
    const content = JSON.stringify({ image_key: imageKey });

    if (replyToMessageId) {
      await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'image' },
      });
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'image' },
      });
    }
    logger.info({ jid, imagePath, imageKey }, 'Lark image sent');
  }

  /**
   * Send a file to a chat.
   * Uploads the file first via im.v1.file.create, then sends it as a message.
   */
  async sendFile(jid: string, filePath: string, replyToMessageId?: string): Promise<void> {
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    // Determine file type from extension
    const ext = path.extname(fileName).toLowerCase();
    type LarkFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    const fileTypeMap: Record<string, LarkFileType> = {
      '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
      '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
      '.mp4': 'mp4',
    };
    const fileType: LarkFileType = fileTypeMap[ext] || 'stream';

    const uploadResp = await this.client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: Buffer.from(fileData),
      },
    });

    const fileKey = uploadResp?.file_key;
    if (!fileKey) throw new Error('Failed to upload file');

    const chatId = jid.replace(/^lark:/, '');
    const content = JSON.stringify({ file_key: fileKey });

    if (replyToMessageId) {
      await this.client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'file' },
      });
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'file' },
      });
    }
    logger.info({ jid, filePath, fileKey }, 'Lark file sent');
  }

  /**
   * Edit a previously sent bot message. Supports both card messages (via CardKit)
   * and text/post messages (via message.patch).
   */
  async editMessage(_jid: string, messageId: string, text: string): Promise<void> {
    // Try CardKit path first: convert message_id → card_id, then update the card element.
    try {
      const convertResult = await this.client.cardkit.v1.card.idConvert({
        data: { message_id: messageId },
      });
      const cardId = convertResult?.data?.card_id;
      if (cardId) {
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: STREAMING_ELEMENT_ID },
          data: { content: text, sequence: Date.now() },
        });
        logger.info({ messageId, cardId, length: text.length }, 'Lark card message edited');
        return;
      }
    } catch {
      // Not a card message or conversion failed — fall through to message.patch
    }

    // Fallback: edit text/post messages via im.v1.message.patch
    const postContent = markdownToPostContent(text);
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(postContent),
      },
    });
    logger.info({ messageId, length: text.length }, 'Lark message edited');
  }

  /**
   * Fetch recent chat history from Lark API.
   * Returns messages in reverse chronological order (newest first).
   */
  async getChatHistory(jid: string, count: number, beforeTimestamp?: string): Promise<ChatHistoryMessage[]> {
    const chatId = jid.replace(/^lark:/, '');
    const endTime = beforeTimestamp
      ? String(Math.floor(new Date(beforeTimestamp).getTime() / 1000))
      : undefined;

    const result = await this.client.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: Math.min(count, 50),
        sort_type: 'ByCreateTimeDesc',
        ...(endTime ? { end_time: endTime } : {}),
      },
    });

    const items = result?.data?.items || [];
    return items.map((item) => {
      let content = '';
      try {
        if (item.body?.content) {
          const parsed = JSON.parse(item.body.content);
          if (typeof parsed === 'string') {
            content = parsed;
          } else if (parsed.text) {
            content = parsed.text;
          } else if (parsed.content) {
            // post type: extract text from nested structure
            content = this.extractPostText(parsed.content);
          } else {
            content = JSON.stringify(parsed);
          }
        }
      } catch {
        content = item.body?.content || '';
      }

      return {
        message_id: item.message_id || '',
        sender_id: item.sender?.id || '',
        sender_type: item.sender?.sender_type || 'unknown',
        msg_type: item.msg_type || 'unknown',
        content,
        create_time: item.create_time
          ? new Date(Number(item.create_time) * 1000).toISOString()
          : '',
      };
    });
  }

  /** Extract plain text from a Lark post content structure. */
  private extractPostText(content: any[][]): string {
    if (!Array.isArray(content)) return '';
    return content
      .map((line) =>
        (Array.isArray(line) ? line : [])
          .map((el: any) => {
            if (el.tag === 'text') return el.text || '';
            if (el.tag === 'at') return `@${el.user_name || el.user_id || ''}`;
            if (el.tag === 'a') return el.text || el.href || '';
            return '';
          })
          .join(''),
      )
      .join('\n');
  }

  /**
   * Download a message resource (image/file) to a local path.
   * Returns the path where the file was saved.
   */
  async downloadResource(messageId: string, resourceKey: string, destPath: string): Promise<string> {
    // Try as image first, then as file
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: resourceKey },
        params: { type: 'image' },
      });
      if (resp) {
        await resp.writeFile(destPath);
        logger.info({ messageId, resourceKey, destPath }, 'Image resource downloaded');
        return destPath;
      }
    } catch {
      // Not an image, try as file
    }

    const resp = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: resourceKey },
      params: { type: 'file' },
    });
    if (resp) {
      await resp.writeFile(destPath);
      logger.info({ messageId, resourceKey, destPath }, 'File resource downloaded');
      return destPath;
    }
    throw new Error(`Failed to download resource ${resourceKey}`);
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
        await this._sendStreaming(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
