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
