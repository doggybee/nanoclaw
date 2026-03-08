/**
 * Card content builders for Feishu streaming cards.
 * Ported from official @larksuiteoapi/feishu-openclaw-plugin builder.js.
 */
import { optimizeMarkdownStyle } from './markdown-style.js';

// ---------------------------------------------------------------------------
// Constants — match official plugin exactly
// ---------------------------------------------------------------------------
export const STREAMING_ELEMENT_ID = 'streaming_content';
export const LOADING_ELEMENT_ID = 'loading_icon';

// ---------------------------------------------------------------------------
// Thinking card — initial "thinking..." state with streaming mode enabled
// ---------------------------------------------------------------------------

/**
 * Build the thinking card JSON for CardKit streaming.
 * Matches official plugin's thinkingCardJson structure.
 */
export function buildThinkingCardJson(): Record<string, any> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '思考中...' },
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
          content: ' ',
          icon: {
            tag: 'custom_icon',
            img_key: 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg',
            size: '16px 16px',
          },
          element_id: LOADING_ELEMENT_ID,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Complete card — final state after streaming finishes
// ---------------------------------------------------------------------------

export interface CompleteCardOpts {
  isError?: boolean;
  reasoningText?: string;
  reasoningElapsedMs?: number;
  elapsedMs?: number;
}

/**
 * Build a "complete" card with optional reasoning panel and footer.
 * Matches official buildCompleteCard() from builder.js.
 */
export function buildCompleteCard(
  fullText: string,
  opts?: CompleteCardOpts,
): Record<string, any> {
  const elements: any[] = [];

  // Collapsible reasoning panel
  if (opts?.reasoningText) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'grey',
      header: {
        title: {
          tag: 'markdown',
          content: `💭 ${formatReasoningDuration(opts.reasoningElapsedMs)}`,
          text_size: 'notation',
        },
      },
      border: { color: 'grey', corner_radius: '5px' },
      elements: [
        {
          tag: 'markdown',
          content: opts.reasoningText,
          text_size: 'notation',
        },
      ],
    });
  }

  // Main content
  elements.push({
    tag: 'markdown',
    content: optimizeMarkdownStyle(fullText),
    text_align: 'left',
    text_size: 'normal_v2',
    element_id: STREAMING_ELEMENT_ID,
  });

  // Footer with status and elapsed time
  const footerParts: string[] = [];
  if (opts?.isError) {
    footerParts.push('<font color="red">出错</font>');
  } else {
    footerParts.push('已完成');
  }
  if (opts?.elapsedMs !== undefined) {
    footerParts.push(`耗时 ${formatElapsed(opts.elapsedMs)}`);
  }
  if (footerParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: footerParts.join(' · '),
      text_size: 'notation',
      text_align: 'left',
    });
  }

  // Feed preview summary (stripped markdown, max 120 chars)
  const stripped = fullText
    .replace(/[#*_~`>\[\]()!|\\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = stripped.length > 120 ? stripped.slice(0, 117) + '...' : stripped;

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: { content: summary },
    },
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// CardKit 2.0 format conversion
// ---------------------------------------------------------------------------

/**
 * Convert old-format card (elements at top level) to CardKit 2.0 (body.elements).
 * Matches official toCardKit2() from builder.js.
 */
export function toCardKit2(card: Record<string, any>): Record<string, any> {
  if (card.schema === '2.0' && card.body?.elements) return card;
  const elements = card.elements ?? card.body?.elements ?? [];
  return {
    schema: '2.0',
    config: card.config ?? {},
    header: card.header,
    body: { elements },
  };
}

// ---------------------------------------------------------------------------
// Reasoning text utilities
// ---------------------------------------------------------------------------

/**
 * Split text into reasoning and answer parts.
 * Handles both prefix format ("Reasoning:\n_content_") and XML tags (<think>...</think>).
 * Matches official splitReasoningText() from builder.js.
 */
export function splitReasoningText(text: string): { reasoningText?: string; answerText?: string } {
  // Check for XML-style reasoning tags
  const thinkMatch = text.match(/<(?:think|thinking|thought)>([\s\S]*?)(?:<\/(?:think|thinking|thought)>|$)/i);
  if (thinkMatch) {
    const reasoningText = thinkMatch[1].trim();
    const answerText = text
      .replace(/<(?:think|thinking|thought)>[\s\S]*?(?:<\/(?:think|thinking|thought)>|$)/gi, '')
      .trim();
    return {
      reasoningText: reasoningText || undefined,
      answerText: answerText || undefined,
    };
  }

  // Check for "Reasoning:\n_italic_" prefix format
  const prefixMatch = text.match(/^Reasoning:\n([\s\S]+)/);
  if (prefixMatch) {
    const content = prefixMatch[1];
    // If entire content is italic (wrapped in _), it's pure reasoning
    if (content.startsWith('_') && content.endsWith('_')) {
      return { reasoningText: content.slice(1, -1).trim() };
    }
  }

  return { answerText: text };
}

/**
 * Strip reasoning XML tags from text, keeping only the answer.
 * Matches official stripReasoningTags() from builder.js.
 */
export function stripReasoningTags(text: string): string {
  return text
    .replace(/<(?:think|thinking|thought)>[\s\S]*?(?:<\/(?:think|thinking|thought)>|$)/gi, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format milliseconds as "X.Xs" or "XmYs". */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Format reasoning duration as "Thought for Xs" or "Thought for XmYs". */
export function formatReasoningDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return 'Thought';
  const seconds = ms / 1000;
  const duration = seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `Thought for ${duration}`;
}
