/**
 * Reply session — manages the lifecycle of one streaming card reply.
 *
 * Flush strategy: time-based throttle (100ms from caller) + in-flight guard.
 * Only one CardKit API call runs at a time. If new content arrives during
 * a call, a re-flush is scheduled immediately after the call completes.
 * This matches the official feishu-plugin pattern.
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
  buildSimpleMarkdownCard,
  STREAMING_ELEMENT_ID,
  type CompleteCardOpts,
} from './card-builder.js';
import { optimizeMarkdownStyle } from './markdown-style.js';

function log(message: string): void {
  console.error(`[reply-session] ${message}`);
}

export interface ReplySessionOpts {
  replyToMessageId?: string;
  startedAt?: number;
}

export class ReplySession {
  // CardKit entity ID (from createCardEntity). Nulled on CardKit failure
  // to switch subsequent flushes to IM patch mode.
  private cardKitCardId: string | null = null;
  // Original CardKit card ID — kept even after fallback so finalize()
  // can still close streaming mode and update the card structure.
  private originalCardKitCardId: string | null = null;

  /** Whether CardKit streaming is active (vs IM patch fallback). */
  get isCardKit(): boolean { return this.cardKitCardId !== null; }
  // IM message ID (from sendCardByCardId). Used for IM patch fallback.
  private cardMessageId: string | null = null;

  private cardCreationPromise: Promise<void> | null = null;
  cardCreationFailed = false;
  private cardCompleted = false;
  private cardKitSequence = 0;
  private lastContent = '';
  private _optimizedContent = '';
  private _optimizedFor = '';
  private readonly startedAt: number;

  private flushCount = 0;
  // In-flight guard: prevents concurrent CardKit calls that cause
  // sequence reordering (300317 errors).
  private flushInProgress = false;
  private needsReflush = false;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Whether a card has been created (either CardKit or IM patch). */
  private get cardReady(): boolean {
    return !!this.cardMessageId;
  }

  /** Whether a card was successfully created and content was delivered to the user. */
  get outputDelivered(): boolean {
    return !this.cardCreationFailed && !!this.cardMessageId;
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
        // Step 1: Create CardKit card entity
        const cardId = await createCardEntity(this.client, buildThinkingCardJson());
        if (!cardId) throw new Error('card.create returned empty card_id');

        this.cardKitCardId = cardId;
        this.originalCardKitCardId = cardId;
        this.cardKitSequence = 1;

        // Step 2: Send IM message referencing the card
        const messageId = await sendCardByCardId(
          this.client,
          this.chatId,
          cardId,
          this.opts.replyToMessageId,
        );
        this.cardMessageId = messageId;

        log(`card created and sent: cardId=${cardId} messageId=${messageId} chatId=${this.chatId}`);
      } catch (err) {
        log(`CardKit creation failed: ${err instanceof Error ? err.message : String(err)}, trying IM fallback`);

        // Fallback: plain IM card (no CardKit streaming)
        try {
          const resp = await this.client.im.v1.message.create({
            data: {
              receive_id: this.chatId,
              msg_type: 'interactive',
              content: JSON.stringify(buildSimpleMarkdownCard('思考中...')),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const messageId = resp?.data?.message_id;
          if (!messageId) throw new Error('IM message.create returned empty message_id');

          this.cardMessageId = messageId;
          log(`IM fallback active: messageId=${messageId}`);
        } catch (imErr) {
          log(`IM fallback also failed: ${imErr instanceof Error ? imErr.message : String(imErr)}`);
          this.cardCreationFailed = true;
        }
      }

      // Flush any buffered content that arrived during card creation
      if (this.lastContent && !this.cardCompleted && this.cardReady) {
        this.flushCardUpdate();
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
   * SYNCHRONOUS — never awaits. Caller (100ms setInterval in index.ts) handles throttling.
   * If card isn't ready yet, content is buffered and flushed when card creation completes.
   */
  pushContent(text: string): boolean {
    if (this.cardCompleted) return false;

    this.lastContent = text;

    // Card not ready — just buffer the content. It will be flushed
    // when ensureCardCreated() completes (see the flush-after-create logic above).
    if (!this.cardReady) return true;

    this.flushCardUpdate();
    return true;
  }

  /**
   * Push accumulated text to the streaming card.
   *
   * When a CardKit card_id is available, uses cardElement.content() for
   * native typewriter animation. Otherwise falls back to im.message.patch.
   *
   * Only one call runs at a time (flushInProgress guard). If new content
   * arrives during a call, needsReflush triggers an immediate follow-up.
   */
  private flushCardUpdate(): void {
    if (!this.cardMessageId || this.cardCompleted) return;

    // If a flush is in flight, mark for re-flush after it completes
    if (this.flushInProgress) {
      this.needsReflush = true;
      return;
    }

    this.flushInProgress = true;
    this.needsReflush = false;
    this.flushCount++;

    // Cache optimizeMarkdownStyle — only recompute when content changes
    if (this.lastContent !== this._optimizedFor) {
      this._optimizedFor = this.lastContent;
      this._optimizedContent = optimizeMarkdownStyle(this.lastContent);
    }
    const optimized = this._optimizedContent;

    if (this.flushCount <= 3 || this.flushCount % 10 === 0) {
      log(`flush #${this.flushCount}: seq=${this.cardKitSequence + 1} len=${this.lastContent.length} cardkit=${!!this.cardKitCardId}`);
    }

    if (this.cardKitCardId) {
      // CardKit streaming — increment sequence inside guard
      this.cardKitSequence += 1;
      const seq = this.cardKitSequence;
      streamCardContent(
        this.client,
        this.cardKitCardId,
        STREAMING_ELEMENT_ID,
        optimized,
        seq,
      ).then(() => {
        // success — no action needed
      }).catch((err) => {
        const apiCode = (err as any)?.cardkitCode;
        if (apiCode === 230020) {
          // Rate limited — silently skip, next flush picks up latest text
          log(`flush rate limited (230020), skipping`);
          return;
        }
        log(`streaming flush failed: seq=${seq} err=${err instanceof Error ? err.message : String(err)}`);
        // Disable CardKit streaming, fall back to IM patch on same message
        if (this.cardKitCardId) {
          log(`disabling CardKit streaming, falling back to IM patch`);
          this.cardKitCardId = null;
        }
      }).finally(() => {
        this.flushInProgress = false;
        this.scheduleReflush();
      });
    } else {
      // IM patch fallback — update the same card message
      this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId! },
        data: { content: JSON.stringify(buildSimpleMarkdownCard(optimized)) },
      }).catch((err) => {
        const code = (err as any)?.response?.data?.code;
        if (code === 230020) {
          log(`IM patch rate limited (230020), skipping`);
          return;
        }
        log(`IM patch update failed: err=${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        this.flushInProgress = false;
        this.scheduleReflush();
      });
    }
  }

  /** If content arrived during an in-flight flush, re-flush immediately. */
  private scheduleReflush(): void {
    if (this.needsReflush && !this.pendingFlushTimer && !this.cardCompleted) {
      this.needsReflush = false;
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        this.flushCardUpdate();
      }, 0);
    }
  }

  // ---- finalize ----

  async finalize(opts?: CompleteCardOpts): Promise<void> {
    if (this.cardCompleted) return;
    this.cardCompleted = true;

    // Cancel any pending re-flush
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
    }

    // Wait for any in-flight flush to complete
    if (this.flushInProgress) {
      await new Promise<void>(resolve => {
        const check = () => {
          if (!this.flushInProgress) { resolve(); return; }
          setTimeout(check, 10);
        };
        check();
      });
    }

    // Use originalCardKitCardId for finalization — even if we fell back
    // to IM patch mid-stream, the original CardKit card still needs its
    // streaming mode closed and structure updated.
    const effectiveCardId = this.originalCardKitCardId;

    if (!effectiveCardId && this.cardMessageId) {
      // Pure IM fallback (CardKit never worked) — update via im.message.patch
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

    if (!effectiveCardId) return;

    try {
      // Close streaming mode
      this.cardKitSequence += 1;
      await setCardStreamingMode(this.client, effectiveCardId, false, this.cardKitSequence);

      // Build and apply final card
      const elapsedMs = Date.now() - this.startedAt;
      const completeCard = buildCompleteCard(
        this.lastContent || 'Done.',
        { ...opts, elapsedMs },
      );

      this.cardKitSequence += 1;
      await updateCardKitCard(this.client, effectiveCardId, completeCard, this.cardKitSequence);

      log(`card finalized: cardId=${effectiveCardId} elapsedMs=${elapsedMs} flushes=${this.flushCount}`);
    } catch (err) {
      log(`finalize failed: cardId=${effectiveCardId} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async abort(): Promise<void> {
    await this.finalize({ isError: true });
  }

  destroy(): void {
    this.cardCompleted = true;
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }
}
