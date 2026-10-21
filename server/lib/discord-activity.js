/**
 * Discord Activities ("play inside Discord").
 *
 * An Activity is our own web page in an iframe, so the game code is the same as
 * the website's. What it needs from this server is the half of the OAuth2 flow
 * that must never happen in a browser:
 *
 *   1. The page asks Discord's Embedded App SDK for a one-time `code`.
 *   2. It posts that code to /api/discord/activity/token. This module exchanges
 *      it at Discord with the client secret, and hands back only the access
 *      token (the secret never leaves the process).
 *   3. It posts the access token to /api/discord/activity/session. This module
 *      asks Discord who it is, quietly provisions an arcade account for that
 *      Discord id the first time, and returns a normal arcade session.
 *
 * Everything here is deliberately dependency-free (global fetch), like the
 * bot's own Discord client, and talks only to the two Discord endpoints named
 * in server/config.js so the checks can point it at a stand-in.
 */
import { config } from '../config.js';
import { HttpError } from './http.js';
import { botAppId } from '../bot.js';

/**
 * The application id the Activity is published under. It is public (it travels
 * in the page and the SDK handshake), so an explicit value wins, and the bot
 * token's own id is the fallback for an operator who only set that.
 */
export function activityClientId() {
  if (/^\d{5,25}$/.test(config.discord.clientId)) return config.discord.clientId;
  return botAppId({ env: process.env, fileEnv: {} });
}

/**
 * The public origin an operator maps `/` to in the Developer Portal. Discord's
 * proxy serves the Activity from the root of that mapping, so the site's own
 * root page is the Activity entry point - it recognises the SDK's frame_id and
 * becomes the Activity. /activity is the same page opened directly, which is
 * handy for seeing what a player without Discord would get.
 */
export function activityUrl() {
  return String(config.publicUrl || '').replace(/\/$/, '');
}

let cachedSettings = null;
let cachedAt = 0;

/**
 * What the console and the client may know. `enabled` means the credentials
 * needed for the whole flow are here - a client id alone still lets the page
 * talk to Discord, but the code exchange would fail, so it is not enabled.
 *
 * Cached for a few seconds: this shape rides every /api/meta response, and the
 * only inputs are process config plus a tiny bot/.env read. The cache also
 * keeps a page load from reading that file several times.
 */
export function activitySettings({ fresh = false } = {}) {
  if (!fresh && cachedSettings && Date.now() - cachedAt < 10000) return cachedSettings;
  const clientId = activityClientId();
  const secret = config.discord.clientSecret;
  const missing = [];
  if (!clientId) missing.push('DISCORD_CLIENT_ID');
  if (!secret) missing.push('DISCORD_CLIENT_SECRET');
  cachedSettings = {
    enabled: missing.length === 0,
    clientId: clientId || null,
    // The redirect URI is only a placeholder for Activities: the SDK handles
    // the return trip itself, and the token exchange sends no redirect_uri.
    redirectUri: 'https://127.0.0.1',
    url: activityUrl(),
    // URL mappings omit the protocol ("do not put https://", per Discord).
    target: activityUrl().replace(/^https?:\/\//, ''),
    path: '/',
    testPath: config.discord.activityPath,
    missing,
  };
  cachedAt = Date.now();
  return cachedSettings;
}

/** Discord ids in an Activity instance id are opaque, URL-safe tokens. */
export function normalizeInstanceId(value) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) return null;
  return id;
}

/**
 * Exchange the SDK's one-time code for an access token. Errors are turned into
 * answers a player (or the owner reading logs) can act on - never a stack trace
 * and never the client secret.
 */
export async function exchangeActivityCode(code) {
  const settings = activitySettings();
  if (!settings.enabled) {
    throw new HttpError(503, `Discord Activities are not configured on this arcade. An admin must set ${settings.missing.join(' and ')}.`);
  }
  const clean = String(code ?? '').trim();
  if (!clean || clean.length > 512) throw new HttpError(400, 'That Discord sign-in code is missing or malformed.');

  let res;
  try {
    res = await fetch(config.discord.oauthUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: clean,
      }),
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach Discord to finish sign-in: ${err.message}`);
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {}
  if (!res.ok || !payload?.access_token) {
    // Discord's own wording is useful ("invalid_grant" means an expired or
    // already-used code) and contains nothing secret.
    const why = payload?.error_description || payload?.error || `Discord answered ${res.status}`;
    throw new HttpError(400, `Discord would not accept that sign-in: ${why}`);
  }
  return { accessToken: payload.access_token, scope: payload.scope || '', tokenType: payload.token_type || 'Bearer' };
}

/** Ask Discord who an access token belongs to. This is the identity proof. */
export async function fetchActivityUser(accessToken) {
  const token = String(accessToken ?? '').trim();
  if (!token || token.length > 512) throw new HttpError(400, 'Missing Discord access token.');
  let res;
  try {
    res = await fetch(`${config.discord.apiBase}/users/@me`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach Discord to check who you are: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, 'Discord rejected that sign-in - close the Activity and open it again.');
  }
  if (!res.ok) throw new HttpError(502, `Discord answered ${res.status} while checking your account.`);
  const user = await res.json().catch(() => null);
  if (!user?.id) throw new HttpError(502, 'Discord did not say which account that token belongs to.');
  return {
    id: String(user.id),
    username: String(user.username || ''),
    globalName: String(user.global_name || ''),
    avatar: user.avatar || null,
  };
}
