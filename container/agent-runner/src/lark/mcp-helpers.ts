/**
 * Shared helpers for MCP tool handlers.
 */
import fs from 'fs';

const MCP_LOG_PATH = '/tmp/mcp-nanoclaw.log';

export function mcpLog(tool: string, message: string): void {
  const line = `[${new Date().toISOString()}] [mcp:${tool}] ${message}\n`;
  try { fs.appendFileSync(MCP_LOG_PATH, line); } catch {}
  console.error(line.trimEnd());
}

export function extractLarkError(err: any): { code: any; msg: string } {
  return {
    code: err?.code ?? err?.data?.code,
    msg: err?.msg || err?.message || '',
  };
}

export function noLarkError(tool: string) {
  mcpLog(tool, 'no Lark credentials');
  return { content: [{ type: 'text' as const, text: 'Lark credentials not available.' }], isError: true };
}

export function larkError(tool: string, err: any) {
  const { code, msg } = extractLarkError(err);
  mcpLog(tool, `error: code=${code} msg=${msg}`);
  return { content: [{ type: 'text' as const, text: `${tool} failed: ${msg || 'unknown error'} (code=${code})` }], isError: true };
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
