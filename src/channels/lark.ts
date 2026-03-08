import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatNamesBatch } from '../db.js';
import { readEnvFile } from '../env.js';
import { parseSlotKey } from '../group-queue.js';
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

// Max queued outgoing messages — prevents unbounded memory growth if Lark API is down.
const MAX_OUTGOING_QUEUE = 1000;

// Dedup window: ignore duplicate message_id within this TTL (ms)
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Supported inbound message types (matches official plugin converter list)
const SUPPORTED_MESSAGE_TYPES = new Set([
  'text', 'image', 'file', 'post', 'interactive',
  'audio', 'video', 'media', 'sticker',
  'merge_forward', 'location', 'todo',
  'share_chat', 'share_user', 'system',
  'folder', 'hongbao', 'share_calendar_event',
  'calendar', 'general_calendar', 'video_chat', 'vote',
]);

/**
 * Normalise `<at>` mention tags that AI frequently writes incorrectly.
 * Fixes: `<at id=xxx>`, `<at open_id="xxx">`, unquoted values.
 * Matches official feishu-openclaw-plugin's normalizeAtMentions().
 */
function normalizeAtMentions(text: string): string {
  return text.replace(
    /<at\s+(?:id|open_id|user_id)\s*=\s*"?([^">\s]+)"?\s*>/gi,
    '<at user_id="$1">',
  );
}

/**
 * Pre-process text for Lark rendering:
 * mention normalisation + markdown style optimization.
 * Matches official feishu-openclaw-plugin's prepareTextForLark().
 */
function prepareTextForLark(text: string): string {
  let processed = normalizeAtMentions(text);
  processed = optimizeMarkdownStyle(processed, 1);
  return processed;
}

/**
 * Build a Lark post-format content envelope using the `md` tag.
 * The `md` tag lets Lark handle markdown rendering natively,
 * matching the official feishu-openclaw-plugin's approach.
 */
export function markdownToPostContent(text: string): any {
  const processed = prepareTextForLark(text);
  return {
    zh_cn: {
      content: [[{ tag: 'md', text: processed }]],
    },
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

/**
 * Optimize markdown for Lark card rendering.
 * Ported from official @larksuiteoapi/feishu-openclaw-plugin.
 *
 * - Heading downgrade: H1 → H4, H2-H6 → H5 (only when H1-H3 exist)
 * - Table spacing: adds <br> before/after tables for card v2
 * - Code block spacing: adds <br> before/after code blocks
 * - Consecutive headings: adds <br> between them
 * - Compresses excess blank lines
 * - Strips invalid image keys (prevents CardKit error 200570)
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownStyleInner(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyleInner(text: string, cardVersion: number): string {
    // 1. Extract code blocks, protect with placeholders
    const MARK = '___CB_';
    const codeBlocks: string[] = [];
    let r = text.replace(/```[\s\S]*?```/g, (m) => `${MARK}${codeBlocks.push(m) - 1}___`);

    // 2. Heading downgrade (only if document has H1-H3)
    // Order matters: H2-H6→H5 first, then H1→H4
    const hasH1toH3 = /^#{1,3} /m.test(text);
    if (hasH1toH3) {
      r = r.replace(/^#{2,6} (.+)$/gm, '##### $1');
      r = r.replace(/^# (.+)$/gm, '#### $1');
    }

    if (cardVersion >= 2) {
      // 3. Consecutive headings: add <br> between them
      r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

      // 4. Table spacing
      r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
      r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
      r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
      r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
      r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
      r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

      // 5. Restore code blocks with <br> spacing
      codeBlocks.forEach((block, i) => {
        r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
      });
    } else {
      codeBlocks.forEach((block, i) => {
        r = r.replace(`${MARK}${i}___`, block);
      });
    }

    // 6. Compress excess blank lines
    r = r.replace(/\n{3,}/g, '\n\n');
    return r;
}

// ---------------------------------------------------------------------------
// stripInvalidImageKeys — from official feishu-openclaw-plugin
// ---------------------------------------------------------------------------
/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`) or remote URL. Prevents CardKit error 200570.
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt: string, value: string) => {
    if (value.startsWith('img_')) return fullMatch;
    if (value.startsWith('http://')) return fullMatch;
    if (value.startsWith('https://')) return fullMatch;
    return value;
  });
}

// ---------------------------------------------------------------------------
// Message unavailable guard — from official feishu-openclaw-plugin
// ---------------------------------------------------------------------------
const TERMINAL_MESSAGE_CODES = new Set([230011, 231003]);
const UNAVAILABLE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_SIZE_BEFORE_PRUNE = 512;

interface UnavailableState {
  apiCode: number;
  operation?: string;
  markedAtMs: number;
}

const unavailableMessages = new Map<string, UnavailableState>();

/** Normalize composite message IDs (e.g. "om_xxx:auth-complete" → "om_xxx"). */
function normalizeMessageId(messageId: string | undefined): string | undefined {
  if (!messageId) return undefined;
  const colonIndex = messageId.indexOf(':');
  if (colonIndex >= 0) return messageId.slice(0, colonIndex);
  return messageId;
}

function coerceCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Extract Feishu API error code from SDK thrown errors. */
function extractLarkApiCode(err: any): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return coerceCode(err.code)
    ?? coerceCode(err.data?.code)
    ?? coerceCode(err.response?.data?.code);
}

/**
 * Format a user-friendly permission error for code 99991672.
 * Matches official feishu-openclaw-plugin's formatPermissionError().
 */
function formatPermissionError(code: number, msg: string): string | null {
  if (code !== 99991672) return null;
  // Extract auth URL from error message
  const urlMatch = msg.match(/https:\/\/[^\s]+\/app\/[^\s]+/);
  const authUrl = urlMatch?.[0] ?? '';
  // Extract scopes from [scope1,scope2,...] pattern
  const scopeMatch = msg.match(/\[([^\]]+)\]/);
  const scopes = scopeMatch?.[1] ?? 'unknown';
  return `权限不足：应用缺少 [${scopes}] 权限。\n请管理员点击以下链接申请并开通权限：\n${authUrl}`;
}

/**
 * Extract a meaningful error message from a Lark SDK / Axios error.
 * Matches official feishu-openclaw-plugin's formatLarkError().
 * For permission errors (99991672) formats a user-friendly string with scopes + auth URL.
 */
function formatLarkError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as any;
  // Path 1: Lark SDK merges Feishu fields onto the thrown error
  if (typeof e.code === 'number' && e.msg) {
    const permMsg = formatPermissionError(e.code, e.msg);
    if (permMsg) return permMsg;
    return e.msg;
  }
  // Path 2: Axios error — dig into response.data
  const data = e.response?.data;
  if (data && typeof data.code === 'number' && data.msg) {
    const permMsg = formatPermissionError(data.code, data.msg);
    if (permMsg) return permMsg;
    return data.msg;
  }
  // Fallback
  return e.message ?? String(err);
}

class MessageUnavailableError extends Error {
  messageId: string;
  apiCode: number;
  operation?: string;
  constructor(params: { messageId: string; apiCode: number; operation?: string }) {
    const opText = params.operation ? `, op=${params.operation}` : '';
    super(`[feishu-message-unavailable] message ${params.messageId} unavailable (code=${params.apiCode}${opText})`);
    this.name = 'MessageUnavailableError';
    this.messageId = params.messageId;
    this.apiCode = params.apiCode;
    this.operation = params.operation;
  }
}

function pruneExpiredMessages(nowMs = Date.now()) {
  for (const [id, state] of unavailableMessages) {
    if (nowMs - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
      unavailableMessages.delete(id);
    }
  }
}

/**
 * Unified message guard matching official runWithMessageUnavailableGuard():
 * - Pre-check: skip API call if message already marked unavailable
 * - Post-check: detect terminal codes (230011/231003), mark + throw MessageUnavailableError
 */
async function withMessageGuard<T>(
  messageId: string | undefined,
  fn: () => Promise<T>,
  operation?: string,
): Promise<T> {
  const normalizedId = normalizeMessageId(messageId);
  if (!normalizedId) return fn();

  // Pre-check: already marked?
  const state = unavailableMessages.get(normalizedId);
  if (state) {
    if (Date.now() - state.markedAtMs > UNAVAILABLE_CACHE_TTL_MS) {
      unavailableMessages.delete(normalizedId);
    } else {
      throw new MessageUnavailableError({
        messageId: normalizedId,
        apiCode: state.apiCode,
        operation: operation ?? state.operation,
      });
    }
  }

  try {
    return await fn();
  } catch (err) {
    const code = extractLarkApiCode(err);
    if (code && TERMINAL_MESSAGE_CODES.has(code)) {
      if (unavailableMessages.size >= MAX_CACHE_SIZE_BEFORE_PRUNE) {
        pruneExpiredMessages();
      }
      unavailableMessages.set(normalizedId, {
        apiCode: code,
        operation,
        markedAtMs: Date.now(),
      });
      throw new MessageUnavailableError({
        messageId: normalizedId,
        apiCode: code,
        operation,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Mention format helpers — from official feishu-openclaw-plugin
// ---------------------------------------------------------------------------
/** Format a mention for text/post messages: `<at user_id="ou_xxx">Name</at>` */
function formatMentionForText(target: { id: string; name: string }): string {
  return `<at user_id="${target.id}">${target.name}</at>`;
}

/** Format a mention for interactive card messages: `<at id=ou_xxx></at>` */
function formatMentionForCard(target: { id: string }): string {
  return `<at id=${target.id}></at>`;
}

// ---------------------------------------------------------------------------
// Interactive card → text converter (inbound)
// ---------------------------------------------------------------------------
function convertInteractiveCard(raw: string): string {
  try {
    const parsed = JSON.parse(raw);

    // New format: json_card field
    if (typeof parsed.json_card === 'string') {
      const card = JSON.parse(parsed.json_card);
      return convertCardToText(card);
    }

    // Legacy format: direct card JSON
    return convertCardToText(parsed);
  } catch {
    return '[interactive card]';
  }
}

function convertCardToText(card: any): string {
  const parts: string[] = [];

  // Extract title from header
  const header = card.header;
  if (header) {
    const title = header.title;
    if (title) {
      const titleText = typeof title === 'string' ? title
        : title.content || title.i18nContent?.zh_cn || title.i18nContent?.en_us || '';
      if (titleText) parts.push(`**${titleText}**`);
    }
  }

  // Extract body elements
  const elements = card.body?.elements ?? card.elements ?? [];
  extractCardTexts(elements, parts);

  if (parts.length === 0) return '[interactive card]';
  return `<card${header?.title ? ` title="${extractText(header.title)}"` : ''}>\n${parts.join('\n')}\n</card>`;
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
      if (text && typeof text === 'object') {
        const t = extractText(text);
        if (t) out.push(t);
      }
      // fields
      const fields = prop.fields ?? el.fields;
      if (Array.isArray(fields)) {
        for (const field of fields) {
          const ft = field?.text;
          if (ft) {
            const t = extractText(ft);
            if (t) out.push(t);
          }
        }
      }
    } else if (tag === 'note') {
      const noteElements = prop.elements ?? el.elements;
      if (Array.isArray(noteElements)) {
        const texts: string[] = [];
        for (const ne of noteElements) {
          const t = extractText(ne);
          if (t) texts.push(t);
        }
        if (texts.length > 0) out.push(texts.join(' '));
      }
    } else if (tag === 'hr') {
      out.push('---');
    } else if (tag === 'button') {
      const btnText = extractText(prop.text ?? el.text);
      if (btnText) out.push(`[${btnText}]`);
    } else if (tag === 'actions' || tag === 'action') {
      const actions = prop.actions ?? el.actions;
      if (Array.isArray(actions)) extractCardTexts(actions, out);
    } else if (tag === 'column_set') {
      const columns = prop.columns ?? el.columns;
      if (Array.isArray(columns)) {
        for (const col of columns) {
          const colElements = col?.elements ?? col?.property?.elements;
          if (Array.isArray(colElements)) extractCardTexts(colElements, out);
        }
      }
    } else if (tag === 'column') {
      const colElements = prop.elements ?? el.elements;
      if (Array.isArray(colElements)) extractCardTexts(colElements, out);
    } else if (tag === 'img' || tag === 'image') {
      const alt = extractText(prop.alt ?? el.alt) || '图片';
      out.push(`[${alt}]`);
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
          const cells = colKeys.map((key: string) => {
            const cell = (row as any)[key];
            if (!cell) return '';
            const data = cell.data;
            if (typeof data === 'string') return data;
            if (typeof data === 'number') return String(data);
            return '';
          });
          lines.push('| ' + cells.join(' | ') + ' |');
        }
        out.push(lines.join('\n'));
      }
    } else if (tag === 'form') {
      const formElements = prop.elements ?? el.elements;
      if (Array.isArray(formElements)) extractCardTexts(formElements, out);
    } else if (tag === 'collapsible_panel') {
      const title = extractText(prop.header?.title ?? el.header?.title) || '详情';
      out.push(`▼ ${title}`);
      const panelElements = prop.elements ?? el.elements;
      if (Array.isArray(panelElements)) extractCardTexts(panelElements, out);
    } else if (tag === 'select_static' || tag === 'multi_select_static') {
      const options = prop.options ?? el.options ?? [];
      const optTexts = options.map((o: any) => extractText(o?.text) || o?.value || '').filter(Boolean);
      if (optTexts.length > 0) out.push(`{${optTexts.join(' / ')}}`);
    } else if (tag === 'checker') {
      const checked = prop.checked === true;
      const text = extractText(prop.text ?? el.text);
      out.push(`${checked ? '[x]' : '[ ]'} ${text}`);
    } else if (tag === 'input') {
      const label = extractText(prop.label ?? el.label);
      const placeholder = extractText(prop.placeholder ?? el.placeholder);
      out.push(label ? `${label}: _____` : placeholder ? `${placeholder}_____` : '_____');
    } else {
      // Try to extract text from nested elements
      const nested = prop.elements ?? el.elements;
      if (Array.isArray(nested)) extractCardTexts(nested, out);
    }
  }
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

// ---------------------------------------------------------------------------
// Streaming card constants — match official Feishu plugin exactly
// ---------------------------------------------------------------------------
const STREAMING_ELEMENT_ID = 'streaming_content';
const LOADING_ELEMENT_ID = 'loading_icon';

// Minimum interval between CardKit streaming updates (ms).
// Matches official plugin's CARDKIT_THROTTLE_MS.
const STREAMING_THROTTLE_MS = 100;

interface StreamingCard {
  cardId: string;
  sequence: number;
  /** Last pushed content — used to build the final "complete" card. */
  lastContent?: string;
  /** Timestamp when streaming started (message receipt time). */
  startedAt: number;
  /** Timestamp of last CardKit update — used for throttling. */
  lastUpdateMs: number;
  /** Pending throttled update timer. */
  pendingTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Per-key start times, recorded when beginStreaming is called.
 * Survives card creation failures so the fallback path in _sendStreaming
 * still uses the correct start time (not the time of first text arrival).
 */
const streamingStartTimes = new Map<string, number>();

/**
 * The thinking card JSON sent as the initial streaming card.
 * Identical to the official plugin's `thinkingCardJson`.
 *
 * Performance opt: we add `streaming_config` for faster client-side animation.
 * The official plugin omits this (uses CardKit defaults: step=1, freq=50ms).
 */
function buildThinkingCardJson() {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '思考中...' },
      // Performance optimization — faster client-side typewriter
      streaming_config: {
        print_frequency_ms: { default: 20 },
        print_step: { default: 10 },
        print_strategy: 'fast' as const,
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
          element_id: STREAMING_ELEMENT_ID,
        },
        {
          tag: 'markdown',
          content: '努力回答中...',
          icon: {
            tag: 'standard_icon',
            token: 'robot_outlined',
            color: 'blue',
          },
          text_size: 'notation',
          element_id: LOADING_ELEMENT_ID,
        },
      ],
    },
  };
}

/**
 * Build the "complete" card that replaces the streaming card when done.
 * Matches the official plugin's `buildCompleteCard` + `toCardKit2`.
 */
function buildCompleteCard(
  fullText: string,
  opts?: {
    elapsedMs?: number;
    isError?: boolean;
    reasoningText?: string;
    reasoningElapsedMs?: number;
  },
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  // Collapsible reasoning panel (before main content) — matches official plugin
  if (opts?.reasoningText) {
    const durationLabel = opts.reasoningElapsedMs
      ? formatReasoningDuration(opts.reasoningElapsedMs)
      : 'Thought';
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: `💭 ${durationLabel}` },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        { tag: 'markdown', content: opts.reasoningText, text_size: 'notation' },
      ],
    });
  }

  // Main content with markdown optimization
  elements.push({
    tag: 'markdown',
    content: optimizeMarkdownStyle(fullText),
  });

  // Footer: status + elapsed (matches official format)
  const parts: string[] = [];
  if (opts?.isError) {
    parts.push('出错');
  } else {
    parts.push('已完成');
  }
  if (opts?.elapsedMs != null) {
    parts.push(`耗时 ${formatElapsed(opts.elapsedMs)}`);
  }
  if (parts.length > 0) {
    const footerContent = opts?.isError
      ? `<font color='red'>${parts.join(' · ')}</font>`
      : parts.join(' · ');
    elements.push({ tag: 'markdown', content: footerContent, text_size: 'notation' });
  }

  // Feed preview summary — stripped markdown
  const summaryText = fullText.replace(/[*_`#>\[\]()~]/g, '').trim();
  const summary = summaryText
    ? { content: summaryText.slice(0, 120) }
    : undefined;

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true, summary },
    body: { elements },
  };
}

/** Format elapsed time. Matches official plugin's `formatElapsed`. */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Format reasoning duration. Matches official plugin's `formatReasoningDuration`. */
function formatReasoningDuration(ms: number): string {
  const seconds = ms / 1000;
  const duration = seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `Thought for ${duration}`;
}

/**
 * Convert a millisecond timestamp to "YYYY-MM-DD HH:mm" in UTC+8 (Beijing time).
 * Matches official feishu-openclaw-plugin's millisToDatetime().
 */
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

/** Strip the `lark:` prefix to get the raw Lark chat_id. */
function extractChatId(jid: string): string {
  return jid.replace(/^lark:/, '');
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

  /** Promises for in-progress card creation (prevents race between beginStreaming and _sendStreaming). */
  private cardCreationPromises = new Map<string, Promise<void>>();
  /** Pre-created CardKit card IDs ready for immediate use — skips card.create latency. */
  private cardPool: string[] = [];
  private cardPoolRefilling = false;
  private readonly CARD_POOL_SIZE = 2;

  private appId: string;
  private appSecret: string;
  private opts: LarkChannelOpts;

  constructor(opts: LarkChannelOpts) {
    this.opts = opts;

    // Read credentials from .env (not process.env — keeps secrets off the
    // environment so they don't leak to child processes)
    const env = readEnvFile(['LARK_APP_ID', 'LARK_APP_SECRET']);
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

  /** Create a CardKit card entity for streaming. Returns the card_id or null. */
  private async createThinkingCard(): Promise<string | null> {
    const result = await this.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(buildThinkingCardJson()) },
    });
    return result?.data?.card_id ?? null;
  }

  /** Pre-create CardKit card entities so beginStreaming only needs sendToChat (saves ~1.5s). */
  private async refillCardPool(): Promise<void> {
    if (this.cardPoolRefilling) return;
    this.cardPoolRefilling = true;
    try {
      while (this.cardPool.length < this.CARD_POOL_SIZE) {
        const cardId = await this.createThinkingCard();
        if (cardId) {
          this.cardPool.push(cardId);
          logger.debug({ cardId, poolSize: this.cardPool.length }, 'Card pool: pre-created');
        } else {
          logger.warn('Card pool: card.create returned empty card_id, stopping refill');
          break;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Card pool: refill failed');
    } finally {
      this.cardPoolRefilling = false;
    }
  }

  /**
   * Send a message to a chat, handling reply-or-create branching.
   * All outbound methods funnel through this to eliminate duplication.
   */
  private async sendToChat(
    jid: string,
    content: string,
    msgType: 'text' | 'post' | 'interactive' | 'image' | 'file',
    replyToMessageId?: string,
  ): Promise<void> {
    if (replyToMessageId) {
      await withMessageGuard(
        replyToMessageId,
        () => this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: msgType },
        }),
        `im.message.reply(${msgType})`,
      );
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: extractChatId(jid), content, msg_type: msgType },
      });
    }
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
    const eventConfig = {
      encryptKey: env.LARK_ENCRYPT_KEY || undefined,
      verificationToken: env.LARK_VERIFICATION_TOKEN || undefined,
    };

    const eventDispatcher = new Lark.EventDispatcher(eventConfig).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingMessage(data);
      },
    });

    // Card action handler for interactive card callbacks
    const cardActionPath = env.LARK_WEBHOOK_PATH
      ? `${env.LARK_WEBHOOK_PATH.replace(/\/$/, '')}/card`
      : '/lark/card';
    const cardActionHandler = new Lark.CardActionHandler(
      eventConfig,
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

    const handleError = (res: http.ServerResponse, err: Error, label: string) => {
      logger.error({ err }, label);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    };

    // Start HTTP server for receiving Lark event callbacks and card actions
    this.server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith(cardActionPath)) {
        cardWebhookHandler(req, res).catch((err: Error) => handleError(res, err, 'Lark card action handler error'));
        return;
      }
      if (req.url && !req.url.startsWith(webhookPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      webhookHandler(req, res).catch((err: Error) => handleError(res, err, 'Lark webhook handler error'));
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

    // Sync chat names in background (don't block startup)
    this.syncChatMetadata().catch((err) =>
      logger.error({ err }, 'Background chat metadata sync failed'),
    );

    // Pre-create card pool in background (saves ~1.5s on first streaming card)
    this.refillCardPool().catch((err) =>
      logger.warn({ err }, 'Card pool initial fill failed'),
    );
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    const message = data?.message;
    if (!message) return;

    const messageId = message.message_id;
    logger.info({ messageId, messageType: message.message_type, content: message.content?.slice?.(0, 200) }, 'Incoming Lark message');

    // Dedup by message_id
    if (messageId && this.seenMessages.has(messageId)) return;
    if (messageId) this.seenMessages.set(messageId, Date.now());

    const messageType = message.message_type;
    if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) return;

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
      // Rich text: matches official convertPost — paragraph-per-line, markdown elements
      try {
        const parsed = JSON.parse(message.content);
        const lines: string[] = [];
        if (parsed.title) {
          lines.push(`**${parsed.title}**`, '');
        }
        const contentBlocks = (parsed.content ?? []) as Array<Array<{
          tag: string; text?: string; image_key?: string; file_key?: string;
          user_id?: string; user_name?: string; href?: string; language?: string;
          style?: string[];
        }>>;
        for (const paragraph of contentBlocks) {
          if (!Array.isArray(paragraph)) continue;
          let line = '';
          for (const el of paragraph) {
            switch (el.tag) {
              case 'text': {
                let t = el.text ?? '';
                // Apply styles matching official applyStyle()
                if (el.style?.includes('bold')) t = `**${t}**`;
                if (el.style?.includes('italic')) t = `*${t}*`;
                if (el.style?.includes('underline')) t = `<u>${t}</u>`;
                if (el.style?.includes('lineThrough')) t = `~~${t}~~`;
                if (el.style?.includes('codeInline')) t = `\`${t}\``;
                line += t;
                break;
              }
              case 'a':
                line += el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? '');
                break;
              case 'at':
                line += el.user_id ?? ''; // @_user_N placeholder, resolved by mention handling below
                break;
              case 'img':
                if (el.image_key) {
                  embeddedImageKeys.push(el.image_key);
                  line += `![image](${el.image_key})`;
                }
                break;
              case 'media':
                if (el.file_key) line += `<file key="${el.file_key}"/>`;
                break;
              case 'code_block':
                line += `\n\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\`\n`;
                break;
              case 'hr':
                line += '\n---\n';
                break;
              default:
                line += el.text ?? '';
                break;
            }
          }
          lines.push(line);
        }
        content = lines.join('\n').trim() || '';
      } catch {
        return;
      }
    } else if (messageType === 'audio') {
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        const duration = parsed.duration;
        const durationStr = duration != null ? ` duration="${Math.ceil(Number(duration) / 1000)}s"` : '';
        content = fileKey ? `<audio key="${fileKey}"${durationStr}/>` : '[audio]';
      } catch { content = '[audio]'; }
    } else if (messageType === 'video' || messageType === 'media') {
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        content = fileKey ? `<video key="${fileKey}"/>` : '[video]';
      } catch { content = '[video]'; }
    } else if (messageType === 'sticker') {
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        content = fileKey ? `<sticker key="${fileKey}"/>` : '[sticker]';
      } catch { content = '[sticker]'; }
    } else if (messageType === 'location') {
      try {
        const parsed = JSON.parse(message.content);
        const name = parsed.name ?? '';
        const lat = parsed.latitude ?? '';
        const lng = parsed.longitude ?? '';
        const nameAttr = name ? ` name="${name}"` : '';
        const coordsAttr = lat && lng ? ` coords="lat:${lat},lng:${lng}"` : '';
        content = `<location${nameAttr}${coordsAttr}/>`;
      } catch { content = '[location]'; }
    } else if (messageType === 'todo') {
      try {
        const parsed = JSON.parse(message.content);
        const title = parsed.summary?.title ?? '';
        const body = parsed.summary?.content
          ? (parsed.summary.content as any[][]).map((p: any[]) => p.map((e: any) => e.text || '').join('')).join('\n').trim()
          : '';
        const fullTitle = [title, body].filter(Boolean).join('\n');
        const dueTime = parsed.due_time ? `\nDue: ${millisToDatetime(parsed.due_time)}` : '';
        content = `<todo>\n${fullTitle || '[todo]'}${dueTime}\n</todo>`;
      } catch { content = '[todo]'; }
    } else if (messageType === 'share_chat') {
      try {
        const parsed = JSON.parse(message.content);
        content = `<group_card id="${parsed.chat_id ?? ''}"/>`;
      } catch { content = '[shared group]'; }
    } else if (messageType === 'share_user') {
      try {
        const parsed = JSON.parse(message.content);
        content = `<contact_card id="${parsed.user_id ?? ''}"/>`;
      } catch { content = '[shared contact]'; }
    } else if (messageType === 'interactive') {
      content = convertInteractiveCard(message.content);
    } else if (messageType === 'system') {
      // Template-based system message parsing — matches official convertSystem
      try {
        const parsed = JSON.parse(message.content);
        if (parsed.template) {
          let sys = parsed.template as string;
          if (parsed.from_user?.length) {
            sys = sys.replace('{from_user}', (parsed.from_user as string[]).filter(Boolean).join(', '));
          }
          if (parsed.to_chatters?.length) {
            sys = sys.replace('{to_chatters}', (parsed.to_chatters as string[]).filter(Boolean).join(', '));
          }
          if (parsed.divider_text?.text) {
            sys = sys.replace('{divider_text}', parsed.divider_text.text);
          }
          // Clean up unreplaced placeholders
          sys = sys.replace(/\{[^}]+\}/g, '');
          content = sys.trim() || '[system message]';
        } else {
          content = '[system message]';
        }
      } catch {
        content = '[system message]';
      }
    } else if (messageType === 'merge_forward') {
      // Expand forwarded messages if possible via Lark API
      content = await this.expandMergeForward(message.message_id);
    } else if (messageType === 'folder') {
      // Matches official convertFolder
      try {
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        if (fileKey) {
          const nameAttr = parsed.file_name ? ` name="${parsed.file_name}"` : '';
          content = `<folder key="${fileKey}"${nameAttr}/>`;
        } else {
          content = '[folder]';
        }
      } catch { content = '[folder]'; }
    } else if (messageType === 'hongbao') {
      // Matches official convertHongbao
      try {
        const parsed = JSON.parse(message.content);
        const textAttr = parsed.text ? ` text="${parsed.text}"` : '';
        content = `<hongbao${textAttr}/>`;
      } catch { content = '<hongbao/>'; }
    } else if (messageType === 'share_calendar_event' || messageType === 'calendar' || messageType === 'general_calendar') {
      // Matches official convertShareCalendarEvent / convertCalendar / convertGeneralCalendar
      try {
        const parsed = JSON.parse(message.content);
        const calParts: string[] = [];
        if (parsed.summary) calParts.push(`📅 ${parsed.summary}`);
        const start = parsed.start_time ? millisToDatetime(parsed.start_time) : '';
        const end = parsed.end_time ? millisToDatetime(parsed.end_time) : '';
        if (start && end) calParts.push(`🕙 ${start} ~ ${end}`);
        else if (start) calParts.push(`🕙 ${start}`);
        const inner = calParts.join('\n') || '[calendar event]';
        const tag = messageType === 'share_calendar_event' ? 'calendar_share'
          : messageType === 'calendar' ? 'calendar_invite'
          : 'calendar';
        content = `<${tag}>${inner}</${tag}>`;
      } catch { content = '[calendar event]'; }
    } else if (messageType === 'video_chat') {
      // Matches official convertVideoChat
      try {
        const parsed = JSON.parse(message.content);
        const vcParts: string[] = [];
        if (parsed.topic) vcParts.push(`📹 ${parsed.topic}`);
        if (parsed.start_time) vcParts.push(`🕙 ${millisToDatetime(parsed.start_time)}`);
        const inner = vcParts.join('\n') || '[video chat]';
        content = `<meeting>${inner}</meeting>`;
      } catch { content = '[video chat]'; }
    } else if (messageType === 'vote') {
      // Matches official convertVote
      try {
        const parsed = JSON.parse(message.content);
        const voteParts: string[] = [];
        if (parsed.topic) voteParts.push(parsed.topic);
        if (Array.isArray(parsed.options)) {
          for (const opt of parsed.options) voteParts.push(`• ${opt}`);
        }
        const inner = voteParts.join('\n') || '[vote]';
        content = `<vote>\n${inner}\n</vote>`;
      } catch { content = '[vote]'; }
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

  async sendMessage(jid: string, text: string, opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; slotKey?: string }): Promise<void> {
    if (!this.connected) {
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        const dropped = this.outgoingQueue.shift();
        logger.warn({ jid: dropped?.jid }, 'Outgoing queue full, dropping oldest message');
      }
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Lark disconnected, message queued',
      );
      return;
    }

    try {
      await this._sendStreaming(jid, text, opts?.replyToMessageId, opts?.mentionUser, opts?.slotKey);
    } catch (err) {
      // Message recalled/deleted — don't fallback or queue, matches official reply-dispatcher
      if (err instanceof MessageUnavailableError) {
        logger.warn({ jid, messageId: err.messageId, code: err.apiCode }, 'Reply target unavailable, dropping message');
        return;
      }
      logger.warn({ jid, err: formatLarkError(err) }, 'Streaming card send failed, falling back to post');
      await this._sendPostWithQueue(jid, text, opts?.replyToMessageId, opts?.mentionUser);
    }
  }

  /**
   * Send or append text via streaming card.
   * First call: creates card entity, sends it, pushes initial text.
   * Send + push are parallelized to reduce Lark API round-trips.
   * Subsequent calls: appends text to the same card with typewriter effect.
   */
  private async _sendStreaming(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
    slotKey?: string,
  ): Promise<void> {
    const cardKey = slotKey || jid;

    // Check if card already registered (pool path sets streamingCards BEFORE sendToChat).
    // If so, push content immediately — no need to wait for sendToChat to finish.
    let existing = this.streamingCards.get(cardKey);

    if (!existing) {
      // Card not yet registered — might be in non-pool creation path.
      // Wait for beginStreaming to finish to avoid creating a duplicate card.
      const creationPromise = this.cardCreationPromises.get(cardKey);
      if (creationPromise) {
        try { await creationPromise; } catch { /* beginStreaming failed, fall through to create */ }
      }
      existing = this.streamingCards.get(cardKey);
    }

    if (existing) {
      // Always update bookkeeping immediately
      existing.lastContent = text;

      // Throttle: skip if too soon after last update, schedule deferred flush
      const now = Date.now();
      const elapsed = now - existing.lastUpdateMs;
      if (elapsed < STREAMING_THROTTLE_MS) {
        // Clear any existing pending timer, schedule a new one
        if (existing.pendingTimer) clearTimeout(existing.pendingTimer);
        const cardRef = existing;
        cardRef.pendingTimer = setTimeout(() => {
          cardRef.pendingTimer = undefined;
          const seq = cardRef.sequence + 1;
          cardRef.sequence = seq;
          cardRef.lastUpdateMs = Date.now();
          this.client.cardkit.v1.cardElement.content({
            path: { card_id: cardRef.cardId, element_id: STREAMING_ELEMENT_ID },
            data: { content: optimizeMarkdownStyle(cardRef.lastContent || ''), sequence: seq },
          }).catch((err: unknown) => {
            logger.warn({ err, cardId: cardRef.cardId, seq }, 'Streaming card update failed (deferred)');
          });
        }, STREAMING_THROTTLE_MS - elapsed);
        return;
      }

      const nextSeq = existing.sequence + 1;
      // Don't embed <at> in streaming content — CardKit replaces the entire
      // element on each push, so the mention would flash then disappear on
      // the next update. The card is already sent as a reply, which is enough.
      const optimized = optimizeMarkdownStyle(text);
      existing.sequence = nextSeq;
      existing.lastUpdateMs = now;
      // Clear any pending deferred flush since we're flushing now
      if (existing.pendingTimer) {
        clearTimeout(existing.pendingTimer);
        existing.pendingTimer = undefined;
      }
      // Fire-and-forget: don't await the Lark API call — it adds ~200-400ms
      // of latency per streaming tick, delaying visible text significantly.
      this.client.cardkit.v1.cardElement.content({
        path: { card_id: existing.cardId, element_id: STREAMING_ELEMENT_ID },
        data: { content: optimized, sequence: nextSeq },
      }).catch((err: unknown) => {
        logger.warn({ err, cardId: existing!.cardId, seq: nextSeq }, 'Streaming card update failed');
      });
      logger.debug({ jid, cardKey, cardId: existing.cardId, length: text.length }, 'Streaming card text updated');
    } else {
      // Create new streaming card
      const mentionPrefix = mentionUser
        ? `${formatMentionForCard(mentionUser)} `
        : '';

      const cardId = await this.createThinkingCard();
      if (!cardId) throw new Error('Failed to create card entity');

      const fullText = mentionPrefix + text;
      // Use stored start time (from beginStreaming) if available, otherwise now
      const startedAt = streamingStartTimes.get(cardKey) || Date.now();
      this.streamingCards.set(cardKey, { cardId, sequence: 1, startedAt, lastUpdateMs: Date.now() });

      // Parallelize: send card message + push initial text concurrently.
      // The card entity already exists, so both operations are independent.
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      await Promise.all([
        this.sendToChat(jid, content, 'interactive', replyToMessageId),
        this.client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: STREAMING_ELEMENT_ID },
          data: { content: optimizeMarkdownStyle(fullText), sequence: 1 },
        }),
      ]);

      logger.info({ jid, cardKey, cardId, length: fullText.length }, 'Streaming card created and sent');
    }
  }

  /**
   * Pre-create a streaming card and send it to the chat.
   * Uses pre-created card pool when available (skips card.create, saves ~1.5s).
   * Stores a creation promise so _sendStreaming can await it (prevents race conditions).
   */
  async beginStreaming(
    keyOrJid: string,
    opts?: { replyToMessageId?: string; mentionUser?: { id: string; name: string }; startedAt?: number },
  ): Promise<void> {
    if (this.streamingCards.has(keyOrJid)) return;
    if (this.cardCreationPromises.has(keyOrJid)) return; // creation already in progress

    // Record start time immediately (before async card creation).
    // Survives card creation failures so _sendStreaming fallback uses correct time.
    const startedAt = opts?.startedAt || Date.now();
    if (!streamingStartTimes.has(keyOrJid)) {
      streamingStartTimes.set(keyOrJid, startedAt);
    }

    const jid = keyOrJid.includes('::') ? parseSlotKey(keyOrJid).chatJid : keyOrJid;

    const promise = (async () => {
      // Try card pool first (pre-created, skips card.create ~1.5s)
      let cardId = this.cardPool.shift() ?? null;
      if (cardId) {
        logger.debug({ cardId, poolRemaining: this.cardPool.length }, 'Using pre-created card from pool');
        // Refill pool in background
        this.refillCardPool().catch(() => {});
      } else {
        // Pool empty — create on the fly (fallback)
        cardId = await this.createThinkingCard();
        if (!cardId) throw new Error('Failed to pre-create streaming card');
      }

      this.streamingCards.set(keyOrJid, { cardId, sequence: 0, startedAt, lastUpdateMs: 0 });

      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      await this.sendToChat(jid, content, 'interactive', opts?.replyToMessageId);

      logger.info({ keyOrJid, cardId }, 'Streaming card pre-created');
    })();

    this.cardCreationPromises.set(keyOrJid, promise);
    try {
      await promise;
    } finally {
      this.cardCreationPromises.delete(keyOrJid);
    }
  }

  /**
   * End the streaming session: close streaming mode, replace with a
   * "complete" card (wide_screen_mode, footer with elapsed time).
   * Matches the official Feishu plugin's card lifecycle.
   * @param opts.isError — if true, renders error card state (red footer)
   * @param opts.reasoningText — collapsible reasoning/thinking panel text
   * @param opts.reasoningElapsedMs — how long the model spent thinking
   */
  async endStreaming(
    keyOrJid: string,
    opts?: { isError?: boolean; reasoningText?: string; reasoningElapsedMs?: number },
  ): Promise<void> {
    const card = this.streamingCards.get(keyOrJid);
    if (!card) return;

    // Delete from map immediately to prevent concurrent calls from double-firing
    this.streamingCards.delete(keyOrJid);
    streamingStartTimes.delete(keyOrJid);
    // Clear any pending throttled update
    if (card.pendingTimer) {
      clearTimeout(card.pendingTimer);
      card.pendingTimer = undefined;
    }

    try {
      // Step 1: Close streaming mode (required before card.update)
      card.sequence++;
      await this.client.cardkit.v1.card.settings({
        path: { card_id: card.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: card.sequence,
        },
      });

      // Step 2: Replace with complete card (matches official buildCompleteCard + toCardKit2)
      const elapsedMs = Date.now() - card.startedAt;
      const displayText = opts?.isError
        ? (card.lastContent
          ? `${card.lastContent}\n\n---\n**Error**: An error occurred while generating the response.`
          : '**Error**: An error occurred while generating the response.')
        : (card.lastContent || '');
      const completeCard = buildCompleteCard(displayText, {
        elapsedMs,
        isError: opts?.isError,
        reasoningText: opts?.reasoningText,
        reasoningElapsedMs: opts?.reasoningElapsedMs,
      });

      card.sequence++;
      await this.client.cardkit.v1.card.update({
        path: { card_id: card.cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(completeCard) },
          sequence: card.sequence,
        },
      });

      logger.info({ keyOrJid, cardId: card.cardId, elapsedMs, isError: opts?.isError }, 'Streaming ended');
    } catch (err) {
      logger.warn({ keyOrJid, err }, 'Failed to end streaming');
    }
  }

  /** Try post fallback; on failure queue the message (unless message was recalled). */
  private async _sendPostWithQueue(
    jid: string,
    text: string,
    replyToMessageId?: string,
    mentionUser?: { id: string; name: string },
  ): Promise<void> {
    try {
      await this._sendPostFallback(jid, text, replyToMessageId, mentionUser);
    } catch (err) {
      if (err instanceof MessageUnavailableError) {
        logger.warn({ jid, messageId: err.messageId, code: err.apiCode }, 'Reply target unavailable, dropping message');
        return;
      }
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
        const dropped = this.outgoingQueue.shift();
        logger.warn({ jid: dropped?.jid }, 'Outgoing queue full, dropping oldest message');
      }
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err: formatLarkError(err), queueSize: this.outgoingQueue.length },
        'Failed to send Lark message, queued',
      );
    }
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
    const chunks = splitMarkdown(text, MAX_TEXT_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = i === 0 && mentionUser
        ? `${formatMentionForText(mentionUser)} ${chunks[i]}`
        : chunks[i];

      const postContent = markdownToPostContent(chunkText);
      const content = JSON.stringify(postContent);
      await this.sendToChat(jid, content, 'post', i === 0 ? replyToMessageId : undefined);
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
    // Clear pending throttle timers before clearing the map
    for (const card of this.streamingCards.values()) {
      if (card.pendingTimer) clearTimeout(card.pendingTimer);
    }
    this.streamingCards.clear();
    streamingStartTimes.clear();
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
  // Immediate visual feedback is handled by _sendStreaming() which sends
  // a text message before creating the streaming card.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  /**
   * Send an interactive card with buttons/selects.
   * cardJson should be a Lark Card JSON schema 2.0 object.
   */
  async sendCard(jid: string, cardJson: object, replyToMessageId?: string): Promise<void> {
    const createResult = await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });
    const cardId = createResult?.data?.card_id;
    if (!cardId) throw new Error('Failed to create interactive card');

    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
    await this.sendToChat(jid, content, 'interactive', replyToMessageId);
    logger.info({ jid, cardId }, 'Lark interactive card sent');
  }

  async addReaction(_jid: string, messageId: string, emojiType: string): Promise<void> {
    await withMessageGuard(
      messageId,
      () => this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }),
      'im.messageReaction.create',
    );
    logger.info({ messageId, emojiType }, 'Lark reaction added');
  }

  async removeReaction(_jid: string, messageId: string, reactionId: string): Promise<void> {
    await this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    logger.info({ messageId, reactionId }, 'Lark reaction removed');
  }

  async listReactions(_jid: string, messageId: string, emojiType?: string): Promise<Array<{ reactionId: string; emojiType: string; operatorType: string; operatorId: string }>> {
    const reactions: Array<{ reactionId: string; emojiType: string; operatorType: string; operatorId: string }> = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, any> = { page_size: 50 };
      if (emojiType) params.reaction_type = emojiType;
      if (pageToken) params.page_token = pageToken;

      const response = await this.client.im.messageReaction.list({
        path: { message_id: messageId },
        params,
      });

      const items = response?.data?.items;
      if (items && items.length > 0) {
        for (const item of items) {
          reactions.push({
            reactionId: item.reaction_id ?? '',
            emojiType: item.reaction_type?.emoji_type ?? '',
            operatorType: item.operator?.operator_type === 'app' ? 'app' : 'user',
            operatorId: item.operator?.operator_id ?? '',
          });
        }
      }
      pageToken = response?.data?.page_token ?? undefined;
      hasMore = response?.data?.has_more === true && !!pageToken;
    }
    return reactions;
  }

  async updateCard(_jid: string, messageId: string, cardJson: object): Promise<void> {
    await withMessageGuard(
      messageId,
      () => this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(cardJson) },
      }),
      'im.message.patch(interactive)',
    );
    logger.info({ messageId }, 'Lark card updated via PATCH');
  }

  async forwardMessage(messageId: string, targetJid: string): Promise<void> {
    const chatId = extractChatId(targetJid);
    await this.client.im.v1.message.forward({
      path: { message_id: messageId },
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId },
    });
    logger.info({ messageId, targetJid }, 'Lark message forwarded');
  }

  /**
   * Send an image file to a chat.
   * Uploads the image first via im.v1.image.create, then sends it as a message.
   */
  async sendImage(jid: string, imagePath: string, replyToMessageId?: string): Promise<void> {
    const uploadResp = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.readFileSync(imagePath),
      },
    });

    const imageKey = uploadResp?.image_key;
    if (!imageKey) throw new Error('Failed to upload image');

    const content = JSON.stringify({ image_key: imageKey });
    await this.sendToChat(jid, content, 'image', replyToMessageId);
    logger.info({ jid, imagePath, imageKey }, 'Lark image sent');
  }

  /**
   * Send a file to a chat.
   * Uploads the file first via im.v1.file.create, then sends it as a message.
   */
  async sendFile(jid: string, filePath: string, replyToMessageId?: string): Promise<void> {
    const fileName = path.basename(filePath);
    // Determine file type from extension
    const ext = path.extname(fileName).toLowerCase();
    type LarkFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    const fileTypeMap: Record<string, LarkFileType> = {
      '.opus': 'opus', '.ogg': 'opus',
      '.mp4': 'mp4', '.mov': 'mp4', '.avi': 'mp4', '.mkv': 'mp4', '.webm': 'mp4',
      '.pdf': 'pdf',
      '.doc': 'doc', '.docx': 'doc',
      '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
      '.ppt': 'ppt', '.pptx': 'ppt',
    };
    const fileType: LarkFileType = fileTypeMap[ext] || 'stream';

    const uploadResp = await this.client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fs.readFileSync(filePath),
      },
    });

    const fileKey = uploadResp?.file_key;
    if (!fileKey) throw new Error('Failed to upload file');

    const content = JSON.stringify({ file_key: fileKey });
    await this.sendToChat(jid, content, 'file', replyToMessageId);
    logger.info({ jid, filePath, fileKey }, 'Lark file sent');
  }

  /**
   * Edit a previously sent bot message. Supports both card messages (via CardKit)
   * and text/post messages (via message.patch).
   */
  async editMessage(_jid: string, messageId: string, text: string): Promise<void> {
    // Try CardKit path first: convert message_id → card_id, then update the card element.
    let cardId: string | undefined;
    try {
      const convertResult = await this.client.cardkit.v1.card.idConvert({
        data: { message_id: messageId },
      });
      cardId = convertResult?.data?.card_id;
    } catch {
      // Not a card message — fall through to message.patch
    }

    if (cardId) {
      // Apply optimizeMarkdownStyle matching official editMessageFeishu
      const optimized = optimizeMarkdownStyle(text);
      await withMessageGuard(
        messageId,
        () => this.client.cardkit.v1.cardElement.content({
          path: { card_id: cardId!, element_id: STREAMING_ELEMENT_ID },
          data: { content: optimized, sequence: Date.now() },
        }),
        'cardkit.cardElement.content(edit)',
      );
      logger.info({ messageId, cardId, length: text.length }, 'Lark card message edited');
      return;
    }

    // Fallback: edit text/post messages — matches official editMessageFeishu
    const postContent = markdownToPostContent(text);
    await withMessageGuard(
      messageId,
      () => this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(postContent),
        },
      }),
      'im.message.update(post)',
    );
    logger.info({ messageId, length: text.length }, 'Lark message edited');
  }

  /**
   * Fetch recent chat history from Lark API.
   * Returns messages in reverse chronological order (newest first).
   */
  async getChatHistory(jid: string, count: number, beforeTimestamp?: string): Promise<ChatHistoryMessage[]> {
    const chatId = extractChatId(jid);
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
          ? new Date(Number(item.create_time)).toISOString()
          : '',
      };
    });
  }

  /**
   * Expand a merge_forward message by fetching sub-messages via Lark API.
   * Matches official convertMergeForward — builds tree from flat items array.
   */
  private async expandMergeForward(messageId: string): Promise<string> {
    if (!messageId) return '<forwarded_messages/>';
    try {
      // Fetch sub-messages from merge_forward container
      const resp = await (this.client as any).im.v1.message.list({
        params: {
          container_id_type: 'merge_forward',
          container_id: messageId,
          page_size: 50,
          sort_type: 'ByCreateTimeAsc',
        },
      });
      const items = resp?.data?.items;
      if (!items || items.length === 0) return '<forwarded_messages/>';

      const parts: string[] = [];
      for (const item of items) {
        try {
          const msgType = item.msg_type ?? 'text';
          const senderId = item.sender?.id ?? 'unknown';
          const createTime = item.create_time
            ? millisToDatetime(parseInt(String(item.create_time), 10))
            : 'unknown';
          const rawContent = item.body?.content ?? '{}';

          let subContent = '';
          if (msgType === 'text') {
            const p = JSON.parse(rawContent);
            subContent = p.text ?? '';
          } else if (msgType === 'post') {
            const p = JSON.parse(rawContent);
            subContent = p.title ?? '';
          } else if (msgType === 'image') {
            subContent = '[image]';
          } else if (msgType === 'file') {
            const p = JSON.parse(rawContent);
            subContent = `[file: ${p.file_name ?? 'unknown'}]`;
          } else if (msgType === 'merge_forward') {
            subContent = '<forwarded_messages/>'; // Don't recurse to avoid API call storms
          } else {
            try {
              const p = JSON.parse(rawContent);
              subContent = p.text ?? `[${msgType}]`;
            } catch {
              subContent = `[${msgType}]`;
            }
          }

          const indented = subContent.split('\n').map(l => `    ${l}`).join('\n');
          parts.push(`[${createTime}] ${senderId} (${item.message_id ?? ''}):\n${indented}`);
        } catch {
          // Skip malformed sub-messages
        }
      }
      if (parts.length === 0) return '<forwarded_messages/>';
      return `<forwarded_messages>\n${parts.join('\n')}\n</forwarded_messages>`;
    } catch (err) {
      logger.debug({ messageId, err }, 'merge_forward: fetch failed, returning placeholder');
      return '<forwarded_messages/>';
    }
  }

  /** Download embedded images and return updated content with file references. */
  private async downloadImages(
    jid: string,
    messageId: string,
    imageKeys: string[],
    groupFolder: string,
    content: string,
  ): Promise<string> {
    try {
      const tmpDir = path.join(process.cwd(), 'groups', groupFolder, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });

      const results = await Promise.allSettled(imageKeys.map(async (imageKey) => {
        const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
        const destPath = path.join(tmpDir, filename);
        const resp = await this.client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: imageKey },
          params: { type: 'image' },
        });
        if (resp) {
          await resp.writeFile(destPath);
          try { fs.chownSync(destPath, 1000, 1000); } catch { /* non-root */ }
          logger.info({ jid, imageKey, destPath }, 'Image downloaded for agent');
          return `/workspace/group/tmp/${filename}`;
        }
        return null;
      }));
      const downloadedPaths = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null)
        .map((r) => r.value);

      if (downloadedPaths.length > 0) {
        const imageRef = downloadedPaths.length === 1
          ? `[User sent an image. File saved at: ${downloadedPaths[0]} — use the Read tool to view it]`
          : `[User sent ${downloadedPaths.length} images. Files saved at: ${downloadedPaths.join(', ')} — use the Read tool to view them]`;
        return content ? `${content}\n${imageRef}` : `@${ASSISTANT_NAME} ${imageRef}`;
      }
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to download image');
    }
    return content;
  }

  /** Download a file attachment and return updated content with file reference. */
  private async downloadFile(
    jid: string,
    messageId: string,
    rawContent: string,
    groupFolder: string,
    content: string,
  ): Promise<string> {
    try {
      const parsed = JSON.parse(rawContent);
      const fileKey = parsed.file_key;
      // Sanitize fileName to prevent path traversal (e.g. "../../etc/passwd")
      const fileName = path.basename(parsed.file_name || `file_${Date.now()}`);
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
        const fileRef = `[User sent a file: ${fileName}. File saved at: /workspace/group/tmp/${fileName} — use the Read tool to view it]`;
        content = content ? `${content}\n${fileRef}` : `@${ASSISTANT_NAME} ${fileRef}`;
        logger.info({ jid, fileKey, destPath }, 'File downloaded for agent');
      }
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to download file');
    }
    return content;
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
    const SYNC_TIMEOUT_MS = 30_000;
    try {
      logger.info('Syncing chat metadata from Lark...');
      let pageToken: string | undefined;
      const allChats: Array<{ jid: string; name: string }> = [];
      const deadline = Date.now() + SYNC_TIMEOUT_MS;

      do {
        if (Date.now() > deadline) {
          logger.warn({ count: allChats.length }, 'Lark chat metadata sync timed out, partial results saved');
          break;
        }

        const result = await this.client.im.v1.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        const items = result?.data?.items || [];
        for (const chat of items) {
          if (chat.chat_id && chat.name) {
            allChats.push({ jid: `lark:${chat.chat_id}`, name: chat.name });
          }
        }

        pageToken = result?.data?.page_token || undefined;
      } while (pageToken);

      if (allChats.length > 0) {
        updateChatNamesBatch(allChats);
      }
      logger.info({ count: allChats.length }, 'Lark chat metadata synced');
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
        const item = this.outgoingQueue[0];
        await this._sendStreaming(item.jid, item.text);
        this.outgoingQueue.shift();
      }
    } finally {
      this.flushing = false;
    }
  }
}
