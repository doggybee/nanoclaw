/**
 * Read Claude OAuth credentials from ~/.claude/.credentials.json
 * and auto-refresh when expired.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const CREDENTIALS_PATH = path.join(
  process.env.HOME || '/root',
  '.claude',
  '.credentials.json',
);
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh when less than 5 minutes remain. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeOAuth;
}

function readCredentialsFile(): ClaudeOAuth | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed: CredentialsFile = JSON.parse(raw);
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function writeCredentialsFile(oauth: ClaudeOAuth): void {
  try {
    let existing: CredentialsFile = {};
    try {
      existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    } catch {
      // Start fresh
    }
    existing.claudeAiOauth = oauth;
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(existing, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to write refreshed credentials');
  }
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<ClaudeOAuth | null> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status, body: await res.text().catch(() => '') },
        'OAuth token refresh failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const oauth: ClaudeOAuth = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: data.scope ? data.scope.split(' ') : [],
    };

    writeCredentialsFile(oauth);
    logger.info('Claude OAuth token refreshed');
    return oauth;
  } catch (err) {
    logger.warn({ err }, 'OAuth token refresh error');
    return null;
  }
}

/**
 * Get a valid Claude OAuth access token.
 * Reads from ~/.claude/.credentials.json and refreshes if expired.
 * Returns null if no credentials are available.
 */
export async function getClaudeOAuthToken(): Promise<string | null> {
  const creds = readCredentialsFile();
  if (!creds?.accessToken) return null;

  const needsRefresh =
    creds.expiresAt != null &&
    creds.expiresAt - Date.now() < REFRESH_MARGIN_MS;

  if (!needsRefresh) return creds.accessToken;

  if (!creds.refreshToken) {
    logger.warn('Claude OAuth token expiring but no refresh token available');
    return creds.accessToken;
  }

  const refreshed = await refreshAccessToken(creds.refreshToken);
  return refreshed?.accessToken ?? creds.accessToken;
}
