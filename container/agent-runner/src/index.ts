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

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { larkAvailable, larkClient, extractChatId } from './lark-client.js';
import { ReplySession } from './lark/reply-session.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
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
  private _cachedFull = '';
  private _dirty = false;

  push(delta: string): void {
    this.currentTurn += delta;
    this._dirty = true;
  }

  /** Full text: all previous turns + current turn. Cached until content changes. */
  get fullText(): string {
    if (this._dirty) {
      this._cachedFull = this.allTurns
        ? this.allTurns + (this.currentTurn ? '\n\n' + this.currentTurn : '')
        : this.currentTurn;
      this._dirty = false;
    }
    return this._cachedFull;
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
    this._dirty = true;
  }

  get hasContent(): boolean { return this.currentTurn.length > 0; }
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
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

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
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

// Messages drained from IPC but not processed (e.g. arrived after result).
// waitForIpcMessage() checks this first before reading new files.
let pendingIpcMessages: IpcMessage[] = [];

/**
 * Wait for a new IPC message or _close sentinel.
 * Uses inotify (fs.watch) for near-instant detection, polling fallback.
 * Returns the combined message (with optional model from first message), or null if _close.
 */
async function waitForIpcMessage(): Promise<IpcMessage | null> {
  while (true) {
    if (shouldClose()) return null;
    // Check buffered messages first (left over from pollIpcDuringQuery)
    if (pendingIpcMessages.length > 0) {
      const msgs = pendingIpcMessages;
      pendingIpcMessages = [];
      return {
        text: msgs.map(m => m.text).join('\n'),
        model: msgs[0].model,
        replyToMessageId: msgs[0].replyToMessageId,
      };
    }
    const messages = drainIpcInput();
    if (messages.length > 0) {
      return {
        text: messages.map(m => m.text).join('\n'),
        model: messages[0].model,
        replyToMessageId: messages[0].replyToMessageId,
      };
    }
    await waitForIpcEvent();
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 *
 * Streaming output is handled by ReplySession (when larkAvailable):
 * text deltas are pushed to TextAccumulator then forwarded to ReplySession
 * which manages CardKit streaming cards directly via the Lark API.
 * writeOutput is only called once at result time.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  replySession: ReplySession | null,
  globalClaudeMd: string | undefined,
  extraDirs: string[],
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  // In warm mode (empty prompt), don't push anything yet — let IPC polling
  // push the first message. The SDK initializes (MCP servers, session loading)
  // while waiting for the stream to yield, so when the message arrives the
  // API call starts immediately without the 4-6s init delay.
  if (prompt) {
    stream.push(prompt);
  }

  // Watch IPC for follow-up messages and _close sentinel during the query.
  // Uses inotify (fs.watch) for near-instant detection, polling fallback.
  let ipcPolling = true;
  let closedDuringQuery = false;
  // Set to true when the SDK emits a result — prevents pushing more IPC
  // messages into the same query (which would accumulate all turns' text).
  let queryResultReceived = false;
  const pollIpcDuringQuery = async () => {
    while (ipcPolling) {
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const sinceQuery = Date.now() - queryStartTime;
        log(`[timing] IPC message received at +${sinceQuery}ms (${msg.text.length} chars)`);
        if (queryResultReceived) {
          log('Result already received, buffering IPC message for next query');
          pendingIpcMessages.push(...messages.slice(i));
          ipcPolling = false;
          return;
        }
        // Lazy ReplySession creation: first IPC message provides replyToMessageId.
        // In warm mode, this runs in parallel with SDK init (MCP servers etc.).
        if (!replySession && larkAvailable && msg.replyToMessageId) {
          const chatId = extractChatId(containerInput.chatJid);
          replySession = new ReplySession(larkClient, chatId, {
            replyToMessageId: msg.replyToMessageId,
            startedAt: Date.now(),
          });
          log(`ReplySession: lazy-created for chatId=${chatId} replyToMessageId=${msg.replyToMessageId}`);
          replySession.ensureCardCreated().catch(() => {});
          startStreamingTimer();
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
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  const queryStartTime = Date.now();
  let firstTokenTime = 0;
  let streamEventCount = 0;
  const accumulator = new TextAccumulator();

  // Timer-based streaming flush: instead of calling pushContent() on every
  // stream_event (which floods the event loop with microtasks and delays API
  // response callbacks), we check every 100ms if content changed and flush once.
  let lastFlushedText = '';
  let streamingTimer: ReturnType<typeof setInterval> | null = null;
  const startStreamingTimer = () => {
    if (streamingTimer || !replySession) return;
    const session = replySession; // capture for closure
    streamingTimer = setInterval(() => {
      const text = accumulator.fullText;
      if (text && text !== lastFlushedText) {
        lastFlushedText = text;
        session.pushContent(text);
      }
    }, 100);
  };
  // Start timer immediately if ReplySession was pre-created (non-warm mode)
  if (replySession) {
    startStreamingTimer();
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: containerInput.model || process.env.CLAUDE_MODEL || undefined,
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
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
      settingSources: [],
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
      thinking: { type: 'disabled' as const },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    if (message.type !== 'stream_event') {
      log(`[msg #${messageCount}] type=${msgType} (+${Date.now() - queryStartTime}ms)`);
    }

    // Token-level streaming: push text deltas to accumulator, forward to ReplySession
    if (message.type === 'stream_event') {
      streamEventCount++;
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        log(`[timing] first stream_event at +${firstTokenTime - queryStartTime}ms from query start`);
      }
      const event = (message as { event: { type: string; delta?: { type?: string; text?: string } } }).event;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        accumulator.push(event.delta.text);
        // Streaming flush handled by streamingTimer (100ms interval) —
        // not here, to avoid flooding the event loop with microtasks.
      }
      continue;
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Archive current turn text for cross-turn accumulation
      accumulator.reset();
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`[timing] SDK initialized at +${Date.now() - queryStartTime}ms, session: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      queryResultReceived = true; // Prevent IPC poll from feeding more messages into this query
      stream.end(); // End the stream so the SDK finishes and the main loop can start a new query

      // Stop the streaming timer — flush final content synchronously below
      if (streamingTimer) {
        clearInterval(streamingTimer);
        streamingTimer = null;
      }

      const finalText = accumulator.finalText;
      const isError = message.subtype !== 'success';

      // Finalize ReplySession (completes the streaming card)
      if (replySession) {
        // Push final content before finalizing (timer may not have caught the last delta)
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
      } else {
        // No ReplySession (scheduled task, or lark not available) — send text via host
        log(`Result #${resultCount}: subtype=${message.subtype} (no ReplySession)${finalText ? ` text=${finalText.slice(0, 200)}` : ''}`);
        writeOutput({
          status: isError ? 'error' : 'success',
          result: finalText,
          newSessionId,
          outputDelivered: false,
          ...(isError ? { error: finalText || 'Agent returned error' } : {}),
        });
      }
    }
  }

  ipcPolling = false;
  if (streamingTimer) {
    clearInterval(streamingTimer);
    streamingTimer = null;
  }
  // Cleanup lazy-created ReplySession (warm mode creates it inside runQuery)
  if (replySession) {
    replySession.destroy();
    log('ReplySession: destroyed (end of runQuery)');
  }
  log(`Query done. Messages: ${messageCount}, streamEvents: ${streamEventCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Load global CLAUDE.md once (doesn't change during container lifetime)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  try { if (!containerInput.isMain) globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8'); } catch {}

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

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

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
          settingSources: [],
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
    } else if (!hadError && !resultEmitted) {
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
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

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      // Warm mode: DON'T wait for IPC — call runQuery immediately with empty prompt.
      // SDK initializes (MCP servers, session) in parallel with IPC waiting.
      // ReplySession is created lazily inside runQuery when the first IPC message arrives.

      // For non-warm mode (prompt available): create ReplySession eagerly
      const replySession = prompt
        ? createReplySession(containerInput, currentReplyToMessageId)
        : null; // warm mode: lazy creation inside runQuery

      if (replySession) {
        replySession.ensureCardCreated().catch(() => {});
      }

      const queryResult = await runQuery(prompt || '', sessionId, mcpServerPath, containerInput, sdkEnv, replySession, globalClaudeMd, extraDirs, resumeAt);
      // ReplySession cleanup is handled inside runQuery

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars), starting new query`);
      prompt = nextMessage.text;
      currentReplyToMessageId = nextMessage.replyToMessageId;
      if (nextMessage.model) {
        containerInput.model = nextMessage.model;
      }
    }
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

main();
