/**
 * Tests for the Lark channel host-side modules.
 * Tests markdown optimization and message guard.
 * Card builder, CardKit, and ReplySession are now container-side only.
 */
import { describe, it, expect } from 'vitest';

import { optimizeMarkdownStyle, stripInvalidImageKeys } from './markdown-style.js';
import {
  MessageUnavailableError,
  extractLarkApiCode,
  formatLarkError,
} from './message-guard.js';

// ---------------------------------------------------------------------------
// markdown-style.ts
// ---------------------------------------------------------------------------
describe('optimizeMarkdownStyle', () => {
  it('downgrades headings when H1-H3 present', () => {
    const input = '# Title\n## Subtitle\ntext';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('#### Title');
    expect(result).toContain('##### Subtitle');
  });

  it('does not downgrade when no H1-H3', () => {
    const input = '#### Already H4\ntext';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('#### Already H4');
  });

  it('preserves code blocks', () => {
    const input = '```js\n# not a heading\n```';
    const result = optimizeMarkdownStyle(input, 1);
    expect(result).toContain('# not a heading');
  });

  it('compresses excess blank lines', () => {
    const input = 'line1\n\n\n\n\nline2';
    const result = optimizeMarkdownStyle(input);
    expect(result).toBe('line1\n\nline2');
  });

  it('returns original on error', () => {
    expect(optimizeMarkdownStyle('')).toBe('');
  });
});

describe('stripInvalidImageKeys', () => {
  it('keeps valid Feishu image keys', () => {
    expect(stripInvalidImageKeys('![alt](img_v3_xxx)')).toBe('![alt](img_v3_xxx)');
  });

  it('keeps http URLs', () => {
    expect(stripInvalidImageKeys('![](https://example.com/img.png)')).toBe('![](https://example.com/img.png)');
  });

  it('strips local paths', () => {
    expect(stripInvalidImageKeys('![alt](./local/path.png)')).toBe('./local/path.png');
  });

  it('returns text unchanged if no images', () => {
    expect(stripInvalidImageKeys('no images here')).toBe('no images here');
  });
});

// ---------------------------------------------------------------------------
// message-guard.ts
// ---------------------------------------------------------------------------
describe('MessageUnavailableError', () => {
  it('creates error with correct properties', () => {
    const err = new MessageUnavailableError({
      messageId: 'om_123',
      apiCode: 230011,
      operation: 'test',
    });
    expect(err.messageId).toBe('om_123');
    expect(err.apiCode).toBe(230011);
    expect(err.name).toBe('MessageUnavailableError');
    expect(err.message).toContain('om_123');
  });
});

describe('extractLarkApiCode', () => {
  it('extracts code from top-level', () => {
    expect(extractLarkApiCode({ code: 230011 })).toBe(230011);
  });

  it('extracts code from response.data', () => {
    expect(extractLarkApiCode({ response: { data: { code: 231003 } } })).toBe(231003);
  });

  it('extracts code from data.code', () => {
    expect(extractLarkApiCode({ data: { code: '99991672' } })).toBe(99991672);
  });

  it('returns undefined for non-objects', () => {
    expect(extractLarkApiCode(null)).toBeUndefined();
    expect(extractLarkApiCode('string')).toBeUndefined();
  });
});

describe('formatLarkError', () => {
  it('formats permission error with scopes', () => {
    const err = { code: 99991672, msg: 'need [im:message] scope https://example.com/app/xxx' };
    const result = formatLarkError(err);
    expect(result).toContain('权限不足');
    expect(result).toContain('im:message');
  });

  it('formats regular error', () => {
    expect(formatLarkError({ code: 230011, msg: 'message deleted' })).toBe('message deleted');
  });

  it('handles non-object errors', () => {
    expect(formatLarkError('string error')).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------
describe('markdown optimization performance', () => {
  it('optimizeMarkdownStyle runs in < 1ms for typical content', () => {
    const content = '# Title\n## Section\nSome text with **bold** and _italic_\n\n```js\nconst x = 1;\n```\n\n> blockquote\n\n- list item';
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) optimizeMarkdownStyle(content, 1);
    const elapsed = performance.now() - start;
    const avg = elapsed / iterations;
    expect(avg).toBeLessThan(1);
  });
});
