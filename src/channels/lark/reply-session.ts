/**
 * Reply session — manages the lifecycle of one streaming card reply.
 *
 * Adapted from the official feishu-openclaw-plugin's reply-dispatcher.js.
 * Each session corresponds to one slot (one user in one group) and handles:
 *   1. Typing indicator (emoji reaction on user's message)
 *   2. Lazy card creation (ensureCardCreated — only on first content)
 *   3. Throttled content streaming with concurrent flush mutex
 *   4. Long-gap deferred batching (matches official BATCH_AFTER_GAP_MS)
 *   5. Card finalization (finalize → close streaming + complete card)
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../../logger.js';
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

// Matches official plugin's CARDKIT_THROTTLE_MS.
const STREAMING_THROTTLE_MS = 100;
// After a long gap (tool call / LLM thinking), batch briefly so the first
// visible update contains meaningful text rather than just 1-2 characters.
const LONG_GAP_THRESHOLD_MS = 2000;
const BATCH_AFTER_GAP_MS = 300;

export interface ReplySessionOpts {
  /** Message to reply to (first message in the batch). */
  replyToMessageId?: string;
  /** When the user's message was received (for elapsed time display). */
  startedAt?: number;
  /** Shared card pool — sessions borrow pre-created card IDs from here. */
  cardPool?: string[];
  /** Callback to refill the shared card pool after borrowing. */
  refillCardPool?: () => void;
}

/**
 * A single streaming reply session for one slot.
 *
 * State machine matches the official plugin's reply-dispatcher:
 *   (idle) → ensureCardCreated → pushContent* → finalize
 */
export class ReplySession {
  // ---- State matching official reply-dispatcher.js ----
  /** CardKit card entity ID (set after card.create). */
  private cardId: string | null = null;
  /** Promise for in-progress card creation (prevents race conditions). */
  private cardCreationPromise: Promise<void> | null = null;
  /** True if card creation failed — skip further streaming attempts. */
  private cardCreationFailed = false;
  /** True after finalize() — guard against duplicate finalization. */
  private cardCompleted = false;
  /** Monotonically increasing sequence for CardKit operations. */
  private sequence = 0;
  /** Timestamp of last cardElement.content() call — for throttling. */
  private lastUpdateMs = 0;
  /** Last pushed text — for building the final complete card. */
  private lastContent = '';
  /** Pending deferred flush timer. */
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the session started (message receipt time). */
  private readonly startedAt: number;

  // ---- Concurrent flush mutex (matches official flushInProgress) ----
  /** True while a streamCardContent API call is in flight. */
  private flushInProgress = false;
  /** True if new content arrived during an in-flight flush. */
  private needsReflush = false;

  // ---- Typing indicator state ----
  private typingState: TypingState | null = null;
  private typingStopped = false;

  constructor(
    private readonly client: Lark.Client,
    private readonly jid: string,
    private readonly opts: ReplySessionOpts,
  ) {
    this.startedAt = opts.startedAt ?? Date.now();
  }

  /** Whether this session has an active (not yet finalized) card. */
  get isActive(): boolean {
    return !this.cardCompleted;
  }

  // --------------------------------------------------------------------------
  // Typing indicator — matches official createTypingCallbacks()
  // --------------------------------------------------------------------------

  /**
   * Start the typing indicator (add emoji reaction to user's message).
   * Best-effort — errors are silently caught.
   */
  private async startTyping(): Promise<void> {
    if (this.typingStopped || !this.opts.replyToMessageId) return;
    if (this.typingState?.reactionId) return; // Already active

    this.typingState = await addTypingIndicator(this.client, this.opts.replyToMessageId);

    // TOCTOU guard: stop() may have been called while addTypingIndicator
    // was in flight. If so, clean up immediately.
    if (this.typingStopped && this.typingState) {
      await removeTypingIndicator(this.client, this.typingState);
      this.typingState = null;
    }
  }

  /**
   * Stop the typing indicator (remove emoji reaction).
   */
  private async stopTyping(): Promise<void> {
    this.typingStopped = true;
    if (!this.typingState) return;
    await removeTypingIndicator(this.client, this.typingState);
    this.typingState = null;
  }

  // --------------------------------------------------------------------------
  // ensureCardCreated — matches official ensureCardCreated()
  // --------------------------------------------------------------------------

  /**
   * Lazily create the streaming card. Safe to call multiple times — the first
   * caller triggers creation, subsequent callers await the same promise.
   * Matches the official plugin's ensureCardCreated().
   */
  async ensureCardCreated(): Promise<void> {
    // Already created or failed
    if (this.cardId || this.cardCreationFailed || this.cardCompleted) return;

    // Creation in progress — await same promise (prevents race)
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }

    // First caller — trigger creation
    this.cardCreationPromise = (async () => {
      try {
        // Start typing indicator in parallel with card creation
        this.startTyping().catch(() => {});

        // Step 1: Get card_id (try pool first, fall back to card.create)
        let cardId = this.opts.cardPool?.shift() ?? null;
        if (cardId) {
          logger.debug({ cardId, poolRemaining: this.opts.cardPool?.length }, 'ReplySession: using pooled card');
          this.opts.refillCardPool?.();
        } else {
          cardId = await createCardEntity(this.client, buildThinkingCardJson());
          if (!cardId) throw new Error('card.create returned empty card_id');
        }

        this.cardId = cardId;
        this.sequence = 1;

        // Step 2: Send IM message referencing card_id
        await sendCardByCardId(
          this.client,
          this.jid,
          cardId,
          this.opts.replyToMessageId,
        );

        logger.info({ jid: this.jid, cardId }, 'ReplySession: card created and sent');
      } catch (err) {
        logger.warn({ jid: this.jid, err }, 'ReplySession: card creation failed');
        this.cardCreationFailed = true;
      }
    })();

    try {
      await this.cardCreationPromise;
    } finally {
      this.cardCreationPromise = null;
    }
  }

  // --------------------------------------------------------------------------
  // pushContent — matches official onPartialReply → throttledCardUpdate
  // --------------------------------------------------------------------------

  /**
   * Push content to the streaming card. Creates the card lazily on first call.
   * Throttles updates to STREAMING_THROTTLE_MS (matches official CARDKIT_THROTTLE_MS).
   * After long gaps (>2s), defers the first flush by BATCH_AFTER_GAP_MS to
   * accumulate meaningful text (matches official pattern).
   *
   * @returns true if content was accepted (card exists or was created),
   *          false if card creation failed (caller should use post fallback).
   */
  async pushContent(text: string): Promise<boolean> {
    // Ensure card exists
    await this.ensureCardCreated();
    if (!this.cardId || this.cardCompleted) return false;

    this.lastContent = text;

    // Throttle: skip if too soon, schedule deferred flush
    const now = Date.now();
    const elapsed = now - this.lastUpdateMs;

    if (elapsed >= STREAMING_THROTTLE_MS) {
      // Past throttle window
      if (this.pendingFlushTimer) {
        clearTimeout(this.pendingFlushTimer);
        this.pendingFlushTimer = null;
      }

      if (elapsed > LONG_GAP_THRESHOLD_MS && this.lastUpdateMs > 0) {
        // After a long gap, batch briefly so the first visible update
        // contains meaningful text rather than just 1-2 characters.
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          this.flushContent();
        }, BATCH_AFTER_GAP_MS);
      } else {
        // Normal streaming — flush immediately
        this.flushContent();
      }
    } else if (!this.pendingFlushTimer) {
      // Inside throttle window — schedule a deferred flush
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        this.flushContent();
      }, STREAMING_THROTTLE_MS - elapsed);
    }

    return true;
  }

  /**
   * Flush current content to the card.
   * Uses a mutex to prevent concurrent API calls (matches official flushInProgress).
   * Out-of-order sequences cause 300317 errors — the mutex prevents this.
   */
  private flushContent(): void {
    if (!this.cardId || this.cardCompleted) return;

    // Concurrent flush guard: if a flush is already in flight,
    // mark needsReflush so we schedule a follow-up when it completes.
    if (this.flushInProgress) {
      this.needsReflush = true;
      return;
    }

    this.flushInProgress = true;
    this.needsReflush = false;

    const nextSeq = this.sequence + 1;
    this.sequence = nextSeq;
    this.lastUpdateMs = Date.now();

    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    const optimized = optimizeMarkdownStyle(this.lastContent);

    streamCardContent(
      this.client,
      this.cardId,
      STREAMING_ELEMENT_ID,
      optimized,
      nextSeq,
    ).catch((err) => {
      logger.warn({ cardId: this.cardId, seq: nextSeq, err }, 'Streaming content update failed');
    }).finally(() => {
      this.flushInProgress = false;
      // If new content arrived during the API call, schedule a follow-up flush
      if (this.needsReflush && !this.cardCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          this.flushContent();
        }, 0);
      }
    });
  }

  // --------------------------------------------------------------------------
  // finalize — matches official onIdle (close streaming → complete card)
  // --------------------------------------------------------------------------

  /**
   * Finalize the streaming card: close streaming mode, replace with complete card.
   * Matches the official plugin's onIdle handler.
   */
  async finalize(opts?: CompleteCardOpts): Promise<void> {
    // Guard against duplicate calls
    if (this.cardCompleted) return;
    this.cardCompleted = true;

    // Cancel pending flush
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    // Stop typing indicator (best-effort, don't block on failure)
    await this.stopTyping().catch(() => {});

    // Wait for in-progress card creation
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
    }

    // No card was ever created — nothing to finalize
    if (!this.cardId) return;

    try {
      // Step 1: Close streaming mode (required before card.update)
      this.sequence += 1;
      await setCardStreamingMode(
        this.client,
        this.cardId,
        false,
        this.sequence,
      );

      // Step 2: Build and apply complete card
      const elapsedMs = Date.now() - this.startedAt;
      const completeCard = buildCompleteCard(
        this.lastContent || 'Done.',
        {
          ...opts,
          elapsedMs,
        },
      );

      this.sequence += 1;
      await updateCardKitCard(
        this.client,
        this.cardId,
        completeCard,
        this.sequence,
      );

      logger.info({ cardId: this.cardId, elapsedMs }, 'ReplySession: card finalized');
    } catch (err) {
      logger.warn({ cardId: this.cardId, err }, 'ReplySession: finalize failed');
    }
  }

  /**
   * Abort the streaming card (best-effort).
   * Used when the container process exits abnormally.
   */
  async abort(): Promise<void> {
    await this.finalize({ isError: true });
  }

  /**
   * Clean up without finalizing (e.g., on disconnect).
   */
  destroy(): void {
    this.cardCompleted = true;
    this.typingStopped = true;
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }
}
