/**
 * Reply session — manages the lifecycle of one streaming card reply.
 * Ported from host src/channels/lark/reply-session.ts.
 * Uses the container's larkClient singleton.
 *
 * Flush strategy: time-based throttle (100ms) + fire-and-forget.
 * pushContent is synchronous — buffers content until card is ready,
 * then flushes with 100ms throttle. API calls are fire-and-forget.
 */
import type { Client } from '@larksuiteoapi/node-sdk';

import {
  createCardEntity,
  streamCardContent,
  updateCardKitCard,
  setCardStreamingMode,
  sendCardByCardId,
} from './cardkit.js';
import {
  buildThinkingCardJson,
  buildCompleteCard,
  STREAMING_ELEMENT_ID,
  type CompleteCardOpts,
} from './card-builder.js';
import { optimizeMarkdownStyle } from './markdown-style.js';
import { addTypingIndicator, removeTypingIndicator, type TypingState } from './typing.js';

const STREAMING_THROTTLE_MS = 100;

function log(message: string): void {
  console.error(`[reply-session] ${message}`);
}

export interface ReplySessionOpts {
  replyToMessageId?: string;
  startedAt?: number;
}

export class ReplySession {
  private cardId: string | null = null;
  private cardCreationPromise: Promise<void> | null = null;
  private cardReady = false;
  cardCreationFailed = false;
  private cardCompleted = false;
  private sequence = 0;
  private lastUpdateMs = 0;
  private lastContent = '';
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly startedAt: number;

  private flushCount = 0;
  private consecutiveFailures = 0;
  private static readonly MAX_STREAM_FAILURES = 3;

  // IM patch fallback state (level 2)
  private cardMessageId: string | null = null;
  private useImPatch = false;

  private typingState: TypingState | null = null;
  private typingStopped = false;

  constructor(
    private readonly client: Client,
    private readonly chatId: string,
    private readonly opts: ReplySessionOpts,
  ) {
    this.startedAt = opts.startedAt ?? Date.now();
  }

  get isActive(): boolean {
    return !this.cardCompleted;
  }

  /** Whether a card was successfully created and content was delivered to the user. */
  get outputDelivered(): boolean {
    return !this.cardCreationFailed && !!(this.cardId || this.cardMessageId);
  }

  // ---- Typing indicator ----

  private async startTyping(): Promise<void> {
    if (this.typingStopped || !this.opts.replyToMessageId) return;
    if (this.typingState?.reactionId) return;

    this.typingState = await addTypingIndicator(this.client, this.opts.replyToMessageId);

    if (this.typingStopped && this.typingState) {
      await removeTypingIndicator(this.client, this.typingState);
      this.typingState = null;
    }
  }

  private async stopTyping(): Promise<void> {
    this.typingStopped = true;
    if (!this.typingState) return;
    await removeTypingIndicator(this.client, this.typingState);
    this.typingState = null;
  }

  // ---- ensureCardCreated ----

  async ensureCardCreated(): Promise<void> {
    if (this.cardReady || this.cardCreationFailed || this.cardCompleted) return;

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }

    this.cardCreationPromise = (async () => {
      try {
        this.startTyping().catch(() => {});

        const cardId = await createCardEntity(this.client, buildThinkingCardJson());
        if (!cardId) throw new Error('card.create returned empty card_id');

        this.cardId = cardId;
        this.sequence = 1;

        await sendCardByCardId(
          this.client,
          this.chatId,
          cardId,
          this.opts.replyToMessageId,
        );

        this.cardReady = true;
        log(`card created and sent: cardId=${cardId} chatId=${this.chatId}`);

        // Flush any buffered content that arrived during card creation
        if (this.lastContent && !this.cardCompleted) {
          this.flushContent();
        }
      } catch (err) {
        log(`CardKit creation failed: ${err instanceof Error ? err.message : String(err)}, trying IM patch fallback`);

        // Level 2: IM patch fallback
        try {
          const cardJson = {
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: '思考中...' }],
          };
          const resp = await this.client.im.v1.message.create({
            data: {
              receive_id: this.chatId,
              msg_type: 'interactive',
              content: JSON.stringify(cardJson),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const messageId = resp?.data?.message_id;
          if (!messageId) throw new Error('IM message.create returned empty message_id');

          this.cardMessageId = messageId;
          this.useImPatch = true;
          this.cardReady = true;
          log(`IM patch fallback active: messageId=${messageId}`);

          // Flush buffered content
          if (this.lastContent && !this.cardCompleted) {
            this.flushContent();
          }
        } catch (imErr) {
          log(`IM patch fallback also failed: ${imErr instanceof Error ? imErr.message : String(imErr)}`);
          this.cardCreationFailed = true;
        }
      }
    })();

    try {
      await this.cardCreationPromise;
    } finally {
      this.cardCreationPromise = null;
    }
  }

  // ---- pushContent ----

  /**
   * Push new content to the streaming card.
   * SYNCHRONOUS — never awaits. Matches main branch fire-and-forget pattern.
   * If card isn't ready yet, content is buffered and flushed when card creation completes.
   */
  pushContent(text: string): boolean {
    if (this.cardCompleted) return false;

    this.lastContent = text;

    // Card not ready — just buffer the content. It will be flushed
    // when ensureCardCreated() completes (see the flush-after-create logic above).
    if (!this.cardReady) return true;

    const now = Date.now();
    const elapsed = now - this.lastUpdateMs;

    if (elapsed < STREAMING_THROTTLE_MS) {
      // Too soon — schedule a deferred flush
      if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        this.flushContent();
      }, STREAMING_THROTTLE_MS - elapsed);
      return true;
    }

    this.flushContent();
    return true;
  }

  private flushContent(): void {
    if ((!this.cardId && !this.cardMessageId) || this.cardCompleted) return;

    this.flushCount++;
    const nextSeq = this.sequence + 1;
    this.sequence = nextSeq;
    this.lastUpdateMs = Date.now();

    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    const optimized = optimizeMarkdownStyle(this.lastContent);

    if (this.flushCount <= 3 || this.flushCount % 10 === 0) {
      log(`flush #${this.flushCount}: seq=${nextSeq} len=${this.lastContent.length}`);
    }

    if (this.useImPatch && this.cardMessageId) {
      // Level 2: IM patch — fire-and-forget
      const cardJson = {
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: optimized }],
      };
      this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: { content: JSON.stringify(cardJson) },
      }).catch((err) => {
        log(`IM patch update failed: messageId=${this.cardMessageId} err=${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (this.cardId) {
      // Level 1: CardKit streaming — fire-and-forget
      streamCardContent(
        this.client,
        this.cardId,
        STREAMING_ELEMENT_ID,
        optimized,
        nextSeq,
      ).then(() => {
        this.consecutiveFailures = 0;
      }).catch((err) => {
        this.consecutiveFailures++;
        if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 5 === 0) {
          log(`streaming flush failed: seq=${nextSeq} failures=${this.consecutiveFailures} err=${err instanceof Error ? err.message : String(err)}`);
        }

        // Auto-fallback to IM patch after repeated failures
        if (this.consecutiveFailures >= ReplySession.MAX_STREAM_FAILURES) {
          log(`CardKit streaming failed ${this.consecutiveFailures} times, falling back to IM patch`);
          this.switchToImPatch();
        }
      });
    }
  }

  /** Switch from CardKit streaming to IM patch mode mid-session. */
  private switchToImPatch(): void {
    if (this.useImPatch || !this.cardId) return;

    const cardJson = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: this.lastContent || '...' }],
    };
    this.client.im.v1.message.create({
      data: {
        receive_id: this.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(cardJson),
      },
      params: { receive_id_type: 'chat_id' },
    }).then((resp) => {
      const messageId = resp?.data?.message_id;
      if (messageId) {
        this.cardMessageId = messageId;
        this.useImPatch = true;
        this.consecutiveFailures = 0;
        log(`Switched to IM patch fallback: messageId=${messageId}`);
      }
    }).catch((imErr) => {
      log(`IM patch fallback switch failed: ${imErr instanceof Error ? imErr.message : String(imErr)}`);
    });
  }

  // ---- finalize ----

  async finalize(opts?: CompleteCardOpts): Promise<void> {
    if (this.cardCompleted) return;
    this.cardCompleted = true;

    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    await this.stopTyping().catch(() => {});

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
    }

    if (this.useImPatch && this.cardMessageId) {
      // IM patch finalize: update card with final content
      try {
        const elapsedMs = Date.now() - this.startedAt;
        const content = this.lastContent || 'Done.';
        const optimized = optimizeMarkdownStyle(content);
        const footer = opts?.isError ? '❌ Error' : `⏱ ${(elapsedMs / 1000).toFixed(1)}s`;
        const cardJson = {
          config: { wide_screen_mode: true },
          elements: [
            { tag: 'markdown', content: optimized },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: footer }] },
          ],
        };
        await this.client.im.v1.message.patch({
          path: { message_id: this.cardMessageId },
          data: { content: JSON.stringify(cardJson) },
        });
        log(`IM patch finalized: messageId=${this.cardMessageId} elapsedMs=${elapsedMs}`);
      } catch (err) {
        log(`IM patch finalize failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (!this.cardId) return;

    try {
      this.sequence += 1;
      await setCardStreamingMode(this.client, this.cardId, false, this.sequence);

      const elapsedMs = Date.now() - this.startedAt;
      const completeCard = buildCompleteCard(
        this.lastContent || 'Done.',
        { ...opts, elapsedMs },
      );

      this.sequence += 1;
      await updateCardKitCard(this.client, this.cardId, completeCard, this.sequence);

      log(`card finalized: cardId=${this.cardId} elapsedMs=${elapsedMs} flushes=${this.flushCount} failures=${this.consecutiveFailures}`);
    } catch (err) {
      log(`finalize failed: cardId=${this.cardId} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async abort(): Promise<void> {
    await this.finalize({ isError: true });
  }

  destroy(): void {
    this.cardCompleted = true;
    this.typingStopped = true;
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }
}
