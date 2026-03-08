/**
 * Model Router — selects fast or full model based on message complexity.
 *
 * When MODEL_ROUTER=auto, uses heuristics to classify messages:
 * - Simple (greetings, short Q&A, conversational) → MODEL_FAST (e.g. Haiku)
 * - Complex (code, files, tools, multi-step) → MODEL_FULL (e.g. Sonnet)
 *
 * Returns undefined when routing is off or no fast model is configured,
 * letting the container fall back to CLAUDE_MODEL.
 */

import { MODEL_FAST, MODEL_FULL, MODEL_ROUTER } from './config.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

// Patterns that indicate the message needs tools/code/complex reasoning
const COMPLEX_PATTERNS = [
  /```/,                                    // code blocks
  /\.(ts|js|py|go|rs|java|cpp|c|sh|yaml|yml|json|toml|sql|css|html|xml|md|txt|log|csv)\b/i, // file extensions
  /(https?:\/\/)/,                          // URLs
  /\b(debug|fix|bug|error|deploy|build|test|refactor|implement|create|write|edit|delete|modify|update|install|configure|setup|migrate|analyze|review)\b/i, // action verbs
  /\b(code|file|script|function|class|module|package|dependency|container|docker|git|branch|commit|PR|pull request|merge)\b/i, // dev terms
  /\b(database|query|API|endpoint|server|deploy|CI|CD|pipeline)\b/i, // infrastructure
  /\b(MCP|tool|skill|search|fetch|browse)\b/i, // tool usage
];

// Patterns that strongly indicate a simple conversational message
const SIMPLE_PATTERNS = [
  /^(hi|hello|hey|你好|嗨|哈喽|早|晚上好|下午好)\b/i,
  /^(thanks|thank you|谢谢|好的|ok|收到|明白|了解)\b/i,
  /^(what|who|when|where|why|how|是什么|什么是|怎么|为什么|哪里|谁)\b/i,
];

/**
 * Classify message complexity using heuristics.
 * Returns 'simple' or 'complex'.
 */
function classifyMessage(text: string): 'simple' | 'complex' {
  // Long messages are likely complex
  if (text.length > 500) return 'complex';

  // Check for complex patterns
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(text)) return 'complex';
  }

  // Short messages matching simple patterns
  if (text.length < 200) {
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(text)) return 'simple';
    }
  }

  // Default: messages under 200 chars without complex indicators → simple
  if (text.length < 200) return 'simple';

  return 'complex';
}

/**
 * Select the model for a set of messages.
 * Returns model ID or undefined (use default CLAUDE_MODEL).
 */
export function selectModel(messages: NewMessage[]): string | undefined {
  if (MODEL_ROUTER !== 'auto') return undefined;
  if (!MODEL_FAST) return undefined;

  // Combine all message content for classification
  const text = messages.map((m) => m.content).join('\n').trim();

  const complexity = classifyMessage(text);
  const model = complexity === 'simple' ? MODEL_FAST : (MODEL_FULL || undefined);

  logger.info(
    { complexity, model: model || 'default', textLength: text.length },
    'Model router decision',
  );

  return model;
}
