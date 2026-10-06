import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { log } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const TEXTUAL = /^(text\/|application\/(json|javascript|manifest)|image\/svg)/;

export function createApp({ mounts = [], meta = {} } = {}) {
  const routes = [];

  function add(method, pattern, handler, opts = {}) {
    const keys = [];
    const rx = new RegExp(
      '^' +
        pattern
          .replace(/\/+$/, '')
          .split('/')
          .map((seg) => {
            if (!seg) return '';
            if (seg === '*') {
              keys.push('wildcard');
              return '(.*)';
            }
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$',
      'i',
    );
    routes.push({ method, rx, keys, handler, opts, pattern });
  }

  const app = {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    routes,
    mounts,
    meta,
  };

  const server = http.createServer((req, res) => handle(app, req, res));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  app.server = server;
  return app;
}

async function handle(app, req, res) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'bad-url', message: 'Malformed request URL.' });
  }

  attachHelpers(res, req);
  applyCors(app, req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- API routes -------------------------------------------------------
  const pathname = decodeURIComponent(url.pathname);
  const isApi = pathname.startsWith('/api/');

  for (const route of app.routes) {
    if (route.method !== req.method) continue;
    const m = route.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    route.keys.forEach((k, i) => {
      params[k] = m[i + 1];
    });
    const ctx = {
      req,
      res,
      url,
      params,
      query: url.searchParams,
      method: req.method,
      ip: clientIp(req),
      app,
    };
    try {
      const body = await readBody(req, route.opts.limit);
      if (body instanceof Error) return send(res, body.status, { error: 'body', message: body.message });
      ctx.body = body ?? {};
      const out = await route.handler(ctx);
      if (res.writableEnded) return;
      if (out === undefined) return send(res, 204, null);
      if (out && out.__raw) return sendRaw(res, out.status || 200, out.buffer, out.type, out.headers);
      return send(res, 200, out);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code || 'request-failed', message: err.message, ...err.extra });
      }
      log(`http ${req.method} ${pathname} failed:`, err?.stack || err);
      return send(res, 500, { error: 'internal', message: 'Something broke on our side. Try again.' });
    } finally {
      if (app.meta.accessLog) {
        log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  }

  if (isApi) return send(res, 404, { error: 'no-route', message: `No API route for ${req.method} ${pathname}` });

  // --- static mounts ----------------------------------------------------
  if (req.method === 'GET' || req.method === 'HEAD') {
    for (const mount of app.mounts) {
      const hit = tryStatic(mount, pathname, req, res);
      if (hit) return;
    }
    // SPA fallback: serve the first mount's index.html for client routes.
    const first = app.mounts[0];
    if (first) {
      const index = path.join(first.dir, 'index.html');
      if (fs.existsSync(index)) return serveFile(req, res, index, { spa: true });
    }
  }
  return send(res, 404, { error: 'not-found', message: 'Not found.' });
}

function applyCors(app, req, res) {
  if (!app.meta.cors) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = app.meta.corsOrigins || ['*'];
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client, X-Client-Version, X-Client-Caps, X-Api-Version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}

function attachHelpers(res, req) {
  res.json = (obj, status = 200) => send(res, status, obj);
  res.raw = (buffer, type, status = 200) => sendRaw(res, status, buffer, type);
  res.text = (text, status = 200) => sendRaw(res, status, Buffer.from(String(text)), 'text/plain; charset=utf-8');
  res.stream = (status, headers, stream) => {
    res.writeHead(status, headers);
    stream.pipe(res);
  };
  res.setHeader('X-Powered-By', 'Memes Arcade');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(), geolocation=()');
}

function send(res, status, obj) {
  if (res.writableEnded) return;
  if (obj === null || status === 204) {
    res.writeHead(204);
    return res.end();
  }
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendRaw(res, status, buffer, type, headers = null) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': buffer.length,
    ...(headers || {}),
  });
  res.end(buffer);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return new HttpError(413, 'Request body too large. Split large uploads into chunks.');
      chunks.push(chunk);
    }
  } catch (err) {
    return new HttpError(400, `Could not read request body: ${err.message}`);
  }
  if (size === 0) return {};
  const buf = Buffer.concat(chunks);
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json') || buf[0] === 0x7b /* { */ || buf[0] === 0x5b /* [ */) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return new HttpError(400, 'Invalid JSON body.');
    }
  }
  return { __buffer: buf, length: size, type };
}

const cache = new Map(); // absolute path -> { mtimeMs, size, gzip }

function serveFile(req, res, file, { spa = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }

  const isText = TEXTUAL.test(type);
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  let body = fs.readFileSync(file);
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': spa ? 'no-cache' : 'public, max-age=60, must-revalidate',
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  };

  if (isText && acceptsGzip && body.length > 1024) {
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      body = cached.gzip;
    } else {
      body = zlib.gzipSync(body, { level: 6 });
      cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, gzip: body });
      if (cache.size > 200) cache.clear();
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }

  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  if (req.method === 'HEAD') return res.end(), true;
  res.end(body);
  return true;
}

function tryStatic(mount, pathname, req, res) {
  let rel = pathname;
  if (mount.prefix && mount.prefix !== '/') {
    if (!pathname.startsWith(mount.prefix)) return false;
    rel = pathname.slice(mount.prefix.length) || '/';
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  if (safe.includes('..')) return false;
  const file = path.join(mount.dir, safe);
  if (!file.startsWith(mount.dir)) return false;
  const base = path.basename(file);
  if (base.startsWith('.') && base !== '.well-known') return false;
  return serveFile(req, res, file, { spa: base === 'index.html' });
}

export function json(body) {
  return { __raw: true, status: 200, buffer: Buffer.from(JSON.stringify(body)), type: 'application/json' };
}

export function streamFile(res, file, type) {
  const stat = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': type || MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
  return true;
}

export { MIME, send, sendRaw, serveFile };
