/**
 * Markdown style optimization for Feishu cards.
 * Ported from official @larksuiteoapi/feishu-openclaw-plugin.
 */

/**
 * Optimize markdown for Lark card rendering:
 * - Heading downgrade: H1 → H4, H2-H6 → H5 (only when H1-H3 exist)
 * - Table spacing: add <br> before/after tables (card v2 only)
 * - Code block spacing: add <br> around code blocks (card v2 only)
 * - Compress excess blank lines
 * - Strip invalid image keys (prevents CardKit error 200570)
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // 1. Extract code blocks, protect with placeholders
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // 2. Heading downgrade (only when H1-H3 present)
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2-H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1');        // H1 → H4
  }

  if (cardVersion >= 2) {
    // 3. Consecutive headings: add <br> spacing
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

    // 4. Table spacing
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, '$1\n<br>\n');
    r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n$3');
    r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, '$1\n$2\n\n$3');
    r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, '$1$2$3');

    // 5. Restore code blocks with <br> spacing
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 5. Restore code blocks (no <br>)
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // 6. Compress excess blank lines
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Strip `![alt](value)` where value is not a valid Feishu image key
 * (`img_xxx`) or remote URL. Prevents CardKit error 200570.
 */
export function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt: string, value: string) => {
    if (value.startsWith('img_')) return fullMatch;
    if (value.startsWith('http://')) return fullMatch;
    if (value.startsWith('https://')) return fullMatch;
    return value;
  });
}
