/**
 * Credential Proxy — sits between containers and the Anthropic API.
 * Containers send requests with placeholder credentials; this proxy
 * strips the placeholder and injects real credentials before forwarding.
 *
 * Containers never see real API keys or OAuth tokens.
 */
import http from 'http';
import https from 'https';

import { getClaudeOAuthToken } from './claude-credentials.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const UPSTREAM = 'https://api.anthropic.com';

type AuthMode = 'api-key' | 'oauth' | 'none';

interface Credentials {
  mode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
}

async function loadCredentials(): Promise<Credentials> {
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

  if (env.ANTHROPIC_API_KEY) {
    return { mode: 'api-key', apiKey: env.ANTHROPIC_API_KEY };
  }

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { mode: 'oauth', oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  // Fallback: Claude CLI credentials
  const token = await getClaudeOAuthToken();
  if (token) {
    return { mode: 'oauth', oauthToken: token };
  }

  return { mode: 'none' };
}

function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    // Skip hop-by-hop and host headers
    if (['connection', 'keep-alive', 'transfer-encoding', 'host'].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function startCredentialProxy(
  port: number,
  bindHost: string,
): Promise<http.Server> {
  let creds = await loadCredentials();

  // Re-read credentials periodically (handles token refresh)
  const refreshInterval = setInterval(async () => {
    try {
      creds = await loadCredentials();
    } catch (err) {
      logger.warn({ err }, 'Credential proxy: failed to refresh credentials');
    }
  }, 4 * 60 * 1000); // every 4 minutes

  const server = http.createServer((req, res) => {
    const headers = stripHopByHopHeaders(req.headers);

    // Inject credentials based on auth mode
    if (creds.mode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = creds.apiKey!;
    } else if (creds.mode === 'oauth') {
      // Only inject Authorization when the container sends one (placeholder).
      // Post-exchange requests use temp API keys and don't send Authorization.
      if (req.headers['authorization']) {
        delete headers['authorization'];
        headers['authorization'] = `Bearer ${creds.oauthToken}`;
      }
    }

    const upstreamUrl = new URL(req.url || '/', UPSTREAM);

    const upstreamReq = https.request(
      {
        hostname: upstreamUrl.hostname,
        port: 443,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      logger.warn({ err, path: req.url }, 'Credential proxy: upstream error');
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('Bad Gateway');
    });

    req.pipe(upstreamReq);
  });

  server.on('close', () => clearInterval(refreshInterval));

  return new Promise((resolve, reject) => {
    server.listen(port, bindHost, () => {
      logger.info(
        { port, bindHost, authMode: creds.mode },
        'Credential proxy started',
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}
