import type { NewMessage } from './types.js';

const SESSION_COMMANDS = new Set(['/compact']);

/**
 * Extract a session slash command from a message, stripping the trigger prefix.
 * Returns the command (e.g. '/compact') or null.
 */
export function extractSessionCommand(content: string, triggerPattern: RegExp): string | null {
  const text = content.trim().replace(triggerPattern, '').trim();
  if (SESSION_COMMANDS.has(text)) return text;
  return null;
}

/**
 * Session commands require admin access: main group (any sender) or device owner.
 */
export function isSessionCommandAllowed(isMainGroup: boolean, isFromMe: boolean): boolean {
  return isMainGroup || isFromMe;
}

/**
 * Scan messages for a session command. Returns the command message if found and authorized,
 * or { denied: true } if unauthorized, or null if no command found.
 */
export function findSessionCommand(
  messages: NewMessage[],
  triggerPattern: RegExp,
  isMainGroup: boolean,
): { msg: NewMessage; command: string } | { denied: NewMessage } | null {
  for (const msg of messages) {
    const command = extractSessionCommand(msg.content, triggerPattern);
    if (!command) continue;
    if (!isSessionCommandAllowed(isMainGroup, msg.is_from_me === true)) {
      return { denied: msg };
    }
    return { msg, command };
  }
  return null;
}
