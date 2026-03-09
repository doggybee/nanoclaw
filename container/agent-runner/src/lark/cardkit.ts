/**
 * CardKit streaming APIs for Feishu/Lark.
 * Ported from host src/channels/lark/cardkit.ts.
 * Uses the container's larkClient singleton.
 */
import type { Client } from '@larksuiteoapi/node-sdk';

function log(message: string): void {
  console.error(`[cardkit] ${message}`);
}

export async function createCardEntity(
  client: Client,
  card: Record<string, any>,
): Promise<string | null> {
  const response = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  const cardId = response?.data?.card_id ?? (response as any)?.card_id ?? null;
  if (!cardId) {
    log(`createCardEntity: empty card_id, response: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return cardId;
}

export async function streamCardContent(
  client: Client,
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
    const msg = (resp as any)?.msg || '';
    log(`cardElement.content failed: cardId=${cardId} seq=${sequence} code=${code} msg=${msg}`);
    const err = new Error(`CardKit streaming error ${code}: ${msg}`);
    (err as any).cardkitCode = code;
    throw err;
  }
}

export async function updateCardKitCard(
  client: Client,
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
    log(`card.update failed: cardId=${cardId} seq=${sequence} code=${code}`);
  }
}

export async function sendCardByCardId(
  client: Client,
  chatId: string,
  cardId: string,
  replyToMessageId?: string,
): Promise<string | null> {
  const contentPayload = JSON.stringify({
    type: 'card',
    data: { card_id: cardId },
  });

  if (replyToMessageId) {
    const resp = await client.im.v1.message.reply({
      path: { message_id: replyToMessageId },
      data: { content: contentPayload, msg_type: 'interactive' },
    });
    return resp?.data?.message_id ?? null;
  } else {
    const resp = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: contentPayload,
      },
    });
    return resp?.data?.message_id ?? null;
  }
}

export async function setCardStreamingMode(
  client: Client,
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
    log(`card.settings failed: cardId=${cardId} seq=${sequence} streamingMode=${streamingMode} code=${code}`);
  }
}
