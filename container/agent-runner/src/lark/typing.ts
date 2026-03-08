/**
 * Typing indicator via emoji reactions.
 * Ported from host src/channels/lark/typing.ts.
 */
import type { Client } from '@larksuiteoapi/node-sdk';

const TYPING_EMOJI_TYPE = 'Typing';

export interface TypingState {
  messageId: string;
  reactionId: string | null;
}

export async function addTypingIndicator(
  client: Client,
  messageId: string,
): Promise<TypingState | null> {
  if (!messageId) return null;

  const state: TypingState = { messageId, reactionId: null };
  try {
    const response: any = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI_TYPE } },
    });
    state.reactionId = response?.data?.reaction_id ?? null;
  } catch (err) {
    console.error(`[typing] Failed to add typing indicator: ${err instanceof Error ? err.message : String(err)}`);
  }
  return state;
}

export async function removeTypingIndicator(
  client: Client,
  state: TypingState | null,
): Promise<void> {
  if (!state?.reactionId) return;
  try {
    await client.im.messageReaction.delete({
      path: { message_id: state.messageId, reaction_id: state.reactionId },
    });
  } catch {
    // Best-effort
  }
}
