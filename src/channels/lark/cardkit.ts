/**
 * CardKit streaming APIs for Feishu/Lark.
 * Ported from official @larksuiteoapi/feishu-openclaw-plugin cardkit.js.
 *
 * All functions accept a Lark SDK client instance directly (NanoClaw uses
 * a single client per channel, unlike the official plugin's multi-account model).
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../../logger.js';
import { withMessageGuard } from './message-guard.js';

/**
 * Create a card entity via the CardKit API.
 * Returns the card_id, or null on failure.
 */
export async function createCardEntity(
  client: Lark.Client,
  card: Record<string, any>,
): Promise<string | null> {
  const response = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  return response?.data?.card_id ?? (response as any)?.card_id ?? null;
}

/**
 * Stream text content to a specific card element using CardKit API.
 * The card diffs new content against previous and renders with typewriter animation.
 *
 * @param sequence - Monotonically increasing sequence number.
 */
export async function streamCardContent(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  const resp = await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  });
  const code = (resp as any)?.code;
  if (code && code !== 0) {
    logger.warn({ cardId, sequence, code }, 'cardkit cardElement.content failed');
  }
}

/**
 * Fully replace a card using the CardKit API.
 * Used for the final "complete" state update after streaming finishes.
 */
export async function updateCardKitCard(
  client: Lark.Client,
  cardId: string,
  card: Record<string, any>,
  sequence: number,
): Promise<void> {
  const resp = await client.cardkit.v1.card.update({
    data: {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    },
    path: { card_id: cardId },
  });
  const code = (resp as any)?.code;
  if (code && code !== 0) {
    logger.warn({ cardId, sequence, code }, 'cardkit card.update failed');
  }
}

/**
 * Send an interactive card message by referencing a CardKit card_id.
 * Links the IM message to the CardKit card entity for streaming updates.
 *
 * @param jid - The "lark:{chatId}" JID. Chat ID is extracted internally.
 * @param replyToMessageId - Optional message to reply to.
 */
export async function sendCardByCardId(
  client: Lark.Client,
  jid: string,
  cardId: string,
  replyToMessageId?: string,
): Promise<void> {
  const contentPayload = JSON.stringify({
    type: 'card',
    data: { card_id: cardId },
  });

  if (replyToMessageId) {
    await withMessageGuard(
      replyToMessageId,
      () => client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { content: contentPayload, msg_type: 'interactive' },
      }),
      'im.message.reply(interactive.cardkit)',
    );
  } else {
    const chatId = jid.replace(/^lark:/, '');
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: contentPayload,
      },
    });
  }
}

/**
 * Close (or open) streaming mode on a CardKit card.
 * Must be called after streaming to restore normal card behavior.
 */
export async function setCardStreamingMode(
  client: Lark.Client,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<void> {
  const resp = await client.cardkit.v1.card.settings({
    data: {
      settings: JSON.stringify({ streaming_mode: streamingMode }),
      sequence,
    },
    path: { card_id: cardId },
  });
  const code = (resp as any)?.code;
  if (code && code !== 0) {
    logger.warn({ cardId, sequence, streamingMode, code }, 'cardkit card.settings failed');
  }
}
