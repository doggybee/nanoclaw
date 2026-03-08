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
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isStreaming?: boolean;
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
 * Time-based streaming throttle.
 * First token emits immediately. After that, emits at most once per interval.
 * Always sends full accumulated text (for card content replacement).
 */
class StreamThrottle {
  private fullText = '';
  /** Accumulated text from all previous assistant turns (persists across reset). */
  private allTurnsPrefix = '';
  private dirty = false;
  private lastEmitTime = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private emitFn: ((text: string) => void) | null = null;
  private readonly intervalMs: number;
  // After a long gap (tool call / thinking), batch briefly so the first
  // visible update contains meaningful text rather than 1-2 characters.
  private readonly longGapMs = 2000;
  private readonly batchAfterGapMs = 50;

  constructor(intervalMs = 100) {
    this.intervalMs = intervalMs;
  }

  /** Set the callback for emitting text. */
  onEmit(fn: (text: string) => void): void {
    this.emitFn = fn;
  }

  /** Feed a text delta. May emit immediately or schedule a deferred emit. */
  push(delta: string): void {
    this.fullText += delta;
    this.dirty = true;

    const now = Date.now();
    const elapsed = now - this.lastEmitTime;
    if (elapsed >= this.intervalMs) {
      if (this.lastEmitTime > 0 && elapsed > this.longGapMs) {
        // Long gap — defer to batch enough chars for a meaningful update
        if (!this.pending) {
          this.pending = setTimeout(() => {
            this.pending = null;
            if (this.dirty) this.emitNow();
          }, this.batchAfterGapMs);
        }
      } else {
        this.emitNow();
      }
    } else if (!this.pending) {
      const delay = this.intervalMs - elapsed;
      this.pending = setTimeout(() => {
        this.pending = null;
        if (this.dirty) this.emitNow();
      }, delay);
    }
  }

  /** Flush: emit remaining text immediately and cancel any pending timer. */
  flush(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (this.dirty) this.emitNow();
  }

  /** Reset for a new assistant turn — preserves accumulated text across turns. */
  reset(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    // Save current turn's text so next turn's output includes all previous turns
    if (this.fullText) {
      this.allTurnsPrefix += (this.allTurnsPrefix ? '\n\n' : '') + this.fullText;
    }
    this.fullText = '';
    this.dirty = false;
    this.lastEmitTime = 0;
  }

  /** Whether the current turn has accumulated text (via stream_events). */
  get hasContent(): boolean {
    return this.fullText.length > 0;
  }

  /** Text accumulated from all previous turns (for prepending to direct writes). */
  get previousTurnsText(): string {
    return this.allTurnsPrefix;
  }

  private emitNow(): void {
    this.dirty = false;
    this.lastEmitTime = Date.now();
    // Emit combined text: all previous turns + current turn
    const combined = this.allTurnsPrefix
      ? this.allTurnsPrefix + '\n\n' + this.fullText
      : this.fullText;
    this.emitFn?.(combined);
  }
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
    ipcWaitResolvers.add(r);
    // Safety net: check every 500ms in case inotify misses an event
    const safety = setTimeout(() => {
      ipcWaitResolvers.delete(r);
      r();
    }, 500);
    // Override the resolve to also clear the safety timer
    const originalR = r;
    ipcWaitResolvers.delete(r);
    const wrappedR = () => { clearTimeout(safety); originalR(); };
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
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcMessage {
  text: string;
  model?: string;
  sessionId?: string;
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
          messages.push({ text: data.text, model: data.model, sessionId: data.sessionId });
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
      };
    }
    const messages = drainIpcInput();
    if (messages.length > 0) {
      return {
        text: messages.map(m => m.text).join('\n'),
        model: messages[0].model,
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
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
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
        // Don't push follow-up messages into a query that already produced
        // a result — buffer them for waitForIpcMessage() in the main loop.
        if (queryResultReceived) {
          log('Result already received, buffering IPC message for next query');
          pendingIpcMessages.push(...messages.slice(i));
          ipcPolling = false;
          return;
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
  const throttle = new StreamThrottle();
  throttle.onEmit((text) => {
    writeOutput({ status: 'success', result: text, newSessionId, isStreaming: true });
  });

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
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

    // Token-level streaming: emit text deltas with time-based throttle
    if (message.type === 'stream_event') {
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
        log(`[timing] first stream_event at +${firstTokenTime - queryStartTime}ms from query start`);
      }
      const event = (message as { event: { type: string; delta?: { type?: string; text?: string } } }).event;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        throttle.push(event.delta.text);
      }
      if (event.type === 'content_block_stop' || event.type === 'message_stop') {
        throttle.flush();
      }
      continue;
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Flush any pending streaming text before the turn ends
      throttle.flush();
      // If stream_event already sent the text, skip redundant output.
      if (!throttle.hasContent) {
        const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (content) {
          const textParts = content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!);
          const text = textParts.join('');
          if (text) {
            // Include accumulated text from previous turns
            const prefix = throttle.previousTurnsText;
            const combined = prefix ? prefix + '\n\n' + text : text;
            log(`[streaming] assistant text chunk (${text.length} chars, combined ${combined.length} chars)`);
            writeOutput({ status: 'success', result: combined, newSessionId, isStreaming: true });
          }
        }
      }
      // Reset throttle for next assistant turn (after tool use)
      throttle.reset();
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
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      // previousTurnsText already contains all streamed assistant turns
      // (including the last one, saved by reset()). Don't concatenate with
      // textResult or the last turn's text will appear twice.
      const prefix = throttle.previousTurnsText;
      const finalText = prefix || textResult || null;
      log(`Result #${resultCount}: subtype=${message.subtype}${finalText ? ` text=${finalText.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: finalText,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
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

  // Warm mode: no prompt provided — enter query loop immediately.
  // The SDK pre-initializes (MCP servers, session, settings) while waiting
  // for the first IPC message, eliminating the 4-6s startup delay.
  if (!prompt) {
    log('Warm mode: entering query loop with pre-initialized SDK');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
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
