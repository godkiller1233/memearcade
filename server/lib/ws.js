/**
 * Minimal, dependency-free RFC6455 WebSocket server.
 *
 * Only what a game platform needs: text frames, fragmentation, ping/pong,
 * the close handshake, backpressure queueing and a payload ceiling.  No
 * extensions and no permessage-deflate: game payloads are small and we would
 * rather spend CPU on the games.
 */
import crypto from 'node:crypto';
import { log } from '../config.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export class WsConnection {
  constructor(socket, req, { maxPayload = 6 * 1024 * 1024 } = {}) {
    this.socket = socket;
    this.req = req;
    this.id = crypto.randomBytes(8).toString('hex');
    this.maxPayload = maxPayload;
    this.closed = false;
    this.data = {}; // per-connection scratch space for the hub
    this.listeners = new Map();
    this.queue = [];
    this.queueBytes = 0;
    this.fragments = [];
    this.fragmentOp = null;
    this.fragmentBytes = 0;
    this.buf = Buffer.alloc(0);
    this.connectedAt = Date.now();
    this.lastSeen = Date.now();
    this.ip = req.socket.remoteAddress || '';

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish('socket-close'));
    socket.on('end', () => this.finish('socket-end'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this.finish('socket-error');
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        log('ws listener error:', err?.message || err);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  send(message) {
    if (this.closed) return false;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return this.writeFrame(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  ping(payload = Buffer.alloc(0)) {
    return this.writeFrame(OP.PING, payload);
  }

  pong(payload = Buffer.alloc(0)) {
    return this.writeFrame(OP.PONG, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.writeFrame(OP.CLOSE, payload);
    this.closed = true;
    try {
      this.socket.end(() => this.socket.destroy());
      setTimeout(() => this.socket.destroy(), 1000).unref?.();
    } catch {}
    this.emit('close', code, reason);
  }

  writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const frame = Buffer.concat([header, payload]);

    if (this.socket.writableLength > 4 * 1024 * 1024) {
      // peer is not keeping up: buffer a little, then drop the connection
      this.queue.push(frame);
      this.queueBytes += frame.length;
      if (this.queueBytes > 32 * 1024 * 1024) {
        log('ws: dropping slow client', this.id);
        this.finish('backpressure');
      }
      return false;
    }
    if (this.queue.length) {
      const pending = Buffer.concat(this.queue);
      this.queue = [];
      this.queueBytes = 0;
      try {
        this.socket.write(pending);
      } catch {}
    }
    try {
      return this.socket.write(frame);
    } catch (err) {
      this.finish('write-error');
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Receiving
   * ---------------------------------------------------------------- */

  onData(chunk) {
    this.lastSeen = Date.now();
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.maxPayload * 2) {
      this.close(1009, 'message too large');
      return;
    }
    try {
      this.parse();
    } catch (err) {
      log('ws parse error:', err?.message || err);
      this.close(1002, 'protocol error');
    }
  }

  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.close(1002, 'reserved bits set');
        return;
      }
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) {
          this.close(1009, 'message too large');
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxPayload) {
        this.close(1009, 'message too large');
        return;
      }
      if (!masked) {
        // Per spec, client->server frames must be masked.
        this.close(1002, 'unmasked frame');
        return;
      }
      if (this.buf.length < offset + 4) return;
      const mask = this.buf.subarray(offset, offset + 4);
      offset += 4;
      if (this.buf.length < offset + len) return;

      const payload = Buffer.allocUnsafe(len);
      this.buf.copy(payload, 0, offset, offset + len);
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(offset + len);

      switch (opcode) {
        case OP.CONT:
          if (this.fragmentOp === null) {
            this.close(1002, 'unexpected continuation');
            return;
          }
          this.fragments.push(payload);
          this.fragmentBytes += payload.length;
          if (fin) this.endFragments();
          break;
        case OP.TEXT:
        case OP.BINARY:
          if (this.fragmentOp !== null) {
            this.close(1002, 'interleaved message');
            return;
          }
          if (fin) {
            this.deliver(opcode, payload);
          } else {
            this.fragmentOp = opcode;
            this.fragments = [payload];
            this.fragmentBytes = payload.length;
          }
          break;
        case OP.CLOSE: {
          const code = len >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = len > 2 ? payload.subarray(2).toString('utf8') : '';
          if (!this.closed) {
            this.writeFrame(OP.CLOSE, payload.subarray(0, Math.min(len, 125)));
            this.closed = true;
            try {
              this.socket.end();
              setTimeout(() => this.socket.destroy(), 500).unref?.();
            } catch {}
            this.emit('close', code, reason);
          }
          return;
        }
        case OP.PING:
          if (len <= 125) this.pong(payload);
          break;
        case OP.PONG:
          this.emit('pong', payload);
          break;
        default:
          this.close(1002, `bad opcode ${opcode}`);
          return;
      }
    }
  }

  endFragments() {
    const op = this.fragmentOp;
    const payload = Buffer.concat(this.fragments, this.fragmentBytes);
    this.fragments = [];
    this.fragmentOp = null;
    this.fragmentBytes = 0;
    this.deliver(op, payload);
  }

  deliver(opcode, payload) {
    if (payload.length > this.maxPayload) {
      this.close(1009, 'payload too large');
      return;
    }
    if (opcode === OP.BINARY) {
      this.emit('binary', payload);
      return;
    }
    const text = payload.toString('utf8');
    this.emit('message', text);
  }

  finish(reason) {
    if (this._finished) return;
    this._finished = true;
    this.closed = true;
    this.emit('close', 1006, reason);
  }
}

/**
 * Attach WebSocket handling to an http.Server.
 * Returns { connections, close() } for diagnostics / graceful shutdown.
 */
export function attachWebSocket(server, { path = '/ws', maxPayload = 6 * 1024 * 1024, onConnection, pingIntervalMs = 30000 } = {}) {
  const connections = new Set();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (path && url.pathname !== path && !url.pathname.startsWith(`${path}/`)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );

    const conn = new WsConnection(socket, req, { maxPayload });
    conn.query = url.searchParams;
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    if (head && head.length) conn.onData(head);
    try {
      onConnection?.(conn, req, url);
    } catch (err) {
      log('ws onConnection error:', err?.stack || err);
      conn.close(1011, 'server error');
    }
  });

  const timer = setInterval(() => {
    for (const conn of connections) {
      if (conn.closed) continue;
      if (Date.now() - conn.lastSeen > pingIntervalMs * 3) {
        conn.finish('timeout');
        try {
          conn.socket.destroy();
        } catch {}
        continue;
      }
      conn.ping();
    }
  }, pingIntervalMs);
  if (timer.unref) timer.unref();

  return {
    connections,
    close() {
      clearInterval(timer);
      for (const conn of connections) conn.close(1001, 'server shutting down');
    },
  };
}
