/**
 * Lark SDK client singleton for container-side direct API calls.
 * Credentials are passed via environment variables from the host.
 *
 * Keep-alive: Node.js 22 enables keepAlive on https.globalAgent by default,
 * so the SDK's internal axios instance reuses TLS connections automatically.
 */
import { Client } from '@larksuiteoapi/node-sdk';

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;

/** Whether Lark credentials are available in this container. */
export const larkAvailable = !!(appId && appSecret);

/** Lark SDK client. Only use after checking `larkAvailable`. */
/** Strip the `lark:` prefix from a JID to get the raw chat_id. */
export function extractChatId(jid: string): string {
  return jid.replace(/^lark:/, '');
}

export const larkClient = larkAvailable
  ? new Client({
      appId: appId!,
      appSecret: appSecret!,
      domain: (process.env.LARK_DOMAIN as any) || 'https://open.larksuite.com',
    })
  : (null as unknown as Client);

/**
 * Pre-warm the Lark SDK: fetch tenant_access_token + establish HTTPS connection.
 * Call once during container idle time so the first real API call is fast.
 * Mirrors the official feishu-plugin's probe() pattern.
 */
export async function warmupLarkClient(): Promise<void> {
  if (!larkAvailable) return;
  try {
    const start = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (larkClient as any).request({ method: 'GET', url: '/open-apis/bot/v3/info', data: {} });
    console.error(`[agent-runner] [timing] Lark warmup done in ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[agent-runner] Lark warmup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
