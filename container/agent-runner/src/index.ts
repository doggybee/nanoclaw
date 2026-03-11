/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { query, Query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { larkAvailable, larkClient, extractChatId, warmupLarkClient } from './lark-client.js';
import { ReplySession } from './lark/reply-session.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  /** Override model for this run (from model router). */
  model?: string;
  /** User message ID for reply threading. */
  replyToMessageId?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  outputDelivered?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Simple text accumulator for cross-turn text assembly.
 * No time-based throttling — ReplySession handles that internally.
 */
class TextAccumulator {
  private currentTurn = '';
  private allTurns = '';

  push(delta: string): void {
    this.currentTurn += delta;
  }

  /** Full text: all previous turns + current turn. */
  get fullText(): string {
    return this.allTurns
      ? this.allTurns + (this.currentTurn ? '\n\n' + this.currentTurn : '')
      : this.currentTurn;
  }

  /** Final text (at query end). Returns null if no content. */
  get finalText(): string | null {
    return this.fullText || null;
  }

  /** Called when an assistant turn ends — archives current turn text. */
  reset(): void {
    if (this.currentTurn) {
      this.allTurns += (this.allTurns ? '\n\n' : '') + this.currentTurn;
    }
    this.currentTurn = '';
  }

  get hasContent(): boolean { return this.currentTurn.length > 0; }
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_ABORT_SENTINEL = path.join(IPC_INPUT_DIR, '_abort');
const IPC_POLL_MS = 50; // fallback only — used when inotify unavailable

// ---------------------------------------------------------------------------
// IPC watcher — event-driven via inotify (fs.watch), polling fallback
// ---------------------------------------------------------------------------
let ipcWatcher: fs.FSWatcher | null = null;
const ipcWaitResolvers = new Set<() => void>();

function startIpcWatch(): void {
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    ipcWatcher = fs.watch(IPC_INPUT_DIR, () => {
      for (const resolve of ipcWaitResolvers) resolve();
      ipcWaitResolvers.clear();
    });
    ipcWatcher.on('error', () => {
      // inotify failed at runtime — stop watcher, callers fall back to polling
      ipcWatcher?.close();
      ipcWatcher = null;
    });
    log('IPC: using inotify (fs.watch)');
  } catch {
    log('IPC: inotify unavailable, using polling fallback');
  }
}

/** Wait for a filesystem event on the IPC directory, or fall back to polling. */
function waitForIpcEvent(): Promise<void> {
  if (!ipcWatcher) {
    return new Promise(r => setTimeout(r, IPC_POLL_MS));
  }
  return new Promise(r => {
    // Build wrapped resolver BEFORE adding to the set to avoid a race where
    // fs.watch fires between add(r) and the swap to wrappedR, which would
    // call the original r without clearing the safety timer.
    let safety: ReturnType<typeof setTimeout>;
    const wrappedR = () => { clearTimeout(safety); r(); };
    safety = setTimeout(wrappedR, 500);
    ipcWaitResolvers.add(wrappedR);
  });
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for _abort sentinel.
 */
function shouldAbort(): boolean {
  try {
    fs.unlinkSync(IPC_INPUT_ABORT_SENTINEL);
    return true;
  } catch {
    return false;
  }
}

interface IpcMessage {
  text: string;
  model?: string;
  sessionId?: string;
  replyToMessageId?: string;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): IpcMessage[] {
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            model: data.model,
            sessionId: data.sessionId,
            replyToMessageId: data.replyToMessageId,
          });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Run the query lifecycle — single query() call, stream stays open for multi-turn.
 * The SDK handles session continuity natively (no JSONL re-parsing between turns).
 * IPC messages are pushed into the stream; each result finalizes the current card
 * and resets per-turn state, but the stream stays alive for the next message.
 *
 * Streaming output is handled by ReplySession (when larkAvailable):
 * text deltas are pushed to TextAccumulator then forwarded to ReplySession
 * which manages CardKit streaming cards directly via the Lark API.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  initialReplySession: ReplySession | null,
  globalClaudeMd: string | undefined,
  extraDirs: string[],
  onFirstResult?: () => void,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  // In warm mode (empty prompt), don't push anything yet — let IPC polling
  // push the first message. The SDK initializes (MCP servers, session loading)
  // while waiting for the stream to yield, so when the message arrives the
  // API call starts immediately without the 4-6s init delay.
  if (prompt) {
    stream.push(prompt);
  }

  // Watch IPC for follow-up messages and _close sentinel.
  // Uses inotify (fs.watch) for near-instant detection, polling fallback.
  let ipcPolling = true;
  let closedDuringQuery = false;
  let replySession = initialReplySession;
  const pollIpcDuringQuery = async () => {
    while (ipcPolling) {
      if (shouldAbort()) {
        log('Abort sentinel detected, aborting reply and ending stream');
        if (replySession) replySession.abort().catch(() => {});
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      if (shouldClose()) {
        log('Close sentinel detected, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (const msg of messages) {
        log(`[timing] IPC message received (${msg.text.length} chars)`);
        // Dynamic model switching — when model router selects a different
        // model, apply it before pushing the message so the next API call
        // uses the correct model. Also adjust thinking budget per model.
        if (msg.model && msg.model !== currentModel && queryObj) {
          log(`[timing] switching model: ${currentModel} → ${msg.model}`);
          currentModel = msg.model;
          queryObj.setModel(msg.model).catch((err) => {
            log(`setModel failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          // Adjust thinking budget for the new model
          const isHaiku = msg.model.includes('haiku');
          const defaultBudget = isHaiku ? 2000 : 10000;
          const budget = parseInt(process.env.THINKING_BUDGET || String(defaultBudget), 10);
          queryObj.setMaxThinkingTokens(budget === 0 ? null : budget).catch((err) => {
            log(`setMaxThinkingTokens failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        // Lazy ReplySession creation for each new turn.
        // In warm mode first turn, this runs in parallel with SDK init.
        if (!replySession && larkAvailable && msg.replyToMessageId) {
          const chatId = extractChatId(containerInput.chatJid);
          replySession = new ReplySession(larkClient, chatId, {
            replyToMessageId: msg.replyToMessageId,
            startedAt: Date.now(),
          });
          log(`ReplySession: created for replyTo=${msg.replyToMessageId}`);
          replySession.ensureCardCreated().catch(() => {});
        }
        stream.push(msg.text);
      }
      await waitForIpcEvent();
    }
  };
  pollIpcDuringQuery().catch((err) => {
    log(`IPC polling error: ${err instanceof Error ? err.message : String(err)}`);
  });

  let newSessionId: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let turnStartTime = Date.now();
  let firstTokenTime = 0;
  let streamEventCount = 0;
  let accumulator = new TextAccumulator();

  // Track current model for dynamic switching via setModel()
  let currentModel = containerInput.model || process.env.CLAUDE_MODEL || '';
  let queryObj: Query | null = null;

  // Per-turn reasoning state
  let reasoningChunks: string[] = [];
  let reasoningStartTime: number | null = null;
  let reasoningElapsedMs = 0;
  let isReasoningPhase = false;

  // Throttled streaming flush — matches official feishu-plugin's
  // throttledCardUpdate / flushCardUpdate pattern.
  // CardKit uses 100ms throttle; IM patch uses 1500ms (stricter rate limit).
  // After a long gap (tool call), batch 300ms to show meaningful first update.
  const CARDKIT_THROTTLE_MS = 100;
  const PATCH_THROTTLE_MS = 1500;
  const LONG_GAP_THRESHOLD_MS = 2000;
  const BATCH_AFTER_GAP_MS = 300;

  let lastFlushedText = '';
  let lastCardUpdateTime = 0;
  let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushCardUpdate = () => {
    if (!replySession) return;
    lastCardUpdateTime = Date.now();
    const raw = accumulator.fullText;
    const displayText = reasoningChunks.length > 0 ? stripReasoningTags(raw) : raw;
    if (displayText && displayText !== lastFlushedText) {
      lastFlushedText = displayText;
      replySession.pushContent(displayText);
    }
  };

  const throttledCardUpdate = () => {
    if (!replySession) return;
    const throttleMs = replySession.isCardKit ? CARDKIT_THROTTLE_MS : PATCH_THROTTLE_MS;
    const now = Date.now();
    const elapsed = now - lastCardUpdateTime;
    if (elapsed >= throttleMs) {
      if (pendingFlushTimer) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }
      if (elapsed > LONG_GAP_THRESHOLD_MS) {
        // After a long gap (tool call / LLM thinking), batch briefly so
        // the first visible update contains meaningful text rather than
        // just 1-2 characters.
        pendingFlushTimer = setTimeout(() => {
          pendingFlushTimer = null;
          flushCardUpdate();
        }, BATCH_AFTER_GAP_MS);
      } else {
        flushCardUpdate();
      }
    } else if (!pendingFlushTimer) {
      // Inside throttle window — schedule a deferred flush
      const delay = throttleMs - elapsed;
      pendingFlushTimer = setTimeout(() => {
        pendingFlushTimer = null;
        flushCardUpdate();
      }, delay);
    }
    // If a deferred flush is already scheduled, do nothing — it will
    // pick up the latest accumulatedText when it fires.
  };

  const resetTurnState = () => {
    accumulator = new TextAccumulator();
    reasoningChunks = [];
    reasoningStartTime = null;
    reasoningElapsedMs = 0;
    isReasoningPhase = false;
    firstTokenTime = 0;
    streamEventCount = 0;
    lastFlushedText = '';
    lastCardUpdateTime = 0;
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    turnStartTime = Date.now();
  };

  queryObj = query({
    prompt: stream,
    options: {
      model: containerInput.model || process.env.CLAUDE_MODEL || undefined,
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            ...(containerInput.isScheduledTask ? { NANOCLAW_IS_TASK: '1' } : {}),
          },
        },
      },
      includePartialMessages: true,
      thinking: (() => {
        const model = containerInput.model || process.env.CLAUDE_MODEL || '';
        const isHaiku = model.includes('haiku');
        const defaultBudget = isHaiku ? 2000 : 10000;
        const budget = parseInt(process.env.THINKING_BUDGET || String(defaultBudget), 10);
        return budget === 0
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budgetTokens: budget };
      })(),
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  });

  for await (const message of queryObj) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    if (message.type !== 'stream_event') {
      log(`[msg #${messageCount}] type=${msgType} (+${Date.now() - turnStartTime}ms)`);
    }

    // Token-level streaming: push text deltas to accumulator, forward to ReplySession
    if (message.type === 'stream_event') {
      streamEventCount++;
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        log(`[timing] first stream_event at +${firstTokenTime - turnStartTime}ms from turn start`);
      }
      const event = (message as { event: { type: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          // Reasoning phase
          if (!reasoningStartTime) {
            reasoningStartTime = Date.now();
            log(`[thinking] reasoning phase started at +${reasoningStartTime - turnStartTime}ms`);
          }
          isReasoningPhase = true;
          reasoningChunks.push(event.delta.thinking);
        } else if (event.delta?.type === 'text_delta' && event.delta.text) {
          // Answer phase — transition from reasoning if needed
          if (isReasoningPhase) {
            isReasoningPhase = false;
            reasoningElapsedMs = reasoningStartTime ? Date.now() - reasoningStartTime : 0;
            log(`[thinking] answer phase started, reasoning took ${reasoningElapsedMs}ms (${reasoningChunks.length} chunks)`);
          }
          accumulator.push(event.delta.text);
          throttledCardUpdate();
        }
      }
      continue;
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      accumulator.reset();
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`[timing] SDK initialized at +${Date.now() - turnStartTime}ms, session: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      // Cancel any pending flush before finalize
      if (pendingFlushTimer) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }

      const rawFinalText = accumulator.finalText;
      const finalText = rawFinalText ? stripReasoningTags(rawFinalText) : null;
      const isError = message.subtype !== 'success';

      // Finalize ReplySession (completes the streaming card)
      if (replySession) {
        if (finalText && finalText !== lastFlushedText) {
          replySession.pushContent(finalText);
        }
        await replySession.finalize({ isError });
        const delivered = replySession.outputDelivered;
        log(`Result #${resultCount}: subtype=${message.subtype} outputDelivered=${delivered}${finalText ? ` text=${finalText.slice(0, 200)}` : ''}`);
        writeOutput({
          status: isError ? 'error' : 'success',
          result: delivered ? null : finalText,
          newSessionId,
          outputDelivered: delivered,
          ...(isError ? { error: finalText || 'Agent returned error' } : {}),
        });
        replySession.destroy();
      } else {
        log(`Result #${resultCount}: subtype=${message.subtype} (no ReplySession)${finalText ? ` text=${finalText.slice(0, 200)}` : ''}`);
        writeOutput({
          status: isError ? 'error' : 'success',
          result: finalText,
          newSessionId,
          outputDelivered: false,
          ...(isError ? { error: finalText || 'Agent returned error' } : {}),
        });
      }

      // Clear ReplySession — next IPC message creates a new one
      replySession = null;
      if (resultCount === 1) onFirstResult?.();

      // Reset per-turn state; stream stays open for multi-turn
      resetTurnState();
    }
  }

  ipcPolling = false;
  stream.end(); // ensure poller exits if still awaiting
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = null;
  }
  if (replySession) {
    replySession.destroy();
  }
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, closedDuringQuery };
}

/**
 * Create a ReplySession if Lark is available.
 * Container handles all message sending — host only tracks state.
 */
function createReplySession(containerInput: ContainerInput, replyToMessageId?: string): ReplySession | null {
  if (!larkAvailable) {
    log(`ReplySession: skipped (larkAvailable=${larkAvailable})`);
    return null;
  }

  const chatId = extractChatId(containerInput.chatJid);
  const session = new ReplySession(larkClient, chatId, {
    replyToMessageId,
    startedAt: Date.now(),
  });
  log(`ReplySession: created for chatId=${chatId} replyToMessageId=${replyToMessageId || 'none'}`);
  return session;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
    log(`Lark available: ${larkAvailable}`);
    // Pre-warm Lark token + HTTPS connection in background (don't block startup)
    warmupLarkClient().catch(() => {});
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // SDK env: credentials are injected by the host's credential proxy via
  // ANTHROPIC_BASE_URL, so no secrets need to be merged here.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Load global CLAUDE.md once (doesn't change during container lifetime)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  try { if (!containerInput.isMain) globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8'); } catch {}

  // QMD indexing helper — deferred to idle time (after first query completes)
  // to avoid competing for CPU during SDK init and first API call.
  let qmdIndexed = false;
  const qmdIndexDeferred = () => {
    if (qmdIndexed) return;
    qmdIndexed = true;
    const qmdIndex = (dir: string, collection: string) => {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.md'))) {
          execFile('qmd', ['collection', 'add', dir, '--name', collection, '--mask', '*.md'], (err) => {
            if (err) log(`QMD index [${collection}] failed: ${err.message}`);
            else log(`QMD index [${collection}] done`);
          });
        }
      } catch {}
    };
    qmdIndex('/workspace/global/knowledge', 'kb');
    qmdIndex('/workspace/group/conversations', 'conversations');
  };

  // Discover extra mount directories once
  const extraDirs: string[] = [];
  try {
    for (const entry of fs.readdirSync('/workspace/extra')) {
      const fullPath = `/workspace/extra/${entry}`;
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  } catch {}
  if (extraDirs.length > 0) log(`Additional directories: ${extraDirs.join(', ')}`);

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Start IPC watcher (inotify-based, polling fallback)
  startIpcWatch();

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  try { fs.unlinkSync(IPC_INPUT_ABORT_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map(m => m.text).join('\n');
  }

  // --- Slash command handling (e.g. /compact) ---
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt?.trim() || '';
  if (KNOWN_SESSION_COMMANDS.has(trimmedPrompt)) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }
        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;
          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({ status: 'error', result: null, error: textResult || 'Session command failed.', newSessionId: slashSessionId });
          } else {
            writeOutput({ status: 'success', result: textResult || 'Conversation compacted.', newSessionId: slashSessionId });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen ? 'Conversation compacted.' : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    }
    return;
  }
  // --- End slash command handling ---

  // Warm mode: no prompt provided — enter query loop immediately.
  // The SDK pre-initializes (MCP servers, session, settings) while waiting
  // for the first IPC message, eliminating the 4-6s startup delay.
  if (!prompt) {
    log('Warm mode: entering query loop with pre-initialized SDK');
  }

  // Determine initial replyToMessageId (from ContainerInput or drained IPC messages)
  let currentReplyToMessageId = containerInput.replyToMessageId
    || (pending.length > 0 ? pending[0].replyToMessageId : undefined);

  // Single query with persistent stream — SDK handles multi-turn natively.
  // Follow-up messages are pushed into the stream via IPC polling inside runQuery.
  // No JSONL re-parsing between turns; no MCP server re-init.
  try {
    log(`Starting query (session: ${sessionId || 'new'})...`);

    const replySession = prompt
      ? createReplySession(containerInput, currentReplyToMessageId)
      : null; // warm mode: lazy creation inside runQuery

    if (replySession) {
      replySession.ensureCardCreated().catch(() => {});
    }

    const queryResult = await runQuery(
      prompt || '', sessionId, mcpServerPath, containerInput, sdkEnv,
      replySession, globalClaudeMd, extraDirs,
      () => qmdIndexDeferred(),
    );

    if (queryResult.newSessionId) {
      sessionId = queryResult.newSessionId;
    }
    log(`Query ended (closedDuringQuery=${queryResult.closedDuringQuery})`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

function stripReasoningTags(text: string): string {
  let result = text.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, '');
  result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  return result.trim();
}

main();
