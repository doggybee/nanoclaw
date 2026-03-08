/**
 * Message unavailability guard — ported from official feishu-openclaw-plugin.
 * Tracks recalled/deleted messages and prevents cascading API errors.
 */

// Terminal Lark API codes for unavailable messages
const TERMINAL_MESSAGE_CODES = new Set([230011, 231003]);
const UNAVAILABLE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE_BEFORE_PRUNE = 512;

interface UnavailableState {
  apiCode: number;
  operation?: string;
  markedAtMs: number;
}

const unavailableMessages = new Map<string, UnavailableState>();

/** Normalize composite message IDs (e.g. "om_xxx:auth-complete" → "om_xxx"). */
export function normalizeMessageId(messageId: string | undefined): string | undefined {
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
export function extractLarkApiCode(err: any): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return coerceCode(err.code)
    ?? coerceCode(err.data?.code)
    ?? coerceCode(err.response?.data?.code);
}

/** Check if an API code indicates terminal message unavailability. */
export function isTerminalMessageApiCode(code: number | undefined): boolean {
  return code !== undefined && TERMINAL_MESSAGE_CODES.has(code);
}

export class MessageUnavailableError extends Error {
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
 * - Post-check: detect terminal codes, mark + throw MessageUnavailableError
 */
export async function withMessageGuard<T>(
  messageId: string | undefined,
  fn: () => Promise<T>,
  operation?: string,
): Promise<T> {
  const normalizedId = normalizeMessageId(messageId);
  if (!normalizedId) return fn();

  // Pre-check
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

/**
 * Format a user-friendly error message from a Lark SDK / Axios error.
 * For permission errors (99991672) includes scopes + auth URL.
 */
export function formatLarkError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as any;
  // Path 1: Lark SDK merges fields onto thrown error
  if (typeof e.code === 'number' && e.msg) {
    const permMsg = formatPermissionError(e.code, e.msg);
    if (permMsg) return permMsg;
    return e.msg;
  }
  // Path 2: Axios error
  const data = e.response?.data;
  if (data && typeof data.code === 'number' && data.msg) {
    const permMsg = formatPermissionError(data.code, data.msg);
    if (permMsg) return permMsg;
    return data.msg;
  }
  return e.message ?? String(err);
}

function formatPermissionError(code: number, msg: string): string | null {
  if (code !== 99991672) return null;
  const urlMatch = msg.match(/https:\/\/[^\s]+\/app\/[^\s]+/);
  const authUrl = urlMatch?.[0] ?? '';
  const scopeMatch = msg.match(/\[([^\]]+)\]/);
  const scopes = scopeMatch?.[1] ?? 'unknown';
  return `权限不足：应用缺少 [${scopes}] 权限。\n请管理员点击以下链接申请并开通权限：\n${authUrl}`;
}
