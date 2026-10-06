/**
 * Memes Arcade - cross-version compatibility contract.
 *
 * This module is the single source of truth for "can this client talk to this
 * server, and which features may it use".  It is imported by the web client,
 * the desktop client, the Discord bot, and the API server, so the rules can
 * never drift apart.
 *
 * Compatibility policy (see docs/COMPATIBILITY.md for the long version):
 *  1. The wire protocol and the REST surface only ever change *additively*
 *     inside a major API version.
 *  2. New features ship behind a *capability flag*.  A client that does not
 *     advertise a capability simply never receives payloads for it.
 *  3. MIN_CLIENT_VERSION is bumped only when an old client would misbehave
 *     (not merely to drop support).  Older-but-supported clients get a
 *     `degraded` list in the handshake so the UI can explain what is missing.
 *  4. Unknown fields and unknown message types must be ignored, never fatal.
 *     Both directions of every handshake tolerate extra keys.
 */

export const APP_NAME = 'Memes Arcade';
export const APP_VERSION = '1.0.0';

/** Bumped for any breaking change to REST shapes or WS message semantics. */
export const API_VERSION = 3;
/**
 * Lowest *client build* this server still serves.  Client builds follow
 * APP_VERSION (1.0.0 = the first shipped web/desktop/bot build), so this only
 * ever moves when an older build would genuinely misbehave - never merely to
 * drop users.  Old-but-supported clients get a `degraded` list instead.
 */
export const MIN_CLIENT_VERSION = '1.0.0';
/** Server builds older than this floor are reported as "too old" by clients. */
export const MIN_SERVER_VERSION = '1.0.0';

export const CLIENT_KINDS = ['web', 'desktop', 'bot'];

/**
 * Capability flags.  A capability is an opt-in feature envelope: the server
 * only sends cap-gated data to clients that advertised it.
 */
export const CAPABILITIES = [
  'chat', // realtime chat channels
  'dm', // direct messages
  'friends', // friend graph + presence
  'parties', // party/lobby grouping
  'lobby', // public lobby browser
  'spectate', // watch an in-progress game room
  'bots', // server-side bot players
  'drawing', // canvas/drawing games (large WS payloads)
  'music', // background music engine
  'themes', // theme selection
  'keybinds', // rebindable controls
  'admin', // admin console endpoints
  'replays', // game action logs
  'assets-custom', // custom character art
];

export const DEFAULT_CAPS = CAPABILITIES.slice();

/** Compare dotted numeric versions. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Major number of an API version string ("3.1" -> 3). */
export function apiMajor(v) {
  return parseInt(String(v ?? '0').split('.')[0], 10) || 0;
}

/**
 * Normalise whatever a client sent (header, query param, or WS hello) into a
 * predictable descriptor.  Never throws: garbage input becomes kind "web"
 * with version "0.0.0" so the server can answer with a helpful 426.
 */
export function normalizeClient(input = {}) {
  const kind = CLIENT_KINDS.includes(input.kind) ? input.kind : 'web';
  const version = /^\d+(\.\d+)*$/.test(String(input.version ?? '')) ? String(input.version) : '0.0.0';
  const caps = Array.isArray(input.caps)
    ? input.caps.filter((c) => CAPABILITIES.includes(c))
    : typeof input.caps === 'string'
      ? input.caps.split(',').map((s) => s.trim()).filter((c) => CAPABILITIES.includes(c))
      : DEFAULT_CAPS.slice();
  return { kind, version, caps: [...new Set(caps)], api: input.api ?? null, platform: input.platform ?? 'unknown' };
}

/**
 * Decide whether a client may proceed.
 * -> { ok, code, status, message, client, caps, degraded }
 */
export function negotiate(input, { requiredApi = API_VERSION, minClient = MIN_CLIENT_VERSION } = {}) {
  const client = normalizeClient(input);

  if (apiMajor(client.version) === 0 && client.version === '0.0.0' && !input.allowUnknown) {
    // Unknown clients are still allowed: they are treated as maximally old
    // *only* for capability purposes, and asked to upgrade for API features.
    return {
      ok: true,
      code: 'assumed-legacy',
      status: 200,
      client,
      caps: [],
      degraded: ['unidentified-client'],
      message: `Unidentified client served in legacy mode against API v${requiredApi}.`,
    };
  }

  if (compareVersions(client.version, minClient) < 0) {
    return {
      ok: false,
      code: 'client-too-old',
      status: 426,
      client,
      caps: [],
      degraded: [],
      message:
        `Memes Arcade client ${client.version} is too old for this server ` +
        `(needs ${minClient} or newer, API v${requiredApi}). Update the web page, ` +
        `desktop app, or bot and retry - your account and saves are untouched.`,
    };
  }

  const degraded = [];
  if (apiMajor(client.api ?? client.version) < requiredApi) degraded.push(`api-v${apiMajor(client.api ?? client.version)}-shapes`);

  return {
    ok: true,
    code: 'ok',
    status: 200,
    client,
    caps: client.caps,
    degraded,
    message: `${APP_NAME} API v${requiredApi} serving ${client.kind} ${client.version}`,
  };
}

/** True when the server must send cap-gated data to this client. */
export function hasCap(client, cap) {
  if (!client) return false;
  const caps = Array.isArray(client.caps) ? client.caps : DEFAULT_CAPS;
  return caps.includes(cap);
}

/** Public handshake payload every client can render. */
export function metaPayload(extra = {}) {
  return {
    app: APP_NAME,
    appVersion: APP_VERSION,
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    minServerVersion: MIN_SERVER_VERSION,
    capabilities: CAPABILITIES,
    clientKinds: CLIENT_KINDS,
    ...extra,
  };
}
