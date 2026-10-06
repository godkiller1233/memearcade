/**
 * In-memory presence registry.  Deliberately tiny and dependency-free so both
 * the realtime hub and the REST API can read it without a circular import.
 */

const socketsByUser = new Map(); // userId -> Set<conn>
const statusByUser = new Map(); // userId -> 'online' | 'idle' | 'dnd' | 'invisible'

export function addSocket(userId, conn) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(conn);
}

export function removeSocket(userId, conn) {
  const set = socketsByUser.get(userId);
  if (!set) return 0;
  set.delete(conn);
  if (set.size === 0) {
    socketsByUser.delete(userId);
    statusByUser.delete(userId);
    return 0;
  }
  return set.size;
}

export function sockets(userId) {
  return [...(socketsByUser.get(userId) || [])];
}

export function isOnline(userId) {
  return (socketsByUser.get(userId)?.size ?? 0) > 0;
}

export function setStatus(userId, status) {
  const allowed = ['online', 'idle', 'dnd', 'invisible'];
  statusByUser.set(userId, allowed.includes(status) ? status : 'online');
}

export function statusOf(userId) {
  if (!isOnline(userId)) return 'offline';
  const s = statusByUser.get(userId) || 'online';
  return s === 'invisible' ? 'offline' : s;
}

export function onlineIds() {
  return [...socketsByUser.keys()];
}

export function onlineCount() {
  return socketsByUser.size;
}

/** Fan a message out to a set of user ids. */
export function emitTo(userIds, message) {
  const seen = new Set();
  let sent = 0;
  for (const uid of userIds) {
    for (const conn of sockets(uid)) {
      if (seen.has(conn)) continue;
      seen.add(conn);
      conn.send(message);
      sent++;
    }
  }
  return sent;
}

export function onlineSnapshot() {
  return onlineIds().map((id) => ({ id, status: statusOf(id) }));
}
