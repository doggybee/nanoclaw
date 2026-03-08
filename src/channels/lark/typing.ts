/**
 * Typing indicator via emoji reactions.
 * Ported from official feishu-openclaw-plugin typing.js.
 *
 * Feishu has no first-class typing API. This module simulates it by adding
 * a "Typing" emoji reaction to the user's message while processing, and
 * removing it once the response is ready.
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../../logger.js';
import {
  withMessageGuard,
  MessageUnavailableError,
  normalizeMessageId,
} from './message-guard.js';

const TYPING_EMOJI_TYPE = 'Typing';

export interface TypingState {
  messageId: string;
  reactionId: string | null;
}

/**
 * Add a typing indicator (emoji reaction) to a message.
 * Best-effort — errors are caught and logged, never propagated.
 */
export async function addTypingIndicator(
  client: Lark.Client,
  messageId: string,
): Promise<TypingState | null> {
  const normalizedId = normalizeMessageId(messageId);
  if (!normalizedId) return null;

  const state: TypingState = { messageId: normalizedId, reactionId: null };
  try {
    const response: any = await withMessageGuard(
      normalizedId,
      () => client.im.messageReaction.create({
        path: { message_id: normalizedId },
        data: { reaction_type: { emoji_type: TYPING_EMOJI_TYPE } },
      }) as any,
      'im.messageReaction.create(typing)',
    );
    state.reactionId = response?.data?.reaction_id ?? null;
  } catch (err) {
    if (err instanceof MessageUnavailableError) {
      logger.debug({ messageId: normalizedId }, 'Typing indicator skipped: message unavailable');
      return state;
    }
    logger.debug({ messageId, err }, 'Failed to add typing indicator');
  }
  return state;
}

/**
 * Remove a previously added typing indicator reaction.
 * Best-effort — errors are caught and logged, never propagated.
 */
export async function removeTypingIndicator(
  client: Lark.Client,
  state: TypingState | null,
): Promise<void> {
  if (!state?.reactionId) return;
  try {
    await withMessageGuard(
      state.messageId,
      () => client.im.messageReaction.delete({
        path: { message_id: state.messageId, reaction_id: state.reactionId! },
      }) as any,
      'im.messageReaction.delete(typing)',
    );
  } catch (err) {
    if (err instanceof MessageUnavailableError) return;
    logger.debug({ state, err }, 'Failed to remove typing indicator');
  }
}
