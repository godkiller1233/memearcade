/**
 * Realtime hub.  One WebSocket per client, JSON messages both ways, and every
 * message type is handled defensively: unknown types are ignored so that a
 * newer client can talk to an older server (and vice versa) without breaking.
 */
import { attachWebSocket } from './lib/ws.js';

import { db } from './lib/db.js';
import { sessionUser } from './lib/auth.js';
import { getEngine, engineCatalog } from './games.js';
import { catalogWithEngines } from '../web/games/registry.js';
import { featureAllowed, featureRefusal, gameAllowed, gameRefusal } from '../shared/features.js';
import { publicConfig, catalogFor } from './lib/public-config.js';
import {
  acceptFriend,
  appendMessage,
  appendPartyChat,
  blockUser,
  clearPartyRejoin,
  createParty,
  dmConversations,
  dmHistory,
  friendIds,
  friendList,
  friendState,
  getParty,
  getPartyByCode,
  getUser,
  getUserByName,
  joinParty,
  leaveParty,
  partiesOf,
  partyOf,
  partyPublic,
  partyRejoinFor,
  rememberPartyRejoin,
  rejoinablePartyOf,
  removeFriend,
  requestFriend,
  sanitizeText,
  sendDm,
  updateSettings,
  userPublic,
} from './store.js';
import { addSocket, emitTo, isOnline, onlineCount, removeSocket, setStatus, statusOf } from './lib/presence.js';
import { config, log } from './config.js';
import { metaPayload, negotiate } from '../shared/version.js';
import { now } from './lib/ids.js';

const CHAT_LIMIT = { global: 6, room: 20, party: 20, dm: 30 };

export class RealtimeHub {
  constructor({ rooms }) {
    this.rooms = rooms;
    this.clients = new Map(); // conn -> session
    this.partyTimers = new Map(); // userId -> pending party cleanup
    this.roomTimers = new Map(); // userId -> pending room-seat cleanup
    this.partyGraceMs = Math.max(0, config.partyGraceMs);
    this.roomGraceMs = Math.max(0, config.roomGraceMs);
    this.closing = false;
    rooms.hub = this;
    this.startedAt = now();
  }

  attach(server) {
    this.ws = attachWebSocket(server, {
      path: '/ws',
      maxPayload: config.maxWsMessage,
      onConnection: (conn) => this.onConnect(conn),
    });
    log('realtime: websocket hub listening on /ws');
    return this.ws;
  }

  /* ---------------------------------------------------------------- *
   * Connection lifecycle
   * ---------------------------------------------------------------- */

  onConnect(conn) {
    const session = {
      conn,
      user: null,
      client: { kind: 'web', version: '0.0.0', caps: [], api: null },
      partyId: null,
      roomId: null,
      scope: 'global',
      watchingSuggestions: false,
      lastChat: {},
      connectedAt: now(),
    };
    this.clients.set(conn, session);

    conn.on('message', (raw) => this.onMessage(session, raw));
    conn.on('close', () => this.onClose(session));

    conn.send({
      t: 'hello',
      server: true,
      ...metaPayload({
        serverTime: now(),
        online: onlineCount(),
        requiresAuth: true,
        features: {
          discordBot: config.discord.enabled,
          desktop: true,
          maxRooms: db.data.config.maxRooms,
          maxPartySize: db.data.config.maxPartySize,
        },
        catalog: catalogWithEngines(engineCatalog()),
      }),
    });

    // Allow token-in-query handshakes (handy for bots/desktop).
    const qToken = conn.query?.get('token');
    if (qToken) this.identify(session, qToken);
  }

  onClose(session) {
    if (session.user) {
      const remaining = removeSocket(session.user.id, session.conn);
      if (remaining === 0) {
        this.notifyFriends(session.user.id, { t: 'presence', userId: session.user.id, status: 'offline' });
        this.scheduleRoomLeave(session.user.id);
        if (session.partyId) this.schedulePartyLeave(session.user.id);
      }
    }
    this.clients.delete(session.conn);
  }

  /**
   * A dropped member keeps their room seat (or viewer spot) for a short grace
   * window - a refresh or a network blip must not eject anyone. The seat is
   * marked disconnected at once so the room shows them offline; anyone still
   * gone when the window closes is removed like an explicit leave. A live
   * match migrates hosting inside removePlayer, which hands the new host the
   * authoritative state, so the room keeps streaming after the handover.  A
   * dropped host additionally starts the room's outage countdown, so the wait
   * is announced whatever the room status is.
   */
  scheduleRoomLeave(userId) {
    if (this.closing) return;
    this.clearRoomLeave(userId);
    const room = this.roomOf(userId);
    if (!room) return;
    const seat = room.players.find((p) => p.id === userId);
    if (seat) seat.connected = false;
    // A dropped host freezes a host-authoritative match until the handover, and
    // only a host can start a rematch.  Tell the room who takes over and when,
    // so every client can count the wait down instead of staring at a stall.
    if (seat && room.host === userId && !room.hostOutageUntil) {
      room.hostOutageUntil = now() + this.roomGraceMs;
      const next = this.rooms.hostOutage(room)?.nextName;
      const seconds = Math.max(1, Math.round(this.roomGraceMs / 1000));
      this.rooms.systemMessage(room, next
        ? `${seat.name} lost connection - ${next} takes over in ${seconds}s unless the host reconnects.`
        : `${seat.name} lost connection - the room closes in ${seconds}s unless the host reconnects.`);
    }
    // A seated member's chip must grey out the moment the socket drops - in the
    // lobby and mid-match alike - so any seat drop rebroadcasts.  (A pending
    // host outage refreshes here too, since the announced successor can change.)
    if (seat || room.status === 'lobby') this.rooms.touch(room);
    const timer = setTimeout(() => {
      this.roomTimers.delete(userId);
      if (isOnline(userId)) return; // reconnected inside the window
      this.dropFromRoom(userId);
    }, this.roomGraceMs);
    timer.unref?.();
    this.roomTimers.set(userId, timer);
  }

  clearRoomLeave(userId) {
    const timer = this.roomTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.roomTimers.delete(userId);
    }
  }

  /** The room a user is in right now - seated or watching. */
  roomOf(userId) {
    return [...this.rooms.rooms.values()].find((r) => r.players.some((p) => p.id === userId) || r.spectators.some((s) => s.id === userId)) || null;
  }

  /** Drops an offline member from their room; the room notices and rebroadcasts. */
  dropFromRoom(userId) {
    const room = this.roomOf(userId);
    if (!room) return false;
    if (room.players.some((p) => p.id === userId)) {
      this.rooms.removePlayer(room, userId, { reason: 'lost connection' });
    } else {
      room.spectators = room.spectators.filter((s) => s.id !== userId);
      this.rooms.touch(room);
    }
    log(`realtime: ${getUser(userId)?.name || userId} left room ${room.code} after the grace window`);
    return true;
  }

  /**
   * A dropped party member keeps their seat for a short grace window - a page
   * refresh or a network blip must not eject them. Everyone else sees their
   * dot flip offline right away, and if they are still gone when the window
   * closes they are removed so the sidebar never keeps a ghost.
   */
  schedulePartyLeave(userId) {
    if (this.closing) return;
    this.clearPartyLeave(userId);
    const party = partyOf(userId);
    if (!party) return;
    this.broadcastParty(party);
    const timer = setTimeout(() => {
      this.partyTimers.delete(userId);
      if (isOnline(userId)) return; // reconnected inside the window
      const current = partyOf(userId);
      if (!current) return;
      const member = current.members.find((m) => m.id === userId);
      const remaining = leaveParty(current, userId);
      // The seat is gone but the party is not: leave a rejoin ticket so a
      // returning client is offered the party back (see rejoinablePartyOf).
      if (remaining) rememberPartyRejoin(remaining, userId, member?.name);
      // The member showed offline for the whole window; say why they are gone
      // now, so the rest of the party sees a departure instead of a vanish.
      if (remaining) this.systemParty(remaining, `${member?.name || 'A member'} lost connection and left the party.`);
      this.broadcastParty(current);
    }, this.partyGraceMs);
    timer.unref?.();
    this.partyTimers.set(userId, timer);
  }

  clearPartyLeave(userId) {
    const timer = this.partyTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.partyTimers.delete(userId);
    }
  }

  /**
   * Post-identification handshake.  Re-sent (only when the picture changed)
   * when a client's `hello` arrives after a token-in-query identify: that way
   * a client which announced its real version late is never left with the
   * earlier "unidentified-client" note.
   */
  sendWelcome(session, { onlyIfChanged = false } = {}) {
    const negotiated = negotiate(
      {
        kind: session.client.kind,
        version: session.client.version,
        caps: session.client.caps,
        api: session.client.api ?? null,
      },
      { allowUnknown: true },
    );
    const changed = (session.degraded || []).join(',') !== negotiated.degraded.join(',');
    session.client = negotiated.client;
    session.degraded = negotiated.degraded;
    if (onlyIfChanged && !changed) return negotiated;
    session.conn.send({
      t: 'welcome',
      ...metaPayload({
        serverTime: now(),
        client: negotiated.client,
        degraded: negotiated.degraded,
        online: onlineCount(),
        features: { discordBot: config.discord.enabled, desktop: true },
        catalog: catalogFor(session.user),
        config: publicConfig(session.user),
      }),
    });
    return negotiated;
  }

  identify(session, token) {
    const found = sessionUser(token);
    if (!found) {
      session.conn.send({ t: 'error', code: 'auth', message: 'That session expired. Please sign in again.' });
      return false;
    }
    const { user } = found;
    if (db.data.config.maintenance && !(user.role === 'admin' || user.role === 'owner' || user.role === 'mod')) {
      session.conn.send({ t: 'maintenance', message: 'Memes Arcade is in maintenance mode. Admins can still connect.' });
      session.conn.close(4013, 'maintenance');
      return false;
    }
    if (user.banned) {
      session.conn.send({
        t: 'banned',
        message: user.banned.reason || 'Your account is suspended.',
        until: user.banned.until,
      });
      session.conn.close(4003, 'banned');
      return false;
    }
    session.user = user;
    session.token = token;
    user.lastSeen = now();
    addSocket(user.id, session.conn);
    setStatus(user.id, user.settings?.privacy?.presence || 'online');

    // re-attach to an existing party / room so refreshes are seamless; coming
    // back also cancels any pending disconnect cleanup, keeping the seat
    const wasPendingLeave = this.partyTimers.has(user.id);
    this.clearPartyLeave(user.id);
    const party = partyOf(user.id);
    if (party) {
      session.partyId = party.id;
      if (wasPendingLeave) this.broadcastParty(party);
    }
    const wasPendingRoomLeave = this.roomTimers.has(user.id);
    this.clearRoomLeave(user.id);
    const room = this.roomOf(user.id);
    if (room) {
      session.roomId = room.id;
      const seat = room.players.find((p) => p.id === user.id);
      if (seat) seat.connected = true;
      // The host made it back inside the grace window: withdraw the countdown.
      const hostBack = !!room.hostOutageUntil && room.host === user.id;
      if (hostBack) room.hostOutageUntil = 0;
      // A returning seat loses its ghost too, so rebroadcast wherever it sits.
      if (wasPendingRoomLeave && (room.status === 'lobby' || hostBack || seat)) this.rooms.touch(room); // the dot is green again
    }

    this.sendWelcome(session);
    this.conn(session).send({ t: 'me', user: userPublic(user, { self: true }) });
    this.pushFriends(session);
    this.pushParty(session);
    // A member whose seat the grace reclaimed is offered the party back - one
    // click, no code to remember (the client shows the Rejoin party button).
    if (!session.partyId) {
      const back = rejoinablePartyOf(user.id);
      if (back) this.notify(user.id, 'party-rejoin', `Party ${back.code} is still going - jump back in.`, { code: back.code, party: partyPublic(back) });
    }
    this.pushRoom(session);
    this.conn(session).send({ t: 'dm:list', conversations: dmConversations(user.id) });
    this.notifyFriends(user.id, { t: 'presence', userId: user.id, status: statusOf(user.id), user: userPublic(user) });
    log(`realtime: ${user.name} connected (${onlineCount()} online)`);
    db.data.stats.peakOnline = Math.max(db.data.stats.peakOnline || 0, onlineCount());
    db.touch();
    return true;
  }

  conn(session) {
    return session.conn;
  }

  /* ---------------------------------------------------------------- *
   * Sending helpers
   * ---------------------------------------------------------------- */

  sendToUser(userId, message) {
    return emitTo([userId], message);
  }

  sendToUsers(userIds, message) {
    return emitTo([...new Set(userIds)], message);
  }

  notify(userId, kind, text, meta = {}) {
    this.sendToUser(userId, { t: 'notify', kind, text, at: now(), ...meta });
  }

  notifyFriends(userId, message) {
    const ids = friendIds(userId);
    if (ids.length) this.sendToUsers(ids, message);
  }

  broadcastLobby() {
    const payload = { t: 'lobby', rooms: this.rooms.lobbyList(), stats: this.rooms.stats(), statsGlobal: this.lobbyStats() };
    for (const session of this.clients.values()) {
      if (session.user && session.scope === 'lobby') session.conn.send(payload);
    }
  }

  /** Tell everyone currently looking at the idea board that it changed. The
   *  board is public, so guests get the ping too. */
  broadcastSuggestions() {
    for (const session of this.clients.values()) {
      if (session.watchingSuggestions) session.conn.send({ t: 'suggestions:changed' });
    }
  }

  /**
   * Push the site config to everyone connected - an admin just changed the
   * announcement, a feature switch or a game's visibility, and every player
   * should see it without reloading.  Each session gets the catalog it is
   * allowed to see, so a hidden game disappears from open tabs too.
   */
  broadcastConfig() {
    for (const session of this.clients.values()) {
      // Both halves are per-viewer: a session that has not identified yet gets
      // the strict guest view (and the guest catalog), and a staff or VIP
      // session gets its own the moment it signs in.
      session.conn.send({
        t: 'config',
        config: publicConfig(session.user),
        catalog: catalogFor(session.user),
      });
    }
  }

  lobbyStats() {
    return {
      online: onlineCount(),
      registered: Object.keys(db.data.users).length,
      gamesPlayed: db.data.stats.gamesPlayed,
      peakOnline: db.data.stats.peakOnline || 0,
    };
  }

  pushFriends(session) {
    if (!session.user) return;
    const list = friendList(session.user.id);
    session.conn.send({ t: 'friends', list });
  }

  pushParty(session) {
    if (!session.user) return;
    const party = session.partyId ? getParty(session.partyId) : null;
    if (!party) {
      session.partyId = null;
      session.conn.send({ t: 'party', party: null });
      return;
    }
    session.conn.send({ t: 'party', party: partyPublic(party, { includeChat: true }) });
  }

  pushRoom(session) {
    if (!session.user || !session.roomId) return;
    const room = this.rooms.getRoom(session.roomId);
    if (!room) {
      session.roomId = null;
      session.conn.send({ t: 'room:closed', reason: 'gone' });
      return;
    }
    session.conn.send({
      t: 'game',
      room: this.rooms.roomInfo(room),
      view: this.rooms.view(room, session.user.id),
      messages: room.messages.slice(-40),
      spectating: room.spectators.some((s) => s.id === session.user.id),
    });
    // A realtime room lives on its host: after a reconnect (or a reload) the
    // host gets the current world back so it can keep simulating.
    if (room.status === 'playing' && room.engine.meta.realtime && room.host === session.user.id && room.state) {
      session.conn.send({ t: 'room:state', roomId: room.id, state: room.state });
    }
  }

  /* ---------------------------------------------------------------- *
   * Inbound messages
   * ---------------------------------------------------------------- */

  onMessage(session, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return session.conn.send({ t: 'error', code: 'parse', message: 'Malformed message.' });
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    try {
      this.route(session, msg);
    } catch (err) {
      session.conn.send({ t: 'error', code: err?.code || 'handler', message: err?.message || 'Something went wrong.' });
      if (!err.expected) log(`realtime: handler error (${msg.t}):`, err?.stack || err);
    }
  }

  route(session, msg) {
    switch (msg.t) {
      case 'hello':
      case 'identify': {
        session.client = {
          kind: msg.kind || session.client.kind,
          version: msg.v || session.client.version,
          caps: Array.isArray(msg.caps) ? msg.caps : session.client.caps,
          api: msg.api ?? session.client.api ?? null,
        };
        if (session.user) {
          // A token-in-query client is identified before its hello arrives:
          // re-negotiate so its real version/caps replace the early guess.
          this.sendWelcome(session, { onlyIfChanged: true });
          return;
        }
        const tok = msg.token || msg.session;
        if (tok) this.identify(session, tok);
        return;
      }
      case 'resume': {
        if (!session.user && msg.token) this.identify(session, msg.token);
        return;
      }
      case 'ping':
        return session.conn.send({ t: 'pong', ts: msg.ts ?? now(), serverTime: now() });
      case 'presence': {
        this.requireAuth(session);
        setStatus(session.user.id, msg.status);
        if (msg.status === 'invisible') session.user.settings.privacy.presence = 'invisible';
        else if (session.user.settings.privacy.presence === 'invisible') session.user.settings.privacy.presence = 'online';
        db.touch();
        this.notifyFriends(session.user.id, { t: 'presence', userId: session.user.id, status: statusOf(session.user.id) });
        return session.conn.send({ t: 'me', user: userPublic(session.user, { self: true }) });
      }
      case 'settings':
        return this.handleSettings(session, msg);
      case 'friend':
        this.requireFeature(session, 'friends');
        return this.handleFriend(session, msg);
      case 'party':
        // Leaving a party always works: a switch flipped mid-party must not
        // strand its members in something they can no longer exit.
        if (msg.op !== 'leave') this.requireFeature(session, 'parties');
        return this.handleParty(session, msg);
      case 'room':
        return this.handleRoom(session, msg);
      case 'game':
        return this.handleGame(session, msg);
      case 'tick':
        return this.handleTick(session, msg);
      case 'chat':
        this.requireFeature(session, 'chat');
        return this.handleChat(session, msg);
      case 'typing':
        this.requireFeature(session, 'chat');
        return this.handleTyping(session, msg);
      case 'lobby':
        this.requireFeature(session, 'lobby');
        session.scope = 'lobby';
        return session.conn.send({ t: 'lobby', rooms: this.rooms.lobbyList(), stats: this.rooms.stats(), statsGlobal: this.lobbyStats() });
      case 'leave-lobby':
        session.scope = session.partyId ? 'party' : 'global';
        return;
      case 'suggestions':
        // Just marks the interest (kept separate from the lobby scope): clients
        // read the board over REST and only need the pings below to know when
        // someone else changed it. Un-watching is always allowed.
        if (msg.watching !== false) this.requireFeature(session, 'suggestions');
        session.watchingSuggestions = msg.watching !== false;
        return session.conn.send({ t: 'suggestions', watching: session.watchingSuggestions });
      default:
        return; // unknown message types are ignored (forward compatibility)
    }
  }

  /**
   * Refuse a feature an owner switched off or hid from this socket.  A caller
   * at or above the keep-floor keeps access (staff by default, so the person who
   * turned it off can turn it back on), and a socket that has not identified yet
   * passes through so it still hears the usual "sign in first" from the handler
   * rather than a feature notice.
   */
  requireFeature(session, id) {
    if (!session.user || featureAllowed(db.data.config, id, { role: session.user.role })) return true;
    const err = new Error(featureRefusal(db.data.config, id));
    err.code = 'feature-off';
    err.expected = true;
    throw err;
  }

  requireAuth(session) {
    if (!session.user) {
      const err = new Error('Sign in first.');
      err.expected = true;
      throw err;
    }
  }

  rateCheck(session, scope, limit) {
    const key = `${session.user?.id || session.conn.id}:${scope}`;
    const t = now();
    const last = session.lastChat[key] || 0;
    const windowMs = 2000;
    const allowed = limit * (windowMs / 2000) + 1;
    if (t - last < windowMs / allowed) {
      const err = new Error('Slow down a little.');
      err.expected = true;
      throw err;
    }
    session.lastChat[key] = t;
  }

  /* ---------------- settings ---------------- */

  handleSettings(session, msg) {
    this.requireAuth(session);
    const patch = msg.patch || msg.settings || {};
    const allowed = ['theme', 'accent', 'font', 'reduceMotion', 'cardSize', 'audio', 'keybinds', 'notifications', 'privacy', 'gameplay', 'games'];
    const clean = {};
    for (const key of allowed) if (patch[key] !== undefined) clean[key] = patch[key];
    const settings = updateSettings(session.user, clean);
    session.conn.send({ t: 'settings', settings });
    return { ok: true };
  }

  /* ---------------- friends ---------------- */

  handleFriend(session, msg) {
    this.requireAuth(session);
    const me = session.user;
    const target = msg.userId ? getUser(msg.userId) : msg.name ? getUserByName(msg.name) : null;
    const op = String(msg.op || '');
    if (op === 'list') return this.pushFriends(session);
    if (!target) throw new Error('User not found.');
    switch (op) {
      case 'request': {
        requestFriend(me, target);
        this.notify(target.id, 'friend-request', `${me.name} sent you a friend request.`, { from: userPublic(me) });
        this.pushFriends(session);
        this.sendToUser(target.id, { t: 'friends:refresh' });
        break;
      }
      case 'accept': {
        acceptFriend(me, target);
        this.notify(target.id, 'friend-accept', `${me.name} accepted your friend request.`, { from: userPublic(me) });
        this.pushFriends(session);
        this.sendToUser(target.id, { t: 'friends:refresh' });
        break;
      }
      case 'remove': {
        removeFriend(me, target);
        this.pushFriends(session);
        this.sendToUser(target.id, { t: 'friends:refresh' });
        break;
      }
      case 'block': {
        blockUser(me, target);
        this.pushFriends(session);
        break;
      }
      case 'history': {
        return session.conn.send({ t: 'dm:history', userId: target.id, messages: dmHistory(me, target) });
      }
      default:
        throw new Error(`Unknown friend op "${op}".`);
    }
    return { ok: true };
  }

  /* ---------------- parties ---------------- */

  handleParty(session, msg) {
    this.requireAuth(session);
    const me = session.user;
    const op = String(msg.op || '');
    let party = session.partyId ? getParty(session.partyId) : null;

    if (op === 'create') {
      // Starting a party is a move as well, and the socket's partyId may be
      // stale, so the store decides what there is to leave.
      const dropped = this.moveOutOfOtherParties(me.id, me.name);
      if (dropped.includes(session.roomId)) session.roomId = null;
      party = createParty(me, {
        visibility: msg.visibility === 'private' ? 'private' : 'public',
        gameId: msg.gameId || null,
        options: msg.options || {},
      });
      session.partyId = party.id;
    } else if (op === 'join') {
      const target = msg.code ? getPartyByCode(msg.code) : msg.id ? getParty(msg.id) : null;
      if (!target) throw new Error('Party not found. Check the code.');
      // A member the grace window reclaimed gets a return line, not a welcome.
      const returning = !!partyRejoinFor(target, me.id);
      // Join first so a full party throws before anything moves.
      joinParty(target, me);
      clearPartyRejoin(target, me.id);
      const dropped = this.moveOutOfOtherParties(me.id, me.name, target.id);
      if (dropped.includes(session.roomId)) session.roomId = null;
      party = target;
      session.partyId = party.id;
      this.systemParty(party, returning ? `${me.name} rejoined the party.` : `${me.name} joined the party.`);
    } else if (op === 'leave') {
      if (!party) return { ok: true };
      const existingRoom = party.roomId ? this.rooms.getRoom(party.roomId) : null;
      if (existingRoom) this.rooms.removePlayer(existingRoom, me.id);
      clearPartyRejoin(party, me.id); // a deliberate leave is not a rejoin offer
      leaveParty(party, me.id);
      session.partyId = null;
      session.roomId = null;
      this.broadcastParty(party);
      return session.conn.send({ t: 'party', party: null });
    } else {
      if (!party) throw new Error('You are not in a party.');
      switch (op) {
        case 'invite': {
          const target = msg.userId ? getUser(msg.userId) : getUserByName(msg.name);
          if (!target) throw new Error('User not found.');
          if (!party.invites.includes(target.id)) party.invites.push(target.id);
          db.touch();
          this.notify(target.id, 'party-invite', `${me.name} invited you to a party.`, {
            party: partyPublic(party),
            code: party.code,
          });
          break;
        }
        case 'kick': {
          if (party.leader !== me.id) throw new Error('Only the party leader can do that.');
          const targetId = String(msg.userId);
          const room = party.roomId ? this.rooms.getRoom(party.roomId) : null;
          if (room) this.rooms.removePlayer(room, targetId, { reason: 'was removed from the party' });
          clearPartyRejoin(party, targetId); // a kick is not a rejoin offer
          leaveParty(party, targetId);
          this.notify(targetId, 'party-kick', `You were removed from ${me.name}'s party.`);
          for (const [conn, s] of this.clients) if (s.user?.id === targetId) {
            s.partyId = null;
            s.roomId = null;
            conn.send({ t: 'party', party: null });
          }
          break;
        }
        case 'ready': {
          const member = party.members.find((m) => m.id === me.id);
          if (member) member.ready = msg.ready !== false;
          db.touch();
          break;
        }
        case 'visibility': {
          if (party.leader !== me.id) throw new Error('Only the party leader can change that.');
          party.visibility = msg.visibility === 'private' ? 'private' : 'public';
          db.touch();
          break;
        }
        case 'game': {
          if (party.leader !== me.id) throw new Error('Only the party leader can pick the game.');
          party.gameId = msg.gameId || null;
          party.options = msg.options || party.options || {};
          db.touch();
          break;
        }
        case 'chat': {
          this.requireFeature(session, 'chat');
          this.rateCheck(session, 'party', CHAT_LIMIT.party);
          const message = {
            id: `p${now()}`,
            kind: 'chat',
            from: me.id,
            name: me.name,
            avatar: me.avatar,
            text: sanitizeText(msg.text),
            at: now(),
          };
          if (!message.text) return;
          appendPartyChat(party, message);
          this.emitParty(party, { t: 'chat', scope: `party:${party.id}`, message });
          return { ok: true };
        }
        case 'start': {
          if (party.leader !== me.id) throw new Error('Only the party leader can start the game.');
          const gameId = msg.gameId || party.gameId;
          if (!gameId) throw new Error('No game selected yet.');
          const engine = getEngine(gameId);
          if (!engine) throw new Error(`"${gameId}" is not installed yet.`);
          const room = this.createRoomFor(party, me, gameId, msg.options || party.options || {});
          this.broadcastParty(party);
          for (const member of party.members) {
            for (const [conn, s] of this.clients) if (s.user?.id === member.id) {
              s.roomId = room.id;
              this.pushRoom(s);
            }
          }
          return { ok: true, room: this.rooms.roomInfo(room) };
        }
        default:
          throw new Error(`Unknown party op "${op}".`);
      }
    }
    db.touch();
    this.broadcastParty(party);
    return { ok: true };
  }

  systemParty(party, text) {
    const message = { id: `s${now()}`, kind: 'system', text, at: now() };
    appendPartyChat(party, message);
    this.emitParty(party, { t: 'chat', scope: `party:${party.id}`, message });
  }

  /**
   * A player belongs to exactly one party, so joining or starting one is a move:
   * every other membership the store still holds is left behind.  The socket's
   * own partyId cannot be trusted for this - it goes stale the moment a client
   * reloads or opens an invite link - and trusting it is how a player ended up
   * in two parties at once, with the disconnect grace reclaiming the seat in the
   * wrong one and the party they came from keeping a ghost member forever.
   * Returns the ids of the rooms the player was pulled out of.
   */
  moveOutOfOtherParties(userId, name, keepId = null) {
    const droppedFromRooms = [];
    for (const other of partiesOf(userId)) {
      if (other.id === keepId) continue;
      if (other.roomId) {
        const room = this.rooms.getRoom(other.roomId);
        if (room) {
          this.rooms.removePlayer(room, userId);
          droppedFromRooms.push(other.roomId);
        }
      }
      clearPartyRejoin(other, userId);
      const remaining = leaveParty(other, userId);
      if (!remaining) continue;
      this.systemParty(remaining, `${name} left for another party.`);
      this.broadcastParty(remaining);
    }
    return droppedFromRooms;
  }

  broadcastParty(party) {
    if (!party) return;
    const pub = partyPublic(party, { includeChat: false });
    for (const member of party.members) {
      for (const [conn, s] of this.clients) {
        if (s.user?.id === member.id) {
          s.partyId = party.id;
          conn.send({ t: 'party', party: partyPublic(party, { includeChat: true }) });
        }
      }
    }
  }

  emitParty(party, message) {
    for (const member of party.members) this.sendToUser(member.id, message);
  }

  createRoomFor(party, leader, gameId, options = {}) {
    const room = this.rooms.createRoom({
      gameId,
      host: leader,
      partyId: party.id,
      visibility: party.visibility,
      options,
    });
    for (const member of party.members) {
      if (member.id === leader.id) continue;
      const user = getUser(member.id);
      if (!user) continue;
      try {
        this.rooms.addPlayer(room, user);
      } catch (err) {
        this.notify(member.id, 'party', err.message);
      }
    }
    party.roomId = room.id;
    party.status = 'in-game';
    db.touch();
    return room;
  }

  /* ---------------- rooms ---------------- */

  handleRoom(session, msg) {
    this.requireAuth(session);
    const me = session.user;
    const op = String(msg.op || 'create');
    const current = session.roomId ? this.rooms.getRoom(session.roomId) : null;

    // Turning rooms off stops *entering* a room; leaving, playing on and
    // rematches keep working so a live match is never cut in half.
    if (op === 'create' || op === 'join') this.requireFeature(session, 'rooms');
    if (op === 'spectate') this.requireFeature(session, 'spectate');
    if (op === 'addBot') this.requireFeature(session, 'bots');

    switch (op) {
      case 'create': {
        const engine = getEngine(msg.gameId);
        if (!engine) throw new Error(`"${msg.gameId}" is not playable yet - check the catalog for status.`);
        if (!gameAllowed(db.data.config, engine.meta.id, { role: me.role })) {
          const err = new Error(gameRefusal(db.data.config, engine.meta.id, engine.meta.name));
          err.code = 'feature-off';
          err.expected = true;
          throw err;
        }
        if (current) this.leaveRoom(session, current);
        const room = this.rooms.createRoom({
          gameId: msg.gameId,
          host: me,
          visibility: msg.visibility === 'private' ? 'private' : 'public',
          options: msg.options || {},
        });
        session.roomId = room.id;
        if (msg.fillBots && featureAllowed(db.data.config, 'bots', { role: me.role })) {
          const want = Math.max(0, (msg.botCount ?? engine.meta.players.min - 1));
          for (let i = 0; i < want; i++) {
            try {
              this.rooms.addBot(room, { level: msg.botLevel ?? 2, by: me });
            } catch {}
          }
        }
        this.rooms.touch(room);
        if (msg.autostart && this.rooms.canStart(room)) this.rooms.start(room);
        return;
      }
      case 'join': {
        let target = msg.roomId ? this.rooms.getRoom(msg.roomId) : null;
        if (!target && msg.code) {
          const wanted = String(msg.code).trim().toUpperCase();
          target = [...this.rooms.rooms.values()].find((r) => r.code === wanted) || null;
        }
        if (!target) throw new Error('No room with that code.');
        if (current && current.id !== target.id) this.leaveRoom(session, current);
        const seated = target.players.some((p) => p.id === me.id);
        const full = target.players.length >= target.engine.meta.players.max + (target.engine.meta.maxBots || 0);
        if (msg.spectate || target.status === 'playing' || full) {
          this.rooms.addSpectator(target, me);
        } else if (!seated) {
          this.rooms.addPlayer(target, me);
        }
        session.roomId = target.id;
        this.rooms.touch(target);
        return;
      }
      case 'leave':
        if (current) this.leaveRoom(session, current);
        return;
      case 'start': {
        if (!current) throw new Error('You are not in a room.');
        if (current.host !== me.id) throw new Error('Only the host can start.');
        this.rooms.start(current);
        return;
      }
      case 'addBot': {
        if (!current) throw new Error('You are not in a room.');
        if (current.host !== me.id) throw new Error('Only the host can add bots.');
        this.rooms.addBot(current, { level: msg.level, name: msg.name, by: me });
        return;
      }
      case 'kick': {
        if (!current) throw new Error('You are not in a room.');
        if (current.host !== me.id) throw new Error('Only the host can remove players.');
        this.rooms.removePlayer(current, String(msg.userId), { reason: 'was removed by the host' });
        return;
      }
      case 'invite': {
        // Anyone in the room can ask a friend to join: the invite IS how a
        // private room's code reaches someone, and a waiting room with an
        // empty seat is exactly who needs this button.  The target gets a
        // notification that joins in one tap (see the client's notify action).
        if (!current) throw new Error('You are not in a room.');
        const target = msg.userId ? getUser(msg.userId) : msg.name ? getUserByName(msg.name) : null;
        if (!target) throw new Error('User not found.');
        if (target.id === me.id) throw new Error("That's you - share the code with a friend instead.");
        this.rateCheck(session, 'room-invite', 8);
        this.notify(target.id, 'room-invite', `${me.name} invited you to ${current.engine.meta.name}.`, {
          roomId: current.id,
          code: current.code,
          gameId: current.gameId,
          game: current.engine.meta.name,
          from: userPublic(me),
        });
        return { ok: true };
      }
      case 'visibility': {
        // The host's tab hid or came back.  The world keeps streaming at the
        // cadence the browser still allows, but the room should know why frames
        // got choppier - and everyone sees normal service resume the moment the
        // host is back.  Only the host's own tab decides this for the room.
        if (!current || !current.engine.meta.realtime || current.host !== me.id) return { ok: true };
        this.rateCheck(session, 'room-visibility', 8);
        if (!this.rooms.noteHostVisibility(current, msg.hidden)) return { ok: true };
        if (msg.hidden) {
          this.rooms.systemMessage(current, `⏳ ${me.name} is hosting from a background tab — frames may be choppier until it is back.`);
        } else if (!current.streamWarned) {
          // A stream that stalled while hidden stays flagged: the roster banner
          // keeps naming the stall until a snapshot lands (see handleTick).
          this.rooms.systemMessage(current, `▶️ ${me.name} is back in the foreground.`);
        }
        this.rooms.broadcast(current);
        return { ok: true };
      }
      case 'rematch': {
        if (!current) throw new Error('You are not in a room.');
        if (current.host !== me.id) throw new Error('Only the host can restart.');
        this.rooms.start(current);
        return;
      }
      case 'options': {
        if (!current) throw new Error('You are not in a room.');
        if (current.host !== me.id) throw new Error('Only the host can change settings.');
        current.options = { ...current.options, ...(msg.options || {}) };
        this.rooms.touch(current);
        return;
      }
      case 'spectate': {
        const room = msg.roomId ? this.rooms.getRoom(msg.roomId) : null;
        if (!room) throw new Error('That game is no longer running.');
        if (current && current.id !== room.id) this.leaveRoom(session, current);
        this.rooms.addSpectator(room, me);
        session.roomId = room.id;
        this.rooms.touch(room);
        return;
      }
      default:
        throw new Error(`Unknown room op "${op}".`);
    }
  }

  leaveRoom(session, room) {
    const me = session.user;
    if (!me) return;
    const seated = room.players.some((p) => p.id === me.id);
    if (seated) this.rooms.removePlayer(room, me.id, { reason: 'left the game' });
    else room.spectators = room.spectators.filter((s) => s.id !== me.id);
    session.roomId = null;
    if (this.rooms.getRoom(room.id)) this.rooms.touch(room);
    session.conn.send({ t: 'room:closed', reason: 'left' });
  }

  /* ---------------- game actions ---------------- */

  handleGame(session, msg) {
    this.requireAuth(session);
    const room = session.roomId ? this.rooms.getRoom(session.roomId) : null;
    if (!room) throw new Error('You are not in a game room.');
    const res = this.rooms.act(room, session.user.id, msg.action || msg);
    if (res?.ok === false) {
      session.conn.send({ t: 'error', code: 'move', message: res.error || 'That move is not allowed.' });
      return { ok: false };
    }
    return { ok: true };
  }

  handleTick(session, msg) {
    this.requireAuth(session);
    const room = session.roomId ? this.rooms.getRoom(session.roomId) : null;
    if (!room || !room.engine.meta.realtime) return;
    if (room.host !== session.user.id) return;
    if (!msg.snapshot || typeof msg.snapshot !== 'object') return;
    room.state = msg.snapshot;
    room.updatedAt = now();
    room.lastActivity = now();
    // The out-of-band stream path (see also the snapshot branch of rooms.act):
    // a snapshot here is the room's heartbeat and clears any stall warning.
    this.rooms.noteHostSnapshot(room);
    // rebroadcast to everyone but the host (who already has this state)
    const recipients = [
      ...room.players.filter((p) => p.kind === 'human' && p.id !== session.user.id).map((p) => p.id),
      ...room.spectators.map((s) => s.id),
    ];
    if (recipients.length) this.sendToUsers(recipients, { t: 'tick', roomId: room.id, snapshot: msg.snapshot });
    if (room.engine.over) {
      const done = room.engine.over(room.state);
      if (done?.over) {
        this.rooms.finish(room, done);
        this.rooms.broadcast(room);
      }
    }
  }

  /* ---------------- chat ---------------- */

  handleChat(session, msg) {
    this.requireAuth(session);
    const me = session.user;
    const text = sanitizeText(msg.text);
    if (!text) return;
    const scope = String(msg.scope || 'global');

    if (scope === 'dm') {
      this.requireFeature(session, 'dm');
      this.rateCheck(session, 'dm', CHAT_LIMIT.dm);
      const target = msg.to ? getUser(msg.to) : getUserByName(msg.name);
      if (!target) throw new Error('User not found.');
      if (target.settings?.privacy?.allowDms === 'friends' && friendState(me.id, target.id)?.status !== 'accepted') {
        throw new Error('That player only accepts DMs from friends.');
      }
      if (friendState(me.id, target.id)?.status === 'blocked') throw new Error('Message could not be delivered.');
      const message = sendDm(me, target, text);
      this.sendToUser(target.id, { t: 'dm', message, from: userPublic(me) });
      session.conn.send({ t: 'dm', message });
      return { ok: true };
    }

    if (scope === 'room') {
      this.rateCheck(session, 'room', CHAT_LIMIT.room);
      const room = session.roomId ? this.rooms.getRoom(session.roomId) : null;
      if (!room) throw new Error('You are not in a game room.');
      const message = this.rooms.chat(room, me, text);
      return { ok: true, message };
    }

    if (scope === 'party') {
      this.rateCheck(session, 'party', CHAT_LIMIT.party);
      const party = session.partyId ? getParty(session.partyId) : null;
      if (!party) throw new Error('You are not in a party.');
      const message = { id: `p${now()}`, kind: 'chat', from: me.id, name: me.name, avatar: me.avatar, text, at: now() };
      appendPartyChat(party, message);
      this.emitParty(party, { t: 'chat', scope: `party:${party.id}`, message });
      return { ok: true, message };
    }

    // global
    this.rateCheck(session, 'global', CHAT_LIMIT.global);
    const message = { id: `g${now()}`, kind: 'chat', from: me.id, name: me.name, avatar: me.avatar, role: me.role, text, at: now() };
    appendMessage('global', message, 150);
    for (const [conn, s] of this.clients) if (s.user) conn.send({ t: 'chat', scope: 'global', message });
    return { ok: true, message };
  }

  handleTyping(session, msg) {
    if (!session.user) return;
    if (msg.scope === 'dm') this.requireFeature(session, 'dm');
    const payload = { t: 'typing', scope: msg.scope, userId: session.user.id, name: session.user.name, to: msg.to };
    if (msg.scope === 'dm') this.sendToUser(String(msg.to), payload);
    else if (msg.scope === 'party' && session.partyId) {
      const party = getParty(session.partyId);
      if (party) this.emitParty(party, payload);
    } else if (msg.scope === 'room' && session.roomId) {
      const room = this.rooms.getRoom(session.roomId);
      if (room) this.rooms.emit(room, payload);
    }
  }

  stats() {
    return {
      online: onlineCount(),
      connections: this.clients.size,
      authenticated: [...this.clients.values()].filter((s) => s.user).length,
      uptimeMs: now() - this.startedAt,
      presence: onlineCount(),
    };
  }

  shutdown() {
    this.closing = true;
    for (const timer of this.partyTimers.values()) clearTimeout(timer);
    this.partyTimers.clear();
    for (const timer of this.roomTimers.values()) clearTimeout(timer);
    this.roomTimers.clear();
    for (const session of this.clients.values()) {
      try {
        session.conn.send({ t: 'server:restart', message: 'Server is restarting - you will reconnect automatically.' });
        session.conn.close(1001, 'restart');
      } catch {}
    }
    this.ws?.close?.();
  }
}
