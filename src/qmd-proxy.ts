/**
 * QMD Proxy — centralized MCP server for per-group search.
 *
 * Each group gets an isolated QMDStore (separate SQLite database).
 * Containers connect via HTTP MCP with `X-NanoClaw-Group` header for routing.
 * Stores are lazy-initialized and closed after 30 minutes of inactivity.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { createStore, type QMDStore, extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES } from '@tobilu/qmd';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { QMD_DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Per-group store pool
// ---------------------------------------------------------------------------

interface StoreEntry {
  store: QMDStore;
  lastAccess: number;
}

const stores = new Map<string, StoreEntry>();
const STORE_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const REINDEX_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Validate group folder name — reject path traversal and absolute paths. */
function isValidGroup(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && !name.includes('..');
}

/** Get collections config for a group. */
function collectionsForGroup(groupFolder: string): Record<string, { path: string; pattern: string }> {
  const collections: Record<string, { path: string; pattern: string }> = {};

  const conversationsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  if (fs.existsSync(conversationsDir)) {
    collections.conversations = { path: conversationsDir, pattern: '**/*.md' };
  }

  const knowledgeDir = path.join(GROUPS_DIR, 'global', 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    collections.kb = { path: knowledgeDir, pattern: '**/*.md' };
  }

  return collections;
}

async function getOrCreateStore(groupFolder: string): Promise<QMDStore> {
  const existing = stores.get(groupFolder);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing.store;
  }

  const dbDir = path.join(QMD_DATA_DIR, groupFolder);
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'index.sqlite');

  const collections = collectionsForGroup(groupFolder);
  const store = await createStore({
    dbPath,
    config: Object.keys(collections).length > 0
      ? { collections }
      : undefined,
  });

  stores.set(groupFolder, { store, lastAccess: Date.now() });
  logger.info({ groupFolder, dbPath, collections: Object.keys(collections) }, 'QMD store created');

  // Background index + embed (don't block the request)
  indexStore(groupFolder, store).catch((err) => {
    logger.warn({ groupFolder, err }, 'QMD background index failed');
  });

  return store;
}

async function indexStore(groupFolder: string, store: QMDStore): Promise<void> {
  const updateResult = await store.update();
  if (updateResult.indexed > 0 || updateResult.updated > 0 || updateResult.removed > 0) {
    logger.info({ groupFolder, ...updateResult }, 'QMD store updated');
  }
  const embedResult = await store.embed();
  if (embedResult.chunksEmbedded > 0) {
    logger.info({ groupFolder, chunksEmbedded: embedResult.chunksEmbedded }, 'QMD embeddings generated');
  }
}

/** Close idle stores to free LLM memory. */
function reapIdleStores(): void {
  const now = Date.now();
  for (const [group, entry] of stores) {
    if (now - entry.lastAccess > STORE_IDLE_MS) {
      entry.store.close().catch(() => {});
      stores.delete(group);
      logger.info({ group }, 'QMD store closed (idle)');
    }
  }
}

// ---------------------------------------------------------------------------
// MCP server factory — registers the 4 qmd tools for a given store
// ---------------------------------------------------------------------------

function formatSearchSummary(
  results: Array<{ docid: string; file: string; title: string; score: number; snippet: string }>,
  query: string,
): string {
  if (results.length === 0) return `No results found for "${query}"`;
  const lines = [`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file} - ${r.title}`);
  }
  return lines.join('\n');
}

async function buildInstructions(store: QMDStore): Promise<string> {
  const status = await store.getStatus();
  const lines: string[] = [];
  lines.push(`QMD is your local search engine over ${status.totalDocuments} markdown documents.`);

  if (status.collections.length > 0) {
    lines.push('');
    lines.push('Collections (scope with `collection` parameter):');
    for (const col of status.collections) {
      lines.push(`  - "${col.name}" (${col.documents} docs)`);
    }
  }

  if (!status.hasVectorIndex) {
    lines.push('');
    lines.push('Note: No vector embeddings yet. Semantic search (vec/hyde) unavailable until embedding completes.');
  } else if (status.needsEmbedding > 0) {
    lines.push('');
    lines.push(`Note: ${status.needsEmbedding} documents need embedding.`);
  }

  lines.push('');
  lines.push('Search: Use `query` with sub-queries (lex/vec/hyde):');
  lines.push('  - type:\'lex\' — BM25 keyword search (exact terms, fast)');
  lines.push('  - type:\'vec\' — semantic vector search (meaning-based)');
  lines.push('  - type:\'hyde\' — hypothetical document (write what the answer looks like)');
  lines.push('');
  lines.push('Always provide `intent` on every search call to disambiguate and improve snippets.');
  return lines.join('\n');
}

async function createMcpServer(store: QMDStore): Promise<McpServer> {
  const instructions = await buildInstructions(store);
  const server = new McpServer(
    { name: 'qmd', version: '2.0.0' },
    { instructions },
  );

  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // -- Tool: query --
  const subSearchSchema = z.object({
    type: z.enum(['lex', 'vec', 'hyde']).describe(
      'lex = BM25 keywords (supports "phrase" and -negation); vec = semantic question; hyde = hypothetical answer passage',
    ),
    query: z.string().describe(
      'The query text. For lex: keywords, "quoted phrases", -negation. For vec: natural language. For hyde: 50-100 word answer passage.',
    ),
  });

  server.registerTool('query', {
    title: 'Query',
    description: [
      'Search the knowledge base using typed sub-queries combined for best recall.',
      '',
      '**lex** — BM25 keyword search. Supports "exact phrase", -negation, prefix match.',
      '**vec** — Semantic vector search. Write a natural language question.',
      '**hyde** — Hypothetical document. Write 50-100 words that look like the answer.',
      '',
      'Combine types for best results. First sub-query gets 2x weight.',
    ].join('\n'),
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      searches: z.array(subSearchSchema).min(1).max(10).describe('Typed sub-queries to execute'),
      limit: z.number().optional().default(10).describe('Max results (default: 10)'),
      minScore: z.number().optional().default(0).describe('Min relevance 0-1'),
      collections: z.array(z.string()).optional().describe('Filter to collections'),
      intent: z.string().optional().describe('Background context to disambiguate the query'),
    },
  }, async ({ searches, limit, minScore, collections, intent }) => {
    const queries = searches.map((s: { type: string; query: string }) => ({
      type: s.type as 'lex' | 'vec' | 'hyde',
      query: s.query,
    }));
    const effectiveCollections = collections ?? defaultCollectionNames;
    const results = await store.search({
      queries,
      collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
      limit,
      minScore,
      intent,
    });

    const primaryQuery = searches.find((s: { type: string }) => s.type === 'lex')?.query
      || searches.find((s: { type: string }) => s.type === 'vec')?.query
      || searches[0]?.query || '';

    const filtered = results.map((r) => {
      const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300, undefined, undefined, intent);
      return {
        docid: `#${r.docid}`,
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: r.context,
        snippet: addLineNumbers(snippet, line),
      };
    });
    return {
      content: [{ type: 'text' as const, text: formatSearchSummary(filtered, primaryQuery) }],
      structuredContent: { results: filtered },
    };
  });

  // -- Tool: get --
  server.registerTool('get', {
    title: 'Get Document',
    description: 'Retrieve the full content of a document by file path or docid (#abc123). Supports :line suffix.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      file: z.string().describe("File path or docid (e.g. 'pages/meeting.md', '#abc123', 'pages/meeting.md:100')"),
      fromLine: z.number().optional().describe('Start from this line number'),
      maxLines: z.number().optional().describe('Maximum lines to return'),
      lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output"),
    },
  }, async ({ file, fromLine, maxLines, lineNumbers }) => {
    let parsedFromLine = fromLine;
    let lookup = file;
    const colonMatch = lookup.match(/:(\d+)$/);
    if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
      parsedFromLine = parseInt(colonMatch[1], 10);
      lookup = lookup.slice(0, -colonMatch[0].length);
    }
    const result = await store.get(lookup, { includeBody: false });
    if ('error' in result) {
      let msg = `Document not found: ${file}`;
      if (result.similarFiles.length > 0) {
        msg += `\n\nDid you mean:\n${result.similarFiles.map((s: string) => `  - ${s}`).join('\n')}`;
      }
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
    const body = await store.getDocumentBody(result.filepath, { fromLine: parsedFromLine, maxLines }) ?? '';
    let text = lineNumbers ? addLineNumbers(body, parsedFromLine || 1) : body;
    if (result.context) text = `<!-- Context: ${result.context} -->\n\n` + text;
    return {
      content: [{
        type: 'resource' as const,
        resource: { uri: `qmd://${result.displayPath}`, name: result.displayPath, title: result.title, mimeType: 'text/markdown', text },
      }],
    };
  });

  // -- Tool: multi_get --
  server.registerTool('multi_get', {
    title: 'Multi-Get Documents',
    description: "Retrieve multiple documents by glob pattern or comma-separated list.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      pattern: z.string().describe('Glob pattern or comma-separated paths'),
      maxLines: z.number().optional().describe('Max lines per file'),
      maxBytes: z.number().optional().default(10240).describe('Skip files larger than this (default: 10KB)'),
      lineNumbers: z.boolean().optional().default(false).describe("Add line numbers"),
    },
  }, async ({ pattern, maxLines, maxBytes, lineNumbers }) => {
    const { docs, errors } = await store.multiGet(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });
    if (docs.length === 0 && errors.length === 0) {
      return { content: [{ type: 'text' as const, text: `No files matched: ${pattern}` }], isError: true };
    }
    const content: Array<{ type: 'text'; text: string } | { type: 'resource'; resource: { uri: string; name: string; title: string; mimeType: string; text: string } }> = [];
    if (errors.length > 0) content.push({ type: 'text', text: `Errors:\n${errors.join('\n')}` });
    for (const result of docs) {
      if (result.skipped) {
        content.push({ type: 'text', text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}]` });
        continue;
      }
      let text = result.doc.body || '';
      if (maxLines !== undefined) {
        const lines = text.split('\n');
        text = lines.slice(0, maxLines).join('\n');
        if (lines.length > maxLines) text += `\n\n[... truncated ${lines.length - maxLines} lines]`;
      }
      if (lineNumbers) text = addLineNumbers(text);
      if (result.doc.context) text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
      content.push({ type: 'resource', resource: { uri: `qmd://${result.doc.displayPath}`, name: result.doc.displayPath, title: result.doc.title, mimeType: 'text/markdown', text } });
    }
    return { content };
  });

  // -- Tool: status --
  server.registerTool('status', {
    title: 'Index Status',
    description: 'Show QMD index status: collections, document counts, health.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => {
    const status = await store.getStatus();
    const lines = [
      'QMD Index Status:',
      `  Total documents: ${status.totalDocuments}`,
      `  Needs embedding: ${status.needsEmbedding}`,
      `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
      `  Collections: ${status.collections.length}`,
    ];
    for (const col of status.collections) {
      lines.push(`    - ${col.path} (${col.documents} docs)`);
    }
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: status,
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Per-group MCP session management
// ---------------------------------------------------------------------------

// Each client connection gets its own Transport+McpServer pair (MCP spec).
// The QMDStore is shared within a group (SQLite handles concurrent reads).
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function createSession(store: QMDStore): Promise<WebStandardStreamableHTTPServerTransport> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, transport);
      logger.debug({ sessionId, activeSessions: sessions.size }, 'QMD MCP session created');
    },
  });
  const server = await createMcpServer(store);
  await server.connect(transport);
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  return transport;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function collectBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

let httpServer: http.Server | null = null;
let idleReaper: ReturnType<typeof setInterval> | null = null;
let reindexTimer: ReturnType<typeof setInterval> | null = null;

export async function startQmdProxy(port: number, host: string): Promise<void> {
  fs.mkdirSync(QMD_DATA_DIR, { recursive: true });

  httpServer = http.createServer(async (req, res) => {
    const pathname = req.url || '/';

    try {
      // Health check
      if (pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', stores: stores.size, sessions: sessions.size }));
        return;
      }

      // MCP endpoint
      if (pathname === '/mcp' && req.method === 'POST') {
        const groupFolder = req.headers['x-nanoclaw-group'] as string | undefined;
        if (!groupFolder || !isValidGroup(groupFolder)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid X-NanoClaw-Group header' }));
          return;
        }

        const store = await getOrCreateStore(groupFolder);
        const body = await collectBody(req);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        // Route to existing session or create new one
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId && sessions.has(sessionId)) {
          transport = sessions.get(sessionId)!;
        } else if (isInitializeRequest(parsed)) {
          transport = await createSession(store);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No active session. Send initialize first.' }));
          return;
        }

        // Convert Node.js request to Web Request for the transport
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(', '));
        }
        const webRequest = new Request(`http://localhost${pathname}`, {
          method: 'POST',
          headers,
          body,
        });

        const webResponse = await transport.handleRequest(webRequest);
        res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
        const responseBody = await webResponse.text();
        res.end(responseBody);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err, url: req.url }, 'QMD proxy request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    logger.info({ port, host }, 'QMD proxy started');
  });

  // Idle store reaper — every 5 minutes
  idleReaper = setInterval(reapIdleStores, 5 * 60 * 1000);

  // Periodic re-index — every 30 minutes
  reindexTimer = setInterval(async () => {
    for (const [group, entry] of stores) {
      try {
        await indexStore(group, entry.store);
      } catch (err) {
        logger.warn({ group, err }, 'QMD periodic reindex failed');
      }
    }
  }, REINDEX_INTERVAL_MS);

  // Pre-index all registered groups in the background
  preIndexExistingGroups().catch((err) => {
    logger.warn({ err }, 'QMD pre-index failed');
  });
}

/** Pre-index stores for groups that already have conversations or knowledge. */
async function preIndexExistingGroups(): Promise<void> {
  try {
    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'global') continue;
      if (!isValidGroup(entry.name)) continue;
      const conversationsDir = path.join(GROUPS_DIR, entry.name, 'conversations');
      if (fs.existsSync(conversationsDir)) {
        await getOrCreateStore(entry.name);
      }
    }
  } catch {
    // groups dir may not exist yet
  }
}

export function stopQmdProxy(): void {
  if (idleReaper) { clearInterval(idleReaper); idleReaper = null; }
  if (reindexTimer) { clearInterval(reindexTimer); reindexTimer = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  // Close all stores
  for (const [group, entry] of stores) {
    entry.store.close().catch(() => {});
    logger.debug({ group }, 'QMD store closed (shutdown)');
  }
  stores.clear();
  sessions.clear();
}
