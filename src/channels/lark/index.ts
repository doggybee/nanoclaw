/**
 * Lark (Feishu) channel — webhook-based integration.
 *
 * Lightweight host-side channel: handles inbound message parsing, webhook
 * events, and text fallback sending. All streaming cards, reactions, file
 * sending, and other rich interactions are handled directly by the container
 * agent via the Lark SDK.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../config.js';
import { updateChatNamesBatch } from '../../db.js';
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
} from '../../types.js';

import { optimizeMarkdownStyle } from './markdown-style.js';
import {
  withMessageGuard,
  MessageUnavailableError,
  formatLarkError,
} from './message-guard.js';

// Re-export for external consumers
export { LarkChannel, splitMarkdown };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_TEXT_LENGTH = 4000;
const MAX_OUTGOING_QUEUE = 1000;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const SUPPORTED_MESSAGE_TYPES = new Set([
  'text', 'image', 'file', 'post', 'interactive',
  'audio', 'video', 'media', 'sticker',
  'merge_forward', 'location', 'todo',
  'share_chat', 'share_user', 'system',
  'folder', 'hongbao', 'share_calendar_event',
  'calendar', 'general_calendar', 'video_chat', 'vote',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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
  registeredGroups: () => Record<string, import('../../types.js').RegisteredGroup>;
}

// ---------------------------------------------------------------------------
// Helpers — mention formatting, text processing
// ---------------------------------------------------------------------------

function normalizeAtMentions(text: string): string {
  return text.replace(
    /<at\s+(?:id|open_id|user_id)\s*=\s*"?([^">\s]+)"?\s*>/gi,
    '<at user_id="$1">',
  );
}

function formatMentionForText(target: { id: string; name: string }): string {
  return `<at user_id="${target.id}">${target.name}</at>`;
}

function prepareTextForLark(text: string): string {
  let processed = normalizeAtMentions(text);
  processed = optimizeMarkdownStyle(processed, 1);
  return processed;
}

function splitMarkdown(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx > 0) { chunks.push(remaining.slice(0, splitIdx)); remaining = remaining.slice(splitIdx + 2); continue; }
    splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx > 0) { chunks.push(remaining.slice(0, splitIdx)); remaining = remaining.slice(splitIdx + 1); continue; }
    chunks.push(remaining.slice(0, maxLen)); remaining = remaining.slice(maxLen);
  }
  return chunks;
}

function extractChatId(jid: string): string {
  return jid.replace(/^lark:/, '');
}

function millisToDatetime(ms: number | string): string {
  const num = Number(ms);
  if (!Number.isFinite(num)) return String(ms);
  const utc8Offset = 8 * 60 * 60 * 1000;
  const d = new Date(num + utc8Offset);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// ---------------------------------------------------------------------------
// Interactive card → text converter (inbound)
// ---------------------------------------------------------------------------
function convertInteractiveCard(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.json_card === 'string') {
      return convertCardToText(JSON.parse(parsed.json_card));
    }
    return convertCardToText(parsed);
  } catch { return '[interactive card]'; }
}

function convertCardToText(card: any): string {
  const parts: string[] = [];
  const header = card.header;
  if (header?.title) {
    const titleText = typeof header.title === 'string' ? header.title
      : header.title.content || header.title.i18nContent?.zh_cn || header.title.i18nContent?.en_us || '';
    if (titleText) parts.push(`**${titleText}**`);
  }
  const elements = card.body?.elements ?? card.elements ?? [];
  extractCardTexts(elements, parts);
  if (parts.length === 0) return '[interactive card]';
  const titleAttr = header?.title ? ` title="${extractText(header.title)}"` : '';
  return `<card${titleAttr}>\n${parts.join('\n')}\n</card>`;
}

function extractText(elem: any): string {
  if (!elem) return '';
  if (typeof elem === 'string') return elem;
  return elem.content || elem.i18nContent?.zh_cn || elem.i18nContent?.en_us || elem.text || '';
}

function extractCardTexts(elements: any[], out: string[]): void {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    if (typeof el !== 'object' || el === null) continue;
    const tag = el.tag ?? '';
    const prop = el.property ?? el;
    if (tag === 'markdown' || tag === 'lark_md') {
      const content = prop.content ?? el.content;
      if (typeof content === 'string') out.push(content);
    } else if (tag === 'plain_text' || tag === 'text') {
      const content = prop.content ?? el.content ?? el.text?.content;
      if (typeof content === 'string') out.push(content);
    } else if (tag === 'div') {
      const text = prop.text ?? el.text;
      if (text && typeof text === 'object') { const t = extractText(text); if (t) out.push(t); }
      const fields = prop.fields ?? el.fields;
      if (Array.isArray(fields)) { for (const f of fields) { const t = extractText(f?.text); if (t) out.push(t); } }
    } else if (tag === 'note') {
      const noteEls = prop.elements ?? el.elements;
      if (Array.isArray(noteEls)) { const ts: string[] = []; for (const ne of noteEls) { const t = extractText(ne); if (t) ts.push(t); } if (ts.length) out.push(ts.join(' ')); }
    } else if (tag === 'hr') { out.push('---');
    } else if (tag === 'button') { const t = extractText(prop.text ?? el.text); if (t) out.push(`[${t}]`);
    } else if (tag === 'actions' || tag === 'action') { const a = prop.actions ?? el.actions; if (Array.isArray(a)) extractCardTexts(a, out);
    } else if (tag === 'column_set') { const cols = prop.columns ?? el.columns; if (Array.isArray(cols)) { for (const c of cols) { const ce = c?.elements ?? c?.property?.elements; if (Array.isArray(ce)) extractCardTexts(ce, out); } }
    } else if (tag === 'column') { const ce = prop.elements ?? el.elements; if (Array.isArray(ce)) extractCardTexts(ce, out);
    } else if (tag === 'img' || tag === 'image') { out.push(`[${extractText(prop.alt ?? el.alt) || '图片'}]`);
    } else if (tag === 'table') {
      const columns = prop.columns ?? el.columns;
      const rows = prop.rows ?? el.rows ?? [];
      if (Array.isArray(columns) && columns.length > 0) {
        const colNames = columns.map((c: any) => c.displayName || c.name || '');
        const colKeys = columns.map((c: any) => c.name || '');
        const lines: string[] = [];
        lines.push('| ' + colNames.join(' | ') + ' |');
        lines.push('|' + colNames.map(() => '------|').join(''));
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) continue;
          const cells = colKeys.map((key: string) => { const cell = (row as any)[key]; if (!cell) return ''; const data = cell.data; return typeof data === 'string' ? data : typeof data === 'number' ? String(data) : ''; });
          lines.push('| ' + cells.join(' | ') + ' |');
        }
        out.push(lines.join('\n'));
      }
    } else if (tag === 'form') { const fe = prop.elements ?? el.elements; if (Array.isArray(fe)) extractCardTexts(fe, out);
    } else if (tag === 'collapsible_panel') { const title = extractText(prop.header?.title ?? el.header?.title) || '详情'; out.push(`▼ ${title}`); const pe = prop.elements ?? el.elements; if (Array.isArray(pe)) extractCardTexts(pe, out);
    } else if (tag === 'select_static' || tag === 'multi_select_static') { const opts = prop.options ?? el.options ?? []; const ot = opts.map((o: any) => extractText(o?.text) || o?.value || '').filter(Boolean); if (ot.length) out.push(`{${ot.join(' / ')}}`);
    } else if (tag === 'checker') { out.push(`${prop.checked ? '[x]' : '[ ]'} ${extractText(prop.text ?? el.text)}`);
    } else if (tag === 'input') { const label = extractText(prop.label ?? el.label); const ph = extractText(prop.placeholder ?? el.placeholder); out.push(label ? `${label}: _____` : ph ? `${ph}_____` : '_____');
    } else { const nested = prop.elements ?? el.elements; if (Array.isArray(nested)) extractCardTexts(nested, out); }
  }
}

// ---------------------------------------------------------------------------
// LarkChannel
// ---------------------------------------------------------------------------

class LarkChannel implements Channel {
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
    const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET']);
    this.appId = env.LARK_APP_ID;
    this.appSecret = env.LARK_APP_SECRET;
    if (!this.appId || !this.appSecret) {
      throw new Error('LARK_APP_ID and LARK_APP_SECRET must be set in .env');
    }
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Lark,
    });
    this.dedupTimer = setInterval(() => this.cleanupDedup(), DEDUP_CLEANUP_INTERVAL_MS);
  }

  // ---- Connection lifecycle ----

  private sendToChat(
    jid: string,
    content: string,
    msgType: 'text' | 'post' | 'interactive' | 'image' | 'file',
    replyToMessageId?: string,
  ): Promise<void> {
    if (replyToMessageId) {
      return withMessageGuard(
        replyToMessageId,
        () => this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: msgType },
        }) as any,
        `im.message.reply(${msgType})`,
      );
    }
    return this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: extractChatId(jid), content, msg_type: msgType },
    }) as any;
  }

  async connect(): Promise<void> {
    const env = readEnvFile([
      'LARK_ENCRYPT_KEY', 'LARK_VERIFICATION_TOKEN',
      'LARK_WEBHOOK_PORT', 'LARK_WEBHOOK_PATH',
    ]);
    const port = parseInt(env.LARK_WEBHOOK_PORT || '3000', 10);
    const webhookPath = env.LARK_WEBHOOK_PATH || '/lark/events';
    const eventConfig = {
      encryptKey: env.LARK_ENCRYPT_KEY || undefined,
      verificationToken: env.LARK_VERIFICATION_TOKEN || undefined,
    };

    const eventDispatcher = new Lark.EventDispatcher(eventConfig).register({
      'im.message.receive_v1': async (data) => { await this.handleIncomingMessage(data); },
    });

    const cardActionPath = env.LARK_WEBHOOK_PATH
      ? `${env.LARK_WEBHOOK_PATH.replace(/\/$/, '')}/card`
      : '/lark/card';
    const cardActionHandler = new Lark.CardActionHandler(
      eventConfig,
      async (data: any) => { await this.handleCardAction(data); return undefined as any; },
    );

    const webhookHandler = (Lark as any).adaptDefault(webhookPath, eventDispatcher, { autoChallenge: true });
    const cardWebhookHandler = (Lark as any).adaptDefault(cardActionPath, cardActionHandler, { autoChallenge: true });

    const handleError = (res: http.ServerResponse, err: Error, label: string) => {
      logger.error({ err }, label);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); }
    };

    this.server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith(cardActionPath)) {
        cardWebhookHandler(req, res).catch((err: Error) => handleError(res, err, 'Lark card action handler error'));
        return;
      }
      if (req.url && !req.url.startsWith(webhookPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return;
      }
      webhookHandler(req, res).catch((err: Error) => handleError(res, err, 'Lark webhook handler error'));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') { logger.error({ port }, `Lark webhook port ${port} is already in use`); }
        else { logger.error({ err }, 'Lark webhook server error'); }
        reject(err);
      });
      this.server!.listen(port, () => {
        logger.info({ port, webhookPath }, `Lark webhook server listening on port ${port}, path ${webhookPath}`);
        resolve();
      });
    });

    try {
      const botInfo = await this.client.request<{ bot?: { open_id?: string } }>({
        method: 'GET', url: '/open-apis/bot/v3/info', data: undefined,
      });
      this.botOpenId = (botInfo as { bot?: { open_id?: string } })?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Connected to Lark via Webhook');
    } catch (err) {
      logger.warn({ err }, 'Lark webhook started but failed to get bot info');
    }

    this.connected = true;
    await this.flushOutgoingQueue();
    this.syncChatMetadata().catch((err) => logger.error({ err }, 'Background chat metadata sync failed'));
  }

  // ---- Inbound message handling ----

  private async handleIncomingMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) return;

    const messageId = message.message_id;
    logger.info({ messageId, messageType: message.message_type, content: message.content?.slice?.(0, 200) }, 'Incoming Lark message');

    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) this.seenMessages.set(messageId, Date.now());

    const messageType = message.message_type;
    if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) return;

    const chatId = message.chat_id;
    if (!chatId) return;

    const jid = `lark:${chatId}`;
    const chatType = message.chat_type;
    const isGroup = chatType !== 'p2p';
    const timestamp = new Date(parseInt(message.create_time, 10) || Date.now()).toISOString();

    this.opts.onChatMetadata(jid, timestamp, undefined, 'lark', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const sender = data.sender;
    const senderOpenId = sender?.sender_id?.open_id;
    const isBotMessage = !!(this.botOpenId && senderOpenId === this.botOpenId);
    const senderName = isBotMessage ? ASSISTANT_NAME : sender?.sender_id?.open_id || 'unknown';

    let content = '';
    let hasTrigger = false;
    const embeddedImageKeys: string[] = [];

    // Extract content by message type
    if (messageType === 'text') {
      try { content = JSON.parse(message.content).text || ''; } catch { return; }
    } else if (messageType === 'image') {
      try { const p = JSON.parse(message.content); content = `[image:${p.image_key}]`; embeddedImageKeys.push(p.image_key); } catch { return; }
    } else if (messageType === 'file') {
      try { const p = JSON.parse(message.content); content = `[file:${p.file_key}:${p.file_name || 'unknown'}]`; } catch { return; }
    } else if (messageType === 'post') {
      try {
        const parsed = JSON.parse(message.content);
        const lines: string[] = [];
        if (parsed.title) lines.push(`**${parsed.title}**`, '');
        const contentBlocks = (parsed.content ?? []) as Array<Array<any>>;
        for (const paragraph of contentBlocks) {
          if (!Array.isArray(paragraph)) continue;
          let line = '';
          for (const el of paragraph) {
            switch (el.tag) {
              case 'text': { let t = el.text ?? ''; if (el.style?.includes('bold')) t = `**${t}**`; if (el.style?.includes('italic')) t = `*${t}*`; if (el.style?.includes('underline')) t = `<u>${t}</u>`; if (el.style?.includes('lineThrough')) t = `~~${t}~~`; if (el.style?.includes('codeInline')) t = `\`${t}\``; line += t; break; }
              case 'a': line += el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? ''); break;
              case 'at': line += el.user_id ?? ''; break;
              case 'img': if (el.image_key) { embeddedImageKeys.push(el.image_key); line += `![image](${el.image_key})`; } break;
              case 'media': if (el.file_key) line += `<file key="${el.file_key}"/>`; break;
              case 'code_block': line += `\n\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\`\n`; break;
              case 'hr': line += '\n---\n'; break;
              default: line += el.text ?? ''; break;
            }
          }
          lines.push(line);
        }
        content = lines.join('\n').trim() || '';
      } catch { return; }
    } else if (messageType === 'audio') {
      try { const p = JSON.parse(message.content); const dur = p.duration != null ? ` duration="${Math.ceil(Number(p.duration) / 1000)}s"` : ''; content = p.file_key ? `<audio key="${p.file_key}"${dur}/>` : '[audio]'; } catch { content = '[audio]'; }
    } else if (messageType === 'video' || messageType === 'media') {
      try { const p = JSON.parse(message.content); content = p.file_key ? `<video key="${p.file_key}"/>` : '[video]'; } catch { content = '[video]'; }
    } else if (messageType === 'sticker') {
      try { const p = JSON.parse(message.content); content = p.file_key ? `<sticker key="${p.file_key}"/>` : '[sticker]'; } catch { content = '[sticker]'; }
    } else if (messageType === 'location') {
      try { const p = JSON.parse(message.content); const n = p.name ? ` name="${p.name}"` : ''; const c = p.latitude && p.longitude ? ` coords="lat:${p.latitude},lng:${p.longitude}"` : ''; content = `<location${n}${c}/>`; } catch { content = '[location]'; }
    } else if (messageType === 'todo') {
      try { const p = JSON.parse(message.content); const title = p.summary?.title ?? ''; const body = p.summary?.content ? (p.summary.content as any[][]).map((para: any[]) => para.map((e: any) => e.text || '').join('')).join('\n').trim() : ''; const full = [title, body].filter(Boolean).join('\n'); const due = p.due_time ? `\nDue: ${millisToDatetime(p.due_time)}` : ''; content = `<todo>\n${full || '[todo]'}${due}\n</todo>`; } catch { content = '[todo]'; }
    } else if (messageType === 'share_chat') {
      try { content = `<group_card id="${JSON.parse(message.content).chat_id ?? ''}"/>`; } catch { content = '[shared group]'; }
    } else if (messageType === 'share_user') {
      try { content = `<contact_card id="${JSON.parse(message.content).user_id ?? ''}"/>`; } catch { content = '[shared contact]'; }
    } else if (messageType === 'interactive') {
      content = convertInteractiveCard(message.content);
    } else if (messageType === 'system') {
      try { const p = JSON.parse(message.content); if (p.template) { let sys = p.template as string; if (p.from_user?.length) sys = sys.replace('{from_user}', p.from_user.filter(Boolean).join(', ')); if (p.to_chatters?.length) sys = sys.replace('{to_chatters}', p.to_chatters.filter(Boolean).join(', ')); if (p.divider_text?.text) sys = sys.replace('{divider_text}', p.divider_text.text); sys = sys.replace(/\{[^}]+\}/g, ''); content = sys.trim() || '[system message]'; } else { content = '[system message]'; } } catch { content = '[system message]'; }
    } else if (messageType === 'merge_forward') {
      content = await this.expandMergeForward(message.message_id);
    } else if (messageType === 'folder') {
      try { const p = JSON.parse(message.content); content = p.file_key ? `<folder key="${p.file_key}"${p.file_name ? ` name="${p.file_name}"` : ''}/>` : '[folder]'; } catch { content = '[folder]'; }
    } else if (messageType === 'hongbao') {
      try { const p = JSON.parse(message.content); content = `<hongbao${p.text ? ` text="${p.text}"` : ''}/>`; } catch { content = '<hongbao/>'; }
    } else if (messageType === 'share_calendar_event' || messageType === 'calendar' || messageType === 'general_calendar') {
      try { const p = JSON.parse(message.content); const parts: string[] = []; if (p.summary) parts.push(`📅 ${p.summary}`); const s = p.start_time ? millisToDatetime(p.start_time) : ''; const e = p.end_time ? millisToDatetime(p.end_time) : ''; if (s && e) parts.push(`🕙 ${s} ~ ${e}`); else if (s) parts.push(`🕙 ${s}`); const inner = parts.join('\n') || '[calendar event]'; const tag = messageType === 'share_calendar_event' ? 'calendar_share' : messageType === 'calendar' ? 'calendar_invite' : 'calendar'; content = `<${tag}>${inner}</${tag}>`; } catch { content = '[calendar event]'; }
    } else if (messageType === 'video_chat') {
      try { const p = JSON.parse(message.content); const parts: string[] = []; if (p.topic) parts.push(`📹 ${p.topic}`); if (p.start_time) parts.push(`🕙 ${millisToDatetime(p.start_time)}`); content = `<meeting>${parts.join('\n') || '[video chat]'}</meeting>`; } catch { content = '[video chat]'; }
    } else if (messageType === 'vote') {
      try { const p = JSON.parse(message.content); const parts: string[] = []; if (p.topic) parts.push(p.topic); if (Array.isArray(p.options)) for (const o of p.options) parts.push(`• ${o}`); content = `<vote>\n${parts.join('\n') || '[vote]'}\n</vote>`; } catch { content = '[vote]'; }
    }

    if (!content && embeddedImageKeys.length === 0) return;

    // Normalize @mentions
    if (!isBotMessage) {
      const mentions = message.mentions as Array<{ key: string; id?: { open_id?: string }; name?: string }> | undefined;
      if (mentions && this.botOpenId) {
        for (const mention of mentions) {
          if (mention.id?.open_id === this.botOpenId && mention.key) {
            content = content.replace(mention.key, `@${ASSISTANT_NAME}`);
            hasTrigger = true;
          }
        }
      }
      if (hasTrigger && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const hasMedia = embeddedImageKeys.length > 0 || messageType === 'file';
    const group = groups[jid];
    if (hasMedia && !hasTrigger && !content) {
      if (group?.requiresTrigger !== false) return;
    }

    if (embeddedImageKeys.length > 0 && (hasTrigger || group?.requiresTrigger === false)) {
      content = await this.downloadImages(jid, messageId, embeddedImageKeys, group?.folder || 'main', content);
    }
    if (messageType === 'file' && (hasTrigger || group?.requiresTrigger === false)) {
      content = await this.downloadFile(jid, messageId, message.content, group?.folder || 'main', content);
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
      const chatId = data?.open_chat_id || data?.context?.open_chat_id;
      const messageId = data?.open_message_id || data?.context?.open_message_id;
      if (!action || !chatId) return;
      const jid = `lark:${chatId}`;
      const actionId = action?.value?.action_id || action?.name || action?.tag || 'unknown';
      this.opts.onCardAction?.(jid, {
        actionId,
        value: action?.value,
        userId: operatorId || '',
        messageId,
      });
    } catch (err) { logger.error({ err }, 'Error handling card action'); }
  }

  // ---- Outbound: sendMessage (text post only) ----

  async sendMessage(
    jid: string,
    text: string,
    opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string } },
  ): Promise<void> {
    if (!this.connected) {
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        this.outgoingQueue.shift();
        logger.warn('Outgoing queue full, dropping oldest message');
      }
      this.outgoingQueue.push({ jid, text });
      return;
    }

    try {
      await this._sendCard(jid, text, opts?.replyToMessageId, opts?.mentionUser);
    } catch (err) {
      if (err instanceof MessageUnavailableError) {
        logger.warn({ jid, messageId: err.messageId }, 'Reply target unavailable, dropping message');
        return;
      }
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) this.outgoingQueue.shift();
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err: formatLarkError(err), queueSize: this.outgoingQueue.length }, 'Failed to send, queued');
    }
  }

  // ---- Card sending ----

  private async _sendCard(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
  ): Promise<void> {
    const fullText = mentionUser
      ? `${formatMentionForText(mentionUser)} ${text}`
      : text;
    const optimized = prepareTextForLark(fullText);
    const chunks = splitMarkdown(optimized, MAX_TEXT_LENGTH);
    // Combine all chunks into a single card with multiple markdown elements
    const elements: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: chunks[i] });
    }
    const cardJson = {
      config: { wide_screen_mode: true },
      elements,
    };
    const content = JSON.stringify(cardJson);
    await this.sendToChat(jid, content, 'interactive', replyToMessageId);
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Lark message sent (card)');
  }

  // ---- Channel interface methods ----

  isConnected(): boolean { return this.connected; }
  ownsJid(jid: string): boolean { return jid.startsWith('lark:'); }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.dedupTimer) { clearInterval(this.dedupTimer); this.dedupTimer = undefined; }
    if (this.server) { this.server.closeAllConnections(); this.server.close(); this.server = undefined; }
  }

  // ---- Private helpers ----

  private async expandMergeForward(messageId: string): Promise<string> {
    if (!messageId) return '<forwarded_messages/>';
    try {
      const resp = await (this.client as any).im.v1.message.list({
        params: { container_id_type: 'merge_forward', container_id: messageId, page_size: 50, sort_type: 'ByCreateTimeAsc' },
      });
      const items = resp?.data?.items;
      if (!items?.length) return '<forwarded_messages/>';
      const parts: string[] = [];
      for (const item of items) {
        try {
          const msgType = item.msg_type ?? 'text';
          const senderId = item.sender?.id ?? 'unknown';
          const createTime = item.create_time ? millisToDatetime(parseInt(String(item.create_time), 10)) : 'unknown';
          let sub = '';
          if (msgType === 'text') { sub = JSON.parse(item.body?.content ?? '{}').text ?? ''; }
          else if (msgType === 'post') { sub = JSON.parse(item.body?.content ?? '{}').title ?? ''; }
          else if (msgType === 'image') { sub = '[image]'; }
          else if (msgType === 'file') { sub = `[file: ${JSON.parse(item.body?.content ?? '{}').file_name ?? 'unknown'}]`; }
          else if (msgType === 'merge_forward') { sub = '<forwarded_messages/>'; }
          else { try { sub = JSON.parse(item.body?.content ?? '{}').text ?? `[${msgType}]`; } catch { sub = `[${msgType}]`; } }
          parts.push(`[${createTime}] ${senderId} (${item.message_id ?? ''}):\n${sub.split('\n').map((l: string) => `    ${l}`).join('\n')}`);
        } catch { /* skip */ }
      }
      return parts.length ? `<forwarded_messages>\n${parts.join('\n')}\n</forwarded_messages>` : '<forwarded_messages/>';
    } catch { return '<forwarded_messages/>'; }
  }

  private async downloadImages(jid: string, messageId: string, imageKeys: string[], groupFolder: string, content: string): Promise<string> {
    try {
      const tmpDir = path.join(process.cwd(), 'groups', groupFolder, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const results = await Promise.allSettled(imageKeys.map(async (imageKey) => {
        const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
        const destPath = path.join(tmpDir, filename);
        const resp = await this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' },
        });
        if (resp) { await resp.writeFile(destPath); try { fs.chownSync(destPath, 1000, 1000); } catch {} return `/workspace/group/tmp/${filename}`; }
        return null;
      }));
      const paths = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null).map((r) => r.value);
      if (paths.length > 0) {
        const ref = paths.length === 1
          ? `[User sent an image. File saved at: ${paths[0]} — use the Read tool to view it]`
          : `[User sent ${paths.length} images. Files saved at: ${paths.join(', ')} — use the Read tool to view them]`;
        return content ? `${content}\n${ref}` : `@${ASSISTANT_NAME} ${ref}`;
      }
    } catch (err) { logger.warn({ jid, err }, 'Failed to download image'); }
    return content;
  }

  private async downloadFile(jid: string, messageId: string, rawContent: string, groupFolder: string, content: string): Promise<string> {
    try {
      const parsed = JSON.parse(rawContent);
      const fileName = path.basename(parsed.file_name || `file_${Date.now()}`);
      const tmpDir = path.join(process.cwd(), 'groups', groupFolder, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const destPath = path.join(tmpDir, fileName);
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: parsed.file_key }, params: { type: 'file' },
      });
      if (resp) {
        await resp.writeFile(destPath);
        try { fs.chownSync(destPath, 1000, 1000); } catch {}
        const ref = `[User sent a file: ${fileName}. File saved at: /workspace/group/tmp/${fileName} — use the Read tool to view it]`;
        content = content ? `${content}\n${ref}` : `@${ASSISTANT_NAME} ${ref}`;
      }
    } catch (err) { logger.warn({ jid, err }, 'Failed to download file'); }
    return content;
  }

  async syncChatMetadata(): Promise<void> {
    const SYNC_TIMEOUT_MS = 30_000;
    try {
      let pageToken: string | undefined;
      const allChats: Array<{ jid: string; name: string }> = [];
      const deadline = Date.now() + SYNC_TIMEOUT_MS;
      do {
        if (Date.now() > deadline) { logger.warn({ count: allChats.length }, 'Chat metadata sync timed out'); break; }
        const result = await this.client.im.v1.chat.list({
          params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        });
        for (const chat of result?.data?.items || []) {
          if (chat.chat_id && chat.name) allChats.push({ jid: `lark:${chat.chat_id}`, name: chat.name });
        }
        pageToken = result?.data?.page_token || undefined;
      } while (pageToken);
      if (allChats.length > 0) updateChatNamesBatch(allChats);
      logger.info({ count: allChats.length }, 'Lark chat metadata synced');
    } catch (err) { logger.error({ err }, 'Failed to sync Lark chat metadata'); }
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > DEDUP_TTL_MS) this.seenMessages.delete(id);
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      const initialLength = this.outgoingQueue.length;
      for (let i = 0; i < initialLength; i++) {
        const item = this.outgoingQueue.shift();
        if (!item) break;
        try {
          await this._sendCard(item.jid, item.text);
        } catch {
          // Re-queue at end and stop — API is likely down
          this.outgoingQueue.push(item);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
