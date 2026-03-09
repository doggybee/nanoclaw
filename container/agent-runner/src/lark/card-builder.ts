/**
 * Card content builders for Feishu streaming cards.
 * Ported from host src/channels/lark/card-builder.ts.
 */
import { optimizeMarkdownStyle } from './markdown-style.js';

export const STREAMING_ELEMENT_ID = 'streaming_content';
const LOADING_ELEMENT_ID = 'loading_icon';

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

export interface CompleteCardOpts {
  isError?: boolean;
  reasoningText?: string;
  reasoningElapsedMs?: number;
  elapsedMs?: number;
}

/** Simple interactive card with a single markdown element (for IM patch fallback). */
export function buildSimpleMarkdownCard(content: string): Record<string, any> {
  return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content }] };
}

export function buildCompleteCard(
  fullText: string,
  opts?: CompleteCardOpts,
): Record<string, any> {
  const elements: any[] = [];

  if (opts?.reasoningText) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `💭 ${formatReasoningDuration(opts.reasoningElapsedMs)}`,
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: opts.reasoningText,
          text_size: 'notation',
        },
      ],
    });
  }

  elements.push({
    tag: 'markdown',
    content: optimizeMarkdownStyle(fullText),
    text_align: 'left',
    text_size: 'normal_v2',
    element_id: STREAMING_ELEMENT_ID,
  });

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

export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatReasoningDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return 'Thought';
  const seconds = ms / 1000;
  const duration = seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `Thought for ${duration}`;
}
