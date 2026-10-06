/**
 * Realtime client: one WebSocket to /ws with automatic reconnect, a tiny
 * event bus, and defensive handling of unknown message types (forward
 * compatibility - a newer server can add messages we simply ignore).
 */
import { CLIENT_KIND, CLIENT_VERSION, API_VERSION, state, notify } from './store.js';
import { toast } from './dom.js';
import { CAPS } from './api.js';

const handlers = new Map();
let socket = null;
let reconnectDelay = 800;
let reconnectTimer = null;
let closedByUs = false;

export const rt = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type)?.delete(fn);
  },
  off(type, fn) {
    handlers.get(type)?.delete(fn);
  },
  send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (msg.t !== 'ping') {
        console.warn('ws not open, dropped', msg.t);
        offlineNotice();
      }
      return false;
    }
    socket.send(JSON.stringify(msg));
    return true;
  },
  get open() {
    return socket?.readyState === WebSocket.OPEN;
  },
  connect(token) {
    closedByUs = false;
    clearTimeout(reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // The session token travels in the `hello` frame, never the URL.  A query
    // token makes the server identify the socket before it has seen our
    // version, so it answers with a bogus "unidentified-client" note first.
    const url = `${proto}://${location.host}/ws`;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      scheduleReconnect(token);
      return;
    }
    setConnection('connecting');
    socket.onopen = () => {
      reconnectDelay = 800;
      setConnection('online');
      rt.send({ t: 'hello', v: CLIENT_VERSION, kind: CLIENT_KIND, caps: CAPS, api: API_VERSION, token });
      startPings();
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      dispatch(msg.t, msg);
      dispatch('*', msg);
    };
    socket.onclose = () => {
      stopPings();
      setConnection('offline');
      if (!closedByUs) scheduleReconnect(state.token);
    };
    socket.onerror = () => setConnection('error');
  },
  disconnect() {
    closedByUs = true;
    hadOnline = false;
    clearTimeout(reconnectTimer);
    stopPings();
    socket?.close(1000, 'client closing');
    socket = null;
    setConnection('offline');
  },
};

/*
 * Round-trip ping.  The server echoes our own timestamp back, so the measured
 * time needs no clock sync, and the in-game network HUD shows a smoothed value
 * instead of one noisy sample.
 */
export const netStats = { ping: null, samples: 0 };
const PING_MS = 1500;
let pingTimer = null;

function pingTick() {
  rt.send({ t: 'ping', ts: Date.now() });
}

function startPings() {
  clearInterval(pingTimer);
  pingTick();
  pingTimer = setInterval(pingTick, PING_MS);
}

function stopPings() {
  clearInterval(pingTimer);
  pingTimer = null;
}

rt.on('pong', (msg) => {
  const sent = Number(msg?.ts);
  if (!Number.isFinite(sent)) return;
  const rtt = Date.now() - sent;
  if (rtt < 0 || rtt > 10000) return; // clock weirdness or a very stale reply
  netStats.ping = netStats.ping === null ? rtt : netStats.ping * 0.7 + rtt * 0.3;
  netStats.samples++;
});

function scheduleReconnect(token) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => rt.connect(token), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, 12000);
}

function dispatch(type, msg) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(msg);
    } catch (err) {
      console.error(`handler for ${type} failed`, err);
    }
  }
}

let offlineNoticeAt = 0;
/** One nudge when an action is dropped because the socket is down. */
function offlineNotice() {
  if (Date.now() - offlineNoticeAt < 3000) return;
  offlineNoticeAt = Date.now();
  toast('Not connected right now - reconnecting, try again in a moment.', 'warn', 3200);
}

/** True once this page has had a working socket (so a reconnect can say so). */
let hadOnline = false;

function setConnection(status) {
  const prev = state.connection;
  if (prev === status) return;
  state.connection = status;
  // Deliberate disconnects (logout) are silent; an unexpected drop is not.
  // A reconnect reads connecting -> online, so "was online before" is the flag.
  if (!closedByUs) {
    if (status === 'online') {
      if (hadOnline) toast('Back online.', 'good', 2200);
      hadOnline = true;
    } else if ((status === 'offline' || status === 'error') && prev === 'online') {
      toast('Connection lost - reconnecting…', 'warn', 5000);
    }
  }
  notify();
}

export function sendChat(scope, text, to = null) {
  return rt.send({ t: 'chat', scope, text, to });
}

export function joinRoom({ gameId, options, code, fillBots = false, botLevel = 2, visibility = 'public', spectate = false }) {
  if (code) return rt.send({ t: 'room', op: 'join', code });
  if (spectate) return rt.send({ t: 'room', op: 'spectate', roomId: gameId });
  return rt.send({ t: 'room', op: 'create', gameId, options, fillBots, botLevel, visibility });
}

export function startRoom() {
  return rt.send({ t: 'room', op: 'start' });
}

export function addBot(level = 2) {
  return rt.send({ t: 'room', op: 'addBot', level });
}

export function leaveRoom() {
  return rt.send({ t: 'room', op: 'leave' });
}

export function gameAction(action) {
  return rt.send({ t: 'game', action });
}

export function partyOp(op, extra = {}) {
  return rt.send({ t: 'party', op, ...extra });
}
