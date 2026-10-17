/**
 * Minimal Discord client: REST for command registration and replies, plus a
 * gateway connection for interaction events. No dependencies - it uses the
 * global fetch and WebSocket that Node 22+ provides.
 *
 * Everything here is deliberately small: the bot only needs IDENTIFY, a
 * heartbeat, RESUME after a blip, and INTERACTION_CREATE dispatches.
 */
const DEFAULT_API = 'https://discord.com/api/v10';

/**
 * The gateway intents this bot needs.  GUILDS is all slash commands require.
 * GUILD_MESSAGES and DIRECT_MESSAGES carry the `!memearcade` text fallback, and
 * MESSAGE_CONTENT is what makes a guild message's text readable at all - it is
 * privileged, so an operator has to tick it in the Developer Portal.  Without
 * it the bot falls back to SAFE_INTENTS (see the 4014 handling below) instead
 * of going offline: DMs still carry their text, and slash commands are
 * untouched.
 */
export const INTENT_BITS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
};
export const SAFE_INTENTS = INTENT_BITS.GUILDS | INTENT_BITS.GUILD_MESSAGES | INTENT_BITS.DIRECT_MESSAGES;
export const FULL_INTENTS = SAFE_INTENTS | INTENT_BITS.MESSAGE_CONTENT;

export class DiscordRest {
  constructor({ token, base = DEFAULT_API, fetchImpl = fetch }) {
    this.token = token;
    this.base = String(base).replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, body, { auth = true, retries = 1 } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bot ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && retries > 0) {
      let wait = 1;
      try {
        wait = Number((await res.json())?.retry_after) || 1;
      } catch {}
      await new Promise((r) => setTimeout(r, Math.min(wait * 1000, 5000)));
      return this.request(method, path, body, { auth, retries: retries - 1 });
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
      const message = payload?.message || `Discord API ${res.status} on ${method} ${path}`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  me() {
    return this.request('GET', '/users/@me');
  }

  gateway() {
    return this.request('GET', '/gateway/bot');
  }

  /** Global commands; Discord may take up to an hour to roll them out. */
  putGlobalCommands(commands) {
    return this.request('PUT', `/applications/${this.applicationId}/commands`, commands);
  }

  /** Guild commands appear instantly, which is what you want while developing. */
  putGuildCommands(guildId, commands) {
    return this.request('PUT', `/applications/${this.applicationId}/guilds/${guildId}/commands`, commands);
  }

  /** First response to an interaction (type 4 = message, 5 = deferred message, 8 = autocomplete results). */
  interactionCallback(id, token, data) {
    return this.request('POST', `/interactions/${id}/${token}/callback`, data, { auth: false });
  }

  /** Edit the deferred reply once the work is done. */
  editOriginal(interactionToken, data) {
    return this.request('PATCH', `/webhooks/${this.applicationId}/${interactionToken}/messages/@original`, data, { auth: false });
  }

  /** Post a message in a channel - the reply path for text commands. */
  createMessage(channelId, data) {
    return this.request('POST', `/channels/${channelId}/messages`, data);
  }

  /** Open (or reuse) the DM channel with a user, so a private reply stays private. */
  createDmChannel(userId) {
    return this.request('POST', '/users/@me/channels', { recipient_id: userId });
  }

  /**
   * The servers this bot is a member of (/users/@me/guilds). This is how the
   * console learns the list: only the bot holds the Discord token.
   */
  guilds() {
    return this.request('GET', '/users/@me/guilds');
  }

  /** One guild's channels - enough to say how many places the bot could speak. */
  guildChannels(guildId) {
    return this.request('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
  }
}

/** Discord gateway close codes worth explaining in the logs. */
const FATAL_CODES = {
  4004: 'the bot token was rejected - check DISCORD_TOKEN',
  4010: 'invalid shard configuration',
  4013: 'invalid intents',
  4014: 'a required intent is not enabled for this application',
};

export class DiscordGateway {
  /**
   * @param {object} opts
   * @param {string} opts.token       bot token
   * @param {() => Promise<string>} opts.gatewayUrl  resolves the ws url
   * @param {(type: string, data: object) => void} opts.onDispatch
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.intents]  gateway intent bitmask (default: no privileged intents)
   */
  constructor({ token, gatewayUrl, onDispatch, log = () => {}, intents = SAFE_INTENTS }) {
    this.token = token;
    this.intents = intents;
    this.gatewayUrl = gatewayUrl;
    this.onDispatch = onDispatch;
    this.log = log;
    this.socket = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.heartbeatTimer = null;
    this.heartbeatAcked = true;
    this.delay = 1000;
    this.stopped = false;
    this.ready = false;
    /** Set when Discord rejects us for good (bad token, bad intents). */
    this.fatal = null;
  }

  start() {
    this.stopped = false;
    return this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    try {
      this.socket?.close(1000, 'bot shutting down');
    } catch {}
  }

  async connect({ resume = false } = {}) {
    if (this.stopped) return;
    let url;
    try {
      url = resume && this.resumeUrl ? this.resumeUrl : await this.gatewayUrl();
    } catch (err) {
      this.log(`gateway lookup failed: ${err.message}`);
      return this.retry();
    }
    const sep = url.includes('?') ? '&' : '?';
    const target = `${url}${sep}v=10&encoding=json`;
    let socket;
    try {
      socket = new WebSocket(target);
    } catch (err) {
      this.log(`gateway socket failed: ${err.message}`);
      return this.retry();
    }
    this.socket = socket;

    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    socket.onerror = () => {};
    socket.onclose = (ev) => {
      clearInterval(this.heartbeatTimer);
      if (this.stopped) return;
      // 4014 means Discord refused the intent mask.  The only privileged bit we
      // ask for is Message Content, so drop it and reconnect: slash commands and
      // DMs keep working, and the log says what the owner has to tick.
      if (ev.code === 4014 && (this.intents & INTENT_BITS.MESSAGE_CONTENT)) {
        this.intents &= ~INTENT_BITS.MESSAGE_CONTENT;
        this.log('Discord refused the Message Content intent - reconnecting without it. !memearcade still works in DMs; enable "Message Content Intent" in the Developer Portal to use it in servers.');
        this.retry();
        return;
      }
      const fatal = FATAL_CODES[ev.code];
      if (fatal) {
        this.fatal = fatal;
        this.log(`gateway closed (${ev.code}): ${fatal}`);
        return;
      }
      this.log(`gateway closed (${ev.code || 'no code'}), reconnecting`);
      this.retry();
    };
  }

  retry() {
    if (this.stopped) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 1.7, 30000);
    setTimeout(() => this.connect({ resume: !!this.sessionId }), wait);
  }

  handle(msg) {
    const { op, d, t, s } = msg;
    if (s !== null && s !== undefined) this.seq = s;
    switch (op) {
      case 10: // HELLO - start heartbeating, then identify or resume
        this.heartbeatAcked = true;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), d.heartbeat_interval);
        setTimeout(() => this.heartbeat(), Math.floor(d.heartbeat_interval * Math.random()));
        if (this.sessionId) this.resume();
        else this.identify();
        return;
      case 11: // heartbeat acked
        this.heartbeatAcked = true;
        return;
      case 1: // the server wants a heartbeat right now
        this.heartbeat();
        return;
      case 7: // reconnect
        this.log('gateway asked us to reconnect');
        this.socket?.close(4000, 'reconnect');
        return;
      case 9: { // invalid session
        this.sessionId = null;
        this.resumeUrl = null;
        this.log('gateway session invalid, identifying again');
        setTimeout(() => this.identify(), 1200);
        return;
      }
      case 0:
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url || this.resumeUrl;
          this.delay = 1000;
          this.ready = true;
          this.log(`gateway ready as ${d.user?.username}#${d.user?.discriminator ?? ''}`.replace(/#$/, ''));
        } else if (t === 'RESUMED') {
          this.log('gateway session resumed');
          this.ready = true;
        }
        try {
          this.onDispatch(t, d);
        } catch (err) {
          this.log(`dispatch ${t} failed: ${err.message}`);
        }
        return;
      default:
        return;
    }
  }

  heartbeat() {
    if (!this.heartbeatAcked) {
      this.log('gateway heartbeat missed, reconnecting');
      this.socket?.close(4001, 'heartbeat failed');
      return;
    }
    this.heartbeatAcked = false;
    this.send({ op: 1, d: this.seq });
  }

  identify() {
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: process.platform, browser: 'memes-arcade-bot', device: 'memes-arcade-bot' },
      },
    });
  }

  resume() {
    this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
  }

  send(payload) {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (err) {
      this.log(`gateway send failed: ${err.message}`);
    }
  }
}
