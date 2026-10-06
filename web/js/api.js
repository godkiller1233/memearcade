/**
 * REST client.  Sends the client version + capabilities on every call so the
 * server can negotiate compatibility (see shared/version.js).
 */
import { CLIENT_KIND, CLIENT_VERSION, API_VERSION, state, setMe } from './store.js';

export const CAPS = [
  'chat', 'dm', 'friends', 'parties', 'lobby', 'spectate', 'bots', 'drawing',
  'music', 'themes', 'keybinds', 'admin', 'replays', 'assets-custom',
];

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload || {};
  }
}

export function isSignedIn() {
  return !!state.token;
}

function headers(extra = {}) {
  const h = {
    'x-client': CLIENT_KIND,
    'x-client-version': CLIENT_VERSION,
    // Without this the server assumes the oldest API shapes and flags the
    // client as degraded ("api-v1-shapes") even when it is a perfect match.
    'x-api-version': String(API_VERSION),
    'x-client-caps': CAPS.join(','),
    ...extra,
  };
  if (state.token) h.authorization = `Bearer ${state.token}`;
  return h;
}

async function request(method, path, body, { raw = false } = {}) {
  const opts = { method, headers: headers(), credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    throw new ApiError(0, 'Cannot reach the arcade server. Is it running?', { offline: true });
  }
  if (raw) return res;
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const message = payload?.message || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, payload);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
  request,
};

/** Boot handshake: also the compatibility check. */
export async function fetchMeta() {
  const meta = await request('GET', '/api/meta');
  state.server = meta;
  state.client = { kind: CLIENT_KIND, version: CLIENT_VERSION, caps: CAPS };
  state.degraded = meta.degraded || [];
  return meta;
}

export async function restoreSession() {
  if (!state.token) return null;
  try {
    const res = await api.get('/api/auth/me');
    if (res.user) return setMe(res.user);
    state.token = null;
  } catch (err) {
    if (err.status === 401) state.token = null;
    else throw err;
  }
  return null;
}

export async function login(name, password) {
  const res = await api.post('/api/auth/login', { name, password });
  state.token = res.token;
  return setMe(res.user);
}

export async function register(name, password) {
  const res = await api.post('/api/auth/register', { name, password });
  state.token = res.token;
  return setMe(res.user);
}

export async function guest() {
  const res = await api.post('/api/auth/guest', {});
  state.token = res.token;
  return setMe(res.user);
}

export async function logout() {
  try {
    await api.post('/api/auth/logout', {});
  } catch {}
  state.token = null;
  state.me = null;
}

export async function loadCatalog() {
  const res = await api.get('/api/games');
  state.catalog = res.games || [];
  state.categories = res.categories || [];
  return res;
}
