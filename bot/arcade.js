/**
 * Arcade API client for the Discord bot.
 *
 * Every call carries the shared bot secret (X-Bot-Token). Player-bound calls -
 * posting an idea, voting, /api/bot/user - also carry the linked account's
 * session token as Authorization, which the server hands the bot through the
 * /api/bot/link/* flow.
 */
export class ArcadeError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = 'ArcadeError';
    this.status = status;
    this.payload = payload;
  }
}

export class Arcade {
  constructor({ url, botToken }) {
    this.url = String(url || 'http://127.0.0.1:8787').replace(/\/$/, '');
    this.botToken = botToken;
  }

  async request(method, path, { body, userToken, timeoutMs } = {}) {
    const headers = { 'x-bot-token': this.botToken, 'x-client': 'discord-bot', 'x-client-version': '1.0.0' };
    if (userToken) headers.authorization = `Bearer ${userToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Only autocomplete needs a deadline: Discord gives it 3s and rejects a
        // late answer outright, whereas a deferred command reply can wait.
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      throw new ArcadeError(`The arcade server is unreachable (${err.message}).`, { status: 0 });
    }
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      throw new ArcadeError(payload?.message || `Arcade request failed (${res.status}).`, { status: res.status, payload });
    }
    return payload;
  }

  health() {
    return this.request('GET', '/api/health');
  }

  /** Public board read - the same shape the website uses. */
  suggestions({ sort = 'top', status = 'all', category = 'all' } = {}) {
    const q = new URLSearchParams({ sort, status, category });
    return this.request('GET', `/api/suggestions?${q}`);
  }

  /** Ideas that shipped, newest first (/api/changelog) - the site's changelog page. */
  changelog() {
    return this.request('GET', '/api/changelog');
  }

  /** Public player directory - the ranking data behind /leaderboard. */
  players({ sort = 'level', limit = 10, q = '' } = {}) {
    const params = new URLSearchParams({ sort, limit: String(limit) });
    if (q) params.set('q', q);
    return this.request('GET', `/api/users?${params}`);
  }

  /** Public profile of any player, by name or id (/api/users/:id). */
  user(nameOrId) {
    return this.request('GET', `/api/users/${encodeURIComponent(nameOrId)}`);
  }

  /** Public game catalog (/api/games) - turns game ids into display names. */
  catalog({ timeoutMs } = {}) {
    return this.request('GET', '/api/games', { timeoutMs });
  }

  /** Per-game ranking (/api/leaderboard?game=<id>) - top players of one game. */
  gameLeaderboard(gameId) {
    return this.request('GET', `/api/leaderboard?game=${encodeURIComponent(gameId)}`);
  }

  createSuggestion({ title, text, category }, userToken) {
    return this.request('POST', '/api/suggestions', { body: { title, text, category }, userToken });
  }

  vote(id, userToken) {
    return this.request('POST', `/api/suggestions/${encodeURIComponent(id)}/vote`, { body: {}, userToken });
  }

  /** Bot bridge: opens (or reuses) the link to a Discord user, returning a code or a token. */
  linkStart(discordId, discordName) {
    return this.request('POST', '/api/bot/link/start', { body: { discordId, discordName } });
  }

  linkCheck(code) {
    return this.request('POST', '/api/bot/link/check', { body: { code } });
  }

  botUser(userToken) {
    return this.request('GET', '/api/bot/user', { userToken });
  }
}
