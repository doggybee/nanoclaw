/**
 * Lark workspace MCP tools — docx, sheets, task, search.
 *
 * Registered on the shared McpServer instance from ipc-mcp-stdio.ts.
 * All tools guard on `larkAvailable` before calling SDK methods.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MCP_LOG_PATH = '/tmp/mcp-nanoclaw.log';

function mcpLog(tool: string, message: string): void {
  const line = `[${new Date().toISOString()}] [mcp:${tool}] ${message}\n`;
  try { fs.appendFileSync(MCP_LOG_PATH, line); } catch {}
  console.error(line.trimEnd());
}

function extractLarkError(err: any): { code: any; msg: string } {
  return {
    code: err?.code ?? err?.data?.code,
    msg: err?.msg || err?.message || '',
  };
}

function noLarkError(tool: string) {
  mcpLog(tool, 'no Lark credentials');
  return { content: [{ type: 'text' as const, text: 'Lark credentials not available.' }], isError: true };
}

function larkError(tool: string, err: any) {
  const { code, msg } = extractLarkError(err);
  mcpLog(tool, `error: code=${code} msg=${msg}`);
  return { content: [{ type: 'text' as const, text: `${tool} failed: ${msg || 'unknown error'} (code=${code})` }], isError: true };
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// Extract spreadsheet token from URL or raw token
function parseSpreadsheetToken(input: string): string {
  const m = input.match(/sheets\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : input.replace(/[/?#].*$/, '');
}

// Extract document ID from URL or raw token
function parseDocumentId(input: string): string {
  // Match patterns like /docx/XXX or /wiki/XXX
  const m = input.match(/(?:docx|wiki)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : input.replace(/[/?#].*$/, '');
}

// ---------------------------------------------------------------------------
// Tool group gating (optional)
// ---------------------------------------------------------------------------

/** Tool groups. Set NANOCLAW_TOOLS env var to limit which groups register.
 *  Default (unset): all enabled. Example: NANOCLAW_TOOLS=docx,sheets
 *  Note: MCP tools are deferred by default in Claude Code — they only occupy
 *  context when explicitly loaded via ToolSearch, so registering all is fine. */
const ALL_GROUPS = ['docx', 'sheets', 'task', 'search'] as const;
type ToolGroup = typeof ALL_GROUPS[number];

function enabledGroups(): Set<ToolGroup> {
  const env = process.env.NANOCLAW_TOOLS;
  if (!env) return new Set(ALL_GROUPS);
  const requested = env.split(',').map(s => s.trim().toLowerCase());
  return new Set(requested.filter((g): g is ToolGroup => (ALL_GROUPS as readonly string[]).includes(g)));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkspaceTools(
  server: McpServer,
  client: Client,
  larkAvailable: boolean,
  chatJid: string,
): void {
  const groups = enabledGroups();
  mcpLog('workspace', `enabled groups: ${[...groups].join(', ') || '(none)'}`);
  if (groups.size === 0) return;

  const extractChatId = (jid: string) => jid.replace(/^lark:/, '');

  // =========================================================================
  // DOCX — Cloud Documents
  // =========================================================================
  if (groups.has('docx')) {

  server.tool(
    'docx_create',
    `Create a new Lark cloud document. Returns the document URL.
Optionally specify a folder_token to create inside a specific folder (from a Drive URL or folder token).`,
    {
      title: z.string().describe('Document title'),
      folder_token: z.string().optional().describe('Folder token to create in (optional, defaults to root)'),
    },
    async (args) => {
      mcpLog('docx_create', `title="${args.title}" folder=${args.folder_token || 'root'}`);
      if (!larkAvailable) return noLarkError('docx_create');
      try {
        const resp = await (client as any).docx.document.create({
          data: { title: args.title, folder_token: args.folder_token || undefined },
        });
        const doc = resp?.document || resp?.data?.document || resp;
        const docId = doc?.document_id;
        if (!docId) return larkError('docx_create', { msg: 'No document_id in response' });
        const domain = (process.env.LARK_DOMAIN || 'https://open.larksuite.com').replace('/open-apis', '').replace('open.', '');
        const url = `https://${domain.replace(/^https?:\/\//, '')}/docx/${docId}`;
        mcpLog('docx_create', `success: docId=${docId}`);
        return ok(`Document created: ${url}\nDocument ID: ${docId}`);
      } catch (err) { return larkError('docx_create', err); }
    },
  );

  server.tool(
    'docx_read',
    `Read the plain text content of a Lark cloud document.
Accepts a document ID or a full Lark document URL.`,
    {
      document_id: z.string().describe('Document ID or Lark document URL'),
    },
    async (args) => {
      const docId = parseDocumentId(args.document_id);
      mcpLog('docx_read', `docId=${docId}`);
      if (!larkAvailable) return noLarkError('docx_read');
      try {
        const resp = await (client as any).docx.document.rawContent({
          path: { document_id: docId },
          params: { lang: 0 },
        });
        const content = resp?.content || resp?.data?.content || '';
        mcpLog('docx_read', `success: ${content.length} chars`);
        return ok(content || '(empty document)');
      } catch (err) { return larkError('docx_read', err); }
    },
  );

  server.tool(
    'docx_list_blocks',
    `List all content blocks in a Lark document. Useful for understanding document structure before editing.
Returns block IDs, types, and content.`,
    {
      document_id: z.string().describe('Document ID or Lark document URL'),
    },
    async (args) => {
      const docId = parseDocumentId(args.document_id);
      mcpLog('docx_list_blocks', `docId=${docId}`);
      if (!larkAvailable) return noLarkError('docx_list_blocks');
      try {
        const blocks: any[] = [];
        let pageToken: string | undefined;
        do {
          const resp = await (client as any).docx.documentBlock.list({
            path: { document_id: docId },
            params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
          });
          const items = resp?.data?.items || resp?.items || [];
          blocks.push(...items);
          pageToken = resp?.data?.page_token || resp?.page_token;
        } while (pageToken);

        if (blocks.length === 0) return ok('(no blocks)');
        const lines = blocks.map((b: any) => {
          const type = b.block_type_str || b.block_type || 'unknown';
          const id = b.block_id || '';
          // Try to extract text content
          let text = '';
          const body = b.text || b.heading1 || b.heading2 || b.heading3 || b.heading4 || b.heading5 || b.heading6 || b.heading7 || b.heading8 || b.heading9 || b.bullet || b.ordered || b.todo || b.code || b.quote || b.callout;
          if (body?.elements) {
            text = body.elements.map((e: any) => e?.text_run?.content || e?.mention_user?.user_id || '').join('');
          }
          return `[${id}] (${type}) ${text}`;
        });
        mcpLog('docx_list_blocks', `success: ${blocks.length} blocks`);
        return ok(lines.join('\n'));
      } catch (err) { return larkError('docx_list_blocks', err); }
    },
  );

  server.tool(
    'docx_append',
    `Append content blocks to a Lark document. The content is appended after the last block.
Accepts an array of block descriptors. Most common block types:
- text: {"type":"text","content":"Hello world"}
- heading: {"type":"heading2","content":"Section Title"}
- bullet: {"type":"bullet","content":"List item"}
- ordered: {"type":"ordered","content":"Numbered item"}
- code: {"type":"code","content":"console.log('hi')","language":"javascript"}
- todo: {"type":"todo","content":"Buy milk","done":false}
- divider: {"type":"divider"}`,
    {
      document_id: z.string().describe('Document ID or Lark document URL'),
      blocks: z.string().describe('JSON array of block descriptors (see description for format)'),
    },
    async (args) => {
      const docId = parseDocumentId(args.document_id);
      mcpLog('docx_append', `docId=${docId}`);
      if (!larkAvailable) return noLarkError('docx_append');

      let blockDescs: any[];
      try { blockDescs = JSON.parse(args.blocks); } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid JSON in blocks parameter.' }], isError: true };
      }
      if (!Array.isArray(blockDescs)) blockDescs = [blockDescs];

      // Convert simple descriptors to Lark block format
      const children: any[] = blockDescs.map(desc => descToBlock(desc));

      try {
        // Get the document's root block ID (page block)
        const docResp = await (client as any).docx.document.get({
          path: { document_id: docId },
        });
        const pageBlockId = docResp?.document?.document_id || docResp?.data?.document?.document_id || docId;

        await (client as any).docx.documentBlock.childrenBatchCreate({
          path: { document_id: docId, block_id: pageBlockId },
          data: { children, index: -1 },
        });
        mcpLog('docx_append', `success: ${children.length} blocks appended`);
        return ok(`${children.length} block(s) appended to document.`);
      } catch (err) { return larkError('docx_append', err); }
    },
  );

  } // end docx

  // =========================================================================
  // SHEETS — Spreadsheets
  // =========================================================================
  if (groups.has('sheets')) {

  server.tool(
    'sheets_create',
    'Create a new Lark spreadsheet. Returns the spreadsheet URL and token.',
    {
      title: z.string().describe('Spreadsheet title'),
      folder_token: z.string().optional().describe('Folder token (optional)'),
    },
    async (args) => {
      mcpLog('sheets_create', `title="${args.title}"`);
      if (!larkAvailable) return noLarkError('sheets_create');
      try {
        const resp = await (client as any).sheets.spreadsheet.create({
          data: { title: args.title, folder_token: args.folder_token || undefined },
        });
        const sheet = resp?.spreadsheet || resp?.data?.spreadsheet || resp;
        const token = sheet?.spreadsheet_token;
        if (!token) return larkError('sheets_create', { msg: 'No spreadsheet_token in response' });
        const domain = (process.env.LARK_DOMAIN || 'https://open.larksuite.com').replace('/open-apis', '').replace('open.', '');
        const url = `https://${domain.replace(/^https?:\/\//, '')}/sheets/${token}`;
        mcpLog('sheets_create', `success: token=${token}`);
        return ok(`Spreadsheet created: ${url}\nToken: ${token}`);
      } catch (err) { return larkError('sheets_create', err); }
    },
  );

  server.tool(
    'sheets_read',
    `Read cell values from a Lark spreadsheet range.
Range format: "SheetName!A1:D10" or "sheet_id!A1:D10".
Accepts a spreadsheet token or full URL.`,
    {
      spreadsheet: z.string().describe('Spreadsheet token or URL'),
      range: z.string().describe('Range to read, e.g. "Sheet1!A1:D10"'),
    },
    async (args) => {
      const token = parseSpreadsheetToken(args.spreadsheet);
      mcpLog('sheets_read', `token=${token} range=${args.range}`);
      if (!larkAvailable) return noLarkError('sheets_read');
      try {
        const resp = await client.request<any>({
          method: 'GET',
          url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(args.range)}`,
          params: { valueRenderOption: 'ToString' },
        });
        const valueRange = resp?.data?.valueRange || resp?.valueRange;
        const values = valueRange?.values;
        if (!values || values.length === 0) return ok('(empty range)');
        // Format as table
        const table = values.map((row: any[]) =>
          (row || []).map((cell: any) => cell == null ? '' : String(cell)).join('\t')
        ).join('\n');
        mcpLog('sheets_read', `success: ${values.length} rows`);
        return ok(table);
      } catch (err) { return larkError('sheets_read', err); }
    },
  );

  server.tool(
    'sheets_write',
    `Write values to a Lark spreadsheet range. Existing values in the range are overwritten.
Range format: "SheetName!A1:D10" or "sheet_id!A1:D10".
Values: 2D JSON array, e.g. [["Name","Age"],["Alice",30],["Bob",25]]`,
    {
      spreadsheet: z.string().describe('Spreadsheet token or URL'),
      range: z.string().describe('Range to write, e.g. "Sheet1!A1:C3"'),
      values: z.string().describe('2D JSON array of cell values'),
    },
    async (args) => {
      const token = parseSpreadsheetToken(args.spreadsheet);
      mcpLog('sheets_write', `token=${token} range=${args.range}`);
      if (!larkAvailable) return noLarkError('sheets_write');
      let values: any[][];
      try { values = JSON.parse(args.values); } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid JSON in values.' }], isError: true };
      }
      try {
        await client.request({
          method: 'PUT',
          url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
          data: { valueRange: { range: args.range, values } },
        });
        mcpLog('sheets_write', `success: ${values.length} rows written`);
        return ok(`${values.length} row(s) written to ${args.range}.`);
      } catch (err) { return larkError('sheets_write', err); }
    },
  );

  server.tool(
    'sheets_append',
    `Append rows to a Lark spreadsheet. Values are added after the last non-empty row in the range.
Range format: "SheetName!A1:D1" (specifies columns to use).
Values: 2D JSON array of rows to append.`,
    {
      spreadsheet: z.string().describe('Spreadsheet token or URL'),
      range: z.string().describe('Range specifying columns, e.g. "Sheet1!A1:D1"'),
      values: z.string().describe('2D JSON array of rows to append'),
    },
    async (args) => {
      const token = parseSpreadsheetToken(args.spreadsheet);
      mcpLog('sheets_append', `token=${token} range=${args.range}`);
      if (!larkAvailable) return noLarkError('sheets_append');
      let values: any[][];
      try { values = JSON.parse(args.values); } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid JSON in values.' }], isError: true };
      }
      try {
        await client.request({
          method: 'POST',
          url: `/open-apis/sheets/v2/spreadsheets/${token}/values_append`,
          data: { valueRange: { range: args.range, values } },
        });
        mcpLog('sheets_append', `success: ${values.length} rows appended`);
        return ok(`${values.length} row(s) appended.`);
      } catch (err) { return larkError('sheets_append', err); }
    },
  );

  } // end sheets

  // =========================================================================
  // TASK — Lark Task Management
  // =========================================================================
  if (groups.has('task')) {

  server.tool(
    'lark_task_create',
    `Create a Lark task (visible in Lark's Task app). Different from schedule_task which is NanoClaw's internal scheduler.
Due date format: Unix timestamp in seconds as a string, e.g. "1735689600".`,
    {
      summary: z.string().describe('Task title/summary'),
      description: z.string().optional().describe('Task description'),
      due_timestamp: z.string().optional().describe('Due date as unix timestamp in seconds (e.g. "1735689600")'),
    },
    async (args) => {
      mcpLog('lark_task_create', `summary="${args.summary}"`);
      if (!larkAvailable) return noLarkError('lark_task_create');
      try {
        const data: any = {
          summary: args.summary,
          origin: { platform_i18n_name: 'NanoClaw' },
        };
        if (args.description) data.description = args.description;
        if (args.due_timestamp) data.due = { time: args.due_timestamp, is_all_day: false };

        const resp = await (client as any).task.task.create({ data });
        const task = resp?.task || resp?.data?.task || resp;
        const taskId = task?.id;
        mcpLog('lark_task_create', `success: taskId=${taskId}`);
        return ok(`Task created: "${args.summary}"\nTask ID: ${taskId || 'unknown'}`);
      } catch (err) { return larkError('lark_task_create', err); }
    },
  );

  server.tool(
    'lark_task_list',
    'List Lark tasks. Optionally filter by completion status.',
    {
      completed: z.boolean().optional().describe('Filter: true=completed only, false=incomplete only, omit=all'),
      page_size: z.number().min(1).max(100).default(50).describe('Number of tasks to return (default 50)'),
    },
    async (args) => {
      mcpLog('lark_task_list', `completed=${args.completed} pageSize=${args.page_size}`);
      if (!larkAvailable) return noLarkError('lark_task_list');
      try {
        const params: any = { page_size: args.page_size || 50 };
        if (args.completed !== undefined) params.task_completed = args.completed;

        const resp = await (client as any).task.task.list({ params });
        const items = resp?.data?.items || resp?.items || [];
        if (items.length === 0) return ok('No tasks found.');

        const lines = items.map((t: any) => {
          const status = t.completed_at ? '[x]' : '[ ]';
          const due = t.due?.time ? ` (due: ${new Date(Number(t.due.time) * 1000).toISOString().slice(0, 10)})` : '';
          return `${status} ${t.summary || '(no title)'}${due} — id: ${t.id}`;
        });
        mcpLog('lark_task_list', `success: ${items.length} tasks`);
        return ok(lines.join('\n'));
      } catch (err) { return larkError('lark_task_list', err); }
    },
  );

  server.tool(
    'lark_task_complete',
    'Mark a Lark task as completed.',
    {
      task_id: z.string().describe('The Lark task ID'),
    },
    async (args) => {
      mcpLog('lark_task_complete', `taskId=${args.task_id}`);
      if (!larkAvailable) return noLarkError('lark_task_complete');
      try {
        await (client as any).task.task.complete({ path: { task_id: args.task_id } });
        mcpLog('lark_task_complete', 'success');
        return ok(`Task ${args.task_id} marked complete.`);
      } catch (err) { return larkError('lark_task_complete', err); }
    },
  );

  server.tool(
    'lark_task_update',
    'Update an existing Lark task (summary, description, or due date).',
    {
      task_id: z.string().describe('The Lark task ID'),
      summary: z.string().optional().describe('New summary'),
      description: z.string().optional().describe('New description'),
      due_timestamp: z.string().optional().describe('New due date as unix timestamp in seconds'),
    },
    async (args) => {
      mcpLog('lark_task_update', `taskId=${args.task_id}`);
      if (!larkAvailable) return noLarkError('lark_task_update');

      const task: any = {};
      const updateFields: string[] = [];
      if (args.summary !== undefined) { task.summary = args.summary; updateFields.push('summary'); }
      if (args.description !== undefined) { task.description = args.description; updateFields.push('description'); }
      if (args.due_timestamp !== undefined) { task.due = { time: args.due_timestamp, is_all_day: false }; updateFields.push('due'); }

      if (updateFields.length === 0) return ok('Nothing to update.');
      try {
        await (client as any).task.task.patch({
          path: { task_id: args.task_id },
          data: { task, update_fields: updateFields },
        });
        mcpLog('lark_task_update', `success: updated ${updateFields.join(', ')}`);
        return ok(`Task ${args.task_id} updated: ${updateFields.join(', ')}.`);
      } catch (err) { return larkError('lark_task_update', err); }
    },
  );

  server.tool(
    'lark_task_delete',
    'Delete a Lark task.',
    {
      task_id: z.string().describe('The Lark task ID to delete'),
    },
    async (args) => {
      mcpLog('lark_task_delete', `taskId=${args.task_id}`);
      if (!larkAvailable) return noLarkError('lark_task_delete');
      try {
        await (client as any).task.task.delete({ path: { task_id: args.task_id } });
        mcpLog('lark_task_delete', 'success');
        return ok(`Task ${args.task_id} deleted.`);
      } catch (err) { return larkError('lark_task_delete', err); }
    },
  );

  } // end task

  // =========================================================================
  // SEARCH — Message Search
  // =========================================================================
  if (groups.has('search')) {

  server.tool(
    'search_messages',
    `Search for messages across Lark chats. By default searches only the current chat.
Set search_all=true to search across all chats the bot is in.
Supports filtering by sender type, message type, and time range.`,
    {
      query: z.string().describe('Search keywords'),
      search_all: z.boolean().default(false).describe('Search all chats (default: current chat only)'),
      from_type: z.enum(['user', 'bot']).optional().describe('Filter by sender type'),
      message_type: z.enum(['file', 'image', 'media']).optional().describe('Filter by message type'),
      page_size: z.number().min(1).max(50).default(20).describe('Number of results (default 20)'),
    },
    async (args) => {
      mcpLog('search_messages', `query="${args.query}" all=${args.search_all}`);
      if (!larkAvailable) return noLarkError('search_messages');
      try {
        const data: any = { query: args.query };
        if (!args.search_all) {
          data.chat_ids = [extractChatId(chatJid)];
        }
        if (args.from_type) data.from_type = args.from_type;
        if (args.message_type) data.message_type = args.message_type;

        const resp = await (client as any).search.message.create({
          data,
          params: { page_size: args.page_size || 20 },
        });
        const items: string[] = resp?.data?.items || resp?.items || [];
        if (items.length === 0) return ok('No messages found.');

        const results = items.map((item: any) => {
          // Items may be JSON strings or objects
          const msg = typeof item === 'string' ? JSON.parse(item) : item;
          const time = msg.create_time ? new Date(Number(msg.create_time) * 1000).toISOString().slice(0, 16) : '';
          const sender = msg.sender?.sender_type === 'bot' ? '(bot)' : '(user)';
          const chatId = msg.chat_id || '';
          let content = '';
          try {
            if (msg.body?.content) {
              const parsed = JSON.parse(msg.body.content);
              content = parsed.text || parsed.content || JSON.stringify(parsed).slice(0, 200);
            }
          } catch { content = msg.body?.content?.slice(0, 200) || ''; }
          return `[${time}] ${sender} in ${chatId}: ${content}`;
        });

        mcpLog('search_messages', `success: ${results.length} results`);
        return ok(results.join('\n'));
      } catch (err) { return larkError('search_messages', err); }
    },
  );

  } // end search
}

// ---------------------------------------------------------------------------
// Block descriptor → Lark block format converter
// ---------------------------------------------------------------------------

function textElements(content: string): any[] {
  return [{ text_run: { content } }];
}

const BLOCK_TYPE_MAP: Record<string, number> = {
  text: 2, heading1: 3, heading2: 4, heading3: 5, heading4: 6,
  heading5: 7, heading6: 8, heading7: 9, heading8: 10, heading9: 11,
  bullet: 12, ordered: 13, code: 14, quote: 15, todo: 17, divider: 22,
};

function descToBlock(desc: any): any {
  const type = desc.type || 'text';
  const blockType = BLOCK_TYPE_MAP[type];
  if (!blockType) {
    // Default to text
    return { block_type: 2, text: { elements: textElements(desc.content || '') } };
  }

  if (type === 'divider') return { block_type: 22 };

  if (type === 'code') {
    return {
      block_type: 14,
      code: {
        elements: textElements(desc.content || ''),
        language: desc.language ? codeLanguageValue(desc.language) : 1, // PlainText
      },
    };
  }

  if (type === 'todo') {
    return {
      block_type: 17,
      todo: {
        elements: textElements(desc.content || ''),
        done: desc.done === true,
      },
    };
  }

  // heading, bullet, ordered, quote, text — all use elements
  const fieldName = type.startsWith('heading') ? type : type;
  return {
    block_type: blockType,
    [fieldName]: { elements: textElements(desc.content || '') },
  };
}

function codeLanguageValue(lang: string): number {
  const map: Record<string, number> = {
    plaintext: 1, python: 49, javascript: 33, typescript: 67, java: 32,
    go: 28, rust: 56, c: 6, cpp: 7, csharp: 8, ruby: 55, php: 48,
    shell: 58, bash: 58, sql: 61, json: 34, xml: 72, yaml: 73,
    markdown: 40, html: 29, css: 10,
  };
  return map[lang.toLowerCase()] || 1;
}
