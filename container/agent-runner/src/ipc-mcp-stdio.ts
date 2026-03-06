/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'add_reaction',
  'React to a message with an emoji. Use the message ID from the <message id="..."> attribute in the conversation. Common emoji types: "THUMBSUP", "SMILE", "HEART", "YES", "FireCracker", "OK". The full list of supported emoji types is in the Lark documentation.',
  {
    message_id: z.string().describe('The message ID to react to (from the id attribute in <message> tags)'),
    emoji_type: z.string().describe('The emoji type (e.g., "THUMBSUP", "SMILE", "HEART", "YES", "FireCracker", "OK")'),
  },
  async (args) => {
    const data = {
      type: 'add_reaction',
      chatJid,
      messageId: args.message_id,
      emojiType: args.emoji_type,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji_type} added to message ${args.message_id}.` }] };
  },
);

server.tool(
  'get_chat_history',
  `Fetch recent chat history from the messaging platform. Returns messages in reverse chronological order (newest first).
Use this to get context about the conversation — especially messages from other users that weren't sent directly to you.
Each returned message includes message_id, sender_id, sender_type ("user" or "bot"), msg_type, content, and create_time.`,
  {
    count: z.number().min(1).max(50).default(20).describe('Number of messages to fetch (1-50, default 20)'),
    before_timestamp: z.string().optional().describe('ISO timestamp — only return messages before this time. Omit for latest messages.'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(MESSAGES_DIR, {
      type: 'get_chat_history',
      chatJid,
      count: args.count || 20,
      beforeTimestamp: args.before_timestamp || undefined,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for response file
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const timeout = 15_000;
    const pollMs = 300;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        try { fs.unlinkSync(responsePath); } catch { /* ignore */ }
        if (data.status === 'error') {
          return { content: [{ type: 'text' as const, text: `Error fetching chat history: ${data.error}` }], isError: true };
        }
        const messages = data.messages || [];
        if (messages.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
        }
        const formatted = messages.map((m: any) =>
          `[${m.create_time}] ${m.sender_type === 'bot' ? '(bot)' : '(user)'} ${m.sender_id}: [${m.msg_type}] ${m.content}`
        ).join('\n');
        return { content: [{ type: 'text' as const, text: formatted }] };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for chat history response.' }], isError: true };
  },
);

server.tool(
  'send_card',
  `Send an interactive card with buttons or menus. The user can click buttons and the action will be sent back to you as a message.

Uses Lark Card schema 2.0. IMPORTANT: schema 2.0 does NOT support the "action" wrapper tag. Place buttons directly in elements, or use column_set for horizontal layout.

Example — single button:
{
  "schema": "2.0",
  "header": { "title": { "tag": "plain_text", "content": "Title" } },
  "body": { "elements": [
    { "tag": "markdown", "content": "Which do you prefer?" },
    { "tag": "button", "text": { "tag": "plain_text", "content": "Option A" }, "type": "primary",
      "behaviors": [{ "type": "callback", "value": { "action_id": "choose", "choice": "A" } }] }
  ]}
}

Example — multiple buttons side by side (use column_set):
{
  "schema": "2.0",
  "header": { "title": { "tag": "plain_text", "content": "Pick" } },
  "body": { "elements": [
    { "tag": "markdown", "content": "Choose one:" },
    { "tag": "column_set", "columns": [
      { "tag": "column", "width": "auto", "elements": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "A" }, "type": "primary",
          "behaviors": [{ "type": "callback", "value": { "action_id": "choose", "choice": "A" } }] }
      ]},
      { "tag": "column", "width": "auto", "elements": [
        { "tag": "button", "text": { "tag": "plain_text", "content": "B" }, "type": "danger",
          "behaviors": [{ "type": "callback", "value": { "action_id": "choose", "choice": "B" } }] }
      ]}
    ]}
  ]}
}

Button types: "primary" (blue), "danger" (red), "default" (gray). Sizes: "small", "medium", "large".
Each button MUST have "behaviors": [{"type": "callback", "value": {...}}] for the click to work.
When a user clicks, you receive: [Card action: choose data={"action_id":"choose","choice":"A"} by user <open_id>]`,
  {
    card_json: z.string().describe('Lark Card JSON (schema 2.0) as a string'),
  },
  async (args) => {
    let cardJson: object;
    try {
      cardJson = JSON.parse(args.card_json);
    } catch {
      return { content: [{ type: 'text' as const, text: 'Invalid JSON in card_json' }], isError: true };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'send_card',
      chatJid,
      cardJson,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Interactive card sent.' }] };
  },
);

server.tool(
  'edit_message',
  'Edit a previously sent message. Only works for messages sent by the bot. Use the message ID from the <message id="..."> attribute. The message content will be fully replaced with the new text.',
  {
    message_id: z.string().describe('The message ID of the bot message to edit (from the id attribute in <message> tags)'),
    text: z.string().describe('The new message text to replace the old content'),
  },
  async (args) => {
    const data = {
      type: 'edit_message',
      chatJid,
      messageId: args.message_id,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Message ${args.message_id} edited.` }] };
  },
);

server.tool(
  'send_image',
  'Send an image file to the user or group. The image must exist at the given path within the container filesystem (e.g., /workspace/group/tmp/screenshot.png).',
  {
    image_path: z.string().describe('Absolute path to the image file inside the container'),
  },
  async (args) => {
    if (!fs.existsSync(args.image_path)) {
      return {
        content: [{ type: 'text' as const, text: `Image file not found: ${args.image_path}` }],
        isError: true,
      };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'send_image',
      chatJid,
      imagePath: args.image_path,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `Image sent: ${args.image_path}` }] };
  },
);

server.tool(
  'send_file',
  'Send a file to the user or group. The file must exist at the given path within the container filesystem.',
  {
    file_path: z.string().describe('Absolute path to the file inside the container'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `File sent: ${args.file_path}` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
