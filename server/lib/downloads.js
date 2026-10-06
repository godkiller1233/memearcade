/**
 * Desktop downloads.
 *
 * Two packages are generated straight from the running copy of the arcade, so
 * they always match the server you are looking at:
 *
 *   desktop-lite  a ~30 KB Electron shell that opens the website (or any server
 *                 URL you own).  Minimum files, needs the site online.
 *   desktop-host  the whole arcade - server, website, games, desktop shell.
 *                 Unzip, `npm start`, and it hosts its own games offline or on
 *                 the local network, while still being able to point at a
 *                 remote server when you want to play with everyone else.
 *
 * Nothing is written to disk: archives are built in memory and cached briefly,
 * which keeps working on hosts with an ephemeral filesystem (Render).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT, log } from '../config.js';
import { createZip } from './zip.js';
import { APP_VERSION } from '../../shared/version.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.freebuff', 'dist', '.cache', '.next', 'coverage']);
const SKIP_FILES = new Set(['.env', '.DS_Store', 'secret.key', 'db.json', 'db.backup.json', 'ADMIN-CREDENTIALS.txt']);
const SKIP_EXT = /\.(log|zip|tmp|bak)$/i;

/** App files that make up the Lite download (everything else in desktop/ is dev-only). */
const LITE_APP_FILES = ['main.js', 'preload.js', 'launcher.html', 'launcher.js'];

const CACHE_LIMIT = 8;
const cache = new Map();

/* ------------------------------------------------------------------ *
 * file collection
 * ------------------------------------------------------------------ */

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), base, out);
      continue;
    }
    if (SKIP_FILES.has(entry.name) || SKIP_EXT.test(entry.name)) continue;
    out.push({ abs: path.join(dir, entry.name), rel: path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/') });
  }
  return out;
}

function read(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

/* ------------------------------------------------------------------ *
 * package metadata
 * ------------------------------------------------------------------ */

function desktopPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  } catch {
    return { name: 'memes-arcade-desktop', productName: 'Memes Arcade', version: APP_VERSION, main: 'main.js', type: 'commonjs', devDependencies: {} };
  }
}

/** The Lite package.json drops the dev-only bits so `npm install` stays small. */
function litePackageJson() {
  const pkg = desktopPkg();
  return `${JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version || APP_VERSION,
      private: true,
      description: pkg.description,
      main: pkg.main || 'main.js',
      type: pkg.type || 'commonjs',
      scripts: { start: 'electron .' },
      devDependencies: { electron: pkg.devDependencies?.electron || '^31.0.0' },
    },
    null,
    2,
  )}\n`;
}

/* ------------------------------------------------------------------ *
 * text files shipped inside the archives
 * ------------------------------------------------------------------ */

const runWindows = (dir) =>
  [
    '@echo off',
    'REM Memes Arcade desktop - double click this file.',
    `cd /d "%~dp0${dir}"`,
    'where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)',
    'if not exist node_modules (echo Installing Electron (one time, ~90 MB^)... & call npm install || (pause & exit /b 1))',
    'call npm start',
    'pause',
    '',
  ].join('\r\n');

const runPosix = (dir) =>
  [
    '#!/usr/bin/env bash',
    '# Memes Arcade desktop - run:  bash run-mac-linux.sh',
    'set -e',
    `cd "$(dirname "$0")/${dir}"`,
    'command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }',
    'if [ ! -d node_modules ]; then echo "Installing Electron (one time, ~90 MB)…"; npm install; fi',
    'npm start',
    '',
  ].join('\n');

function liteReadme(server) {
  return [
    'MEMES ARCADE - DESKTOP LITE',
    '===========================',
    '',
    'This is the small download: it is a thin desktop window around the website.',
    'It does NOT contain the game server, so you need an internet connection and a',
    'reachable arcade address (the one you downloaded this from is pre-filled).',
    '',
    `Default server: ${server || '(none - you will be asked for one)'}`,
    '',
    'RUN IT',
    '  1. Install Node.js 18 or newer (https://nodejs.org) if you do not have it.',
    '  2. Double-click  run-windows.bat   (Windows)',
    '     or run       bash run-mac-linux.sh   (macOS / Linux)',
    '     - the first run downloads Electron once (~90 MB).',
    '  3. Pick "Connect to a website", paste the arcade address, hit Connect.',
    '',
    'You can switch server or mode any time from the Server menu.',
    '',
    'WANT OFFLINE PLAY, LAN PARTIES, OR TO HOST YOUR OWN MATCHES?',
    '  Download "Desktop Host" from the same page - it bundles the whole arcade',
    '  (server + website + games) so everything runs on your machine with no',
    '  internet at all. The menu option "Start local server" is disabled here.',
    '',
    `Version ${APP_VERSION} - MIT licensed. Everything runs locally; no trackers.`,
    '',
  ].join('\n');
}

function hostStartHere() {
  return [
    'MEMES ARCADE - FULL DOWNLOAD (HOST)',
    '===================================',
    '',
    'Everything is in this folder: the game server, the website, all game engines,',
    'and the desktop shell. Zero dependencies - no npm install needed for the server.',
    '',
    'PLAY ON THIS COMPUTER (offline, no internet needed)',
    '  1. Install Node.js 18+ (https://nodejs.org).',
    '  2. In this folder run:   npm start',
    '  3. Open http://localhost:8787 - sign in or play as guest.',
    '',
    'HOST A LAN PARTY (friends on your wifi)',
    '  npm start prints a "Same wifi" address. Share it - that is the whole setup.',
    '  Create a party, share the 4-letter code, and play.',
    '',
    'PLAY OVER THE INTERNET',
    '  Deploy this folder to Render (render.yaml is included - see docs/DEPLOY.md),',
    '  or run a tunnel, then set MEMES_PUBLIC_URL to your address.',
    '',
    'DESKTOP APP',
    '  cd desktop && npm install && npm start',
    '  Host mode starts the bundled server and runs entirely offline; Lite mode',
    '  connects to any arcade website. Switch modes from the Server menu.',
    '',
    'USEFUL',
    '  npm run check   syntax + engine sanity checks',
    '  npm test        engine unit tests',
    '  .env.example    every setting (copy to .env)',
    '  docs/DEPLOY.md  hosting guide (Render, tunnels, persistent disks)',
    '  docs/DESKTOP.md desktop modes explained',
    '',
    `Version ${APP_VERSION} - MIT licensed.`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * archives
 * ------------------------------------------------------------------ */

function liteEntries(server) {
  const now = new Date();
  const entries = [];
  for (const name of LITE_APP_FILES) {
    const abs = path.join(ROOT, 'desktop', name);
    if (!fs.existsSync(abs)) continue;
    entries.push({ name: `memes-arcade-desktop/${name}`, data: read(abs), mtime: now, mode: 0o644 });
  }
  entries.push({ name: 'memes-arcade-desktop/package.json', data: litePackageJson(), mtime: now });
  entries.push({ name: 'memes-arcade-desktop/config.default.json', data: `${JSON.stringify({ mode: server ? 'lite' : 'auto', server }, null, 2)}\n`, mtime: now });
  entries.push({ name: 'memes-arcade-desktop/README.txt', data: liteReadme(server), mtime: now });
  entries.push({ name: 'memes-arcade-desktop/run-windows.bat', data: runWindows('.'), mtime: now });
  entries.push({ name: 'memes-arcade-desktop/run-mac-linux.sh', data: runPosix('.'), mtime: now, mode: 0o755 });
  return entries;
}

function hostEntries() {
  const now = new Date();
  const entries = [{ name: 'memes-arcade/START-HERE.txt', data: hostStartHere(), mtime: now }];
  for (const file of walk(ROOT)) {
    if (file.rel.startsWith('desktop/dist/')) continue;
    entries.push({
      name: `memes-arcade/${file.rel}`,
      data: read(file.abs),
      mtime: now,
      mode: /\.(sh|command)$/i.test(file.rel) ? 0o755 : 0o644,
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/** Only accept a sane http(s) address as the baked-in default server. */
export function cleanServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 200 || !/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

function build(id, { server = '' } = {}) {
  if (id === 'desktop-lite') {
    return { filename: `memes-arcade-desktop-lite-${APP_VERSION}.zip`, buffer: createZip(liteEntries(server)) };
  }
  if (id === 'desktop-host') {
    return { filename: `memes-arcade-host-${APP_VERSION}.zip`, buffer: createZip(hostEntries()) };
  }
  return null;
}

function cached(id, server) {
  const key = `${id}|${server}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(id, { server });
  if (!built) return null;
  const item = {
    id,
    server,
    filename: built.filename,
    buffer: built.buffer,
    size: built.buffer.length,
    sha256: crypto.createHash('sha256').update(built.buffer).digest('hex'),
    builtAt: Date.now(),
  };
  cache.set(key, item);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  log(`downloads: built ${item.filename} (${Math.round(item.size / 1024)} KB)`);
  return item;
}

const CATALOG = [
  {
    id: 'desktop-lite',
    name: 'Desktop Lite',
    icon: '🪶',
    tagline: 'A tiny desktop window around the website. Needs the arcade online.',
    includes: ['Desktop shell (Electron)', 'Server switcher + mode menu', 'Run scripts for Windows/macOS/Linux'],
    requires: ['Node.js 18+', 'A reachable arcade address (this one is pre-filled)'],
    note: 'About 30 KB to download. The first launch installs Electron once (~90 MB).',
  },
  {
    id: 'desktop-host',
    name: 'Desktop Host (all files)',
    icon: '🏠',
    tagline: 'The whole arcade: host your own games and matches offline, on your wifi, or online.',
    includes: ['Game server + website', 'All game engines and music', 'Desktop shell in Host + Lite mode', 'Render blueprint and docs'],
    requires: ['Node.js 18+', 'Nothing else - zero dependencies'],
    note: 'No internet required: the server, games and music all run on your machine.',
  },
];

export function downloadManifest({ server = '' } = {}) {
  const clean = cleanServer(server) || config.publicUrl || '';
  return {
    ok: true,
    version: APP_VERSION,
    server: clean,
    downloads: CATALOG.map((entry) => {
      const item = cached(entry.id, clean);
      return {
        ...entry,
        size: item?.size ?? 0,
        bytes: item?.size ?? 0,
        sha256: item?.sha256 ?? '',
        filename: item?.filename ?? '',
        url: `/api/downloads/${entry.id}${clean ? `?server=${encodeURIComponent(clean)}` : ''}`,
      };
    }),
  };
}

export function getDownload(id, { server = '' } = {}) {
  if (!CATALOG.some((entry) => entry.id === id)) return null;
  return cached(id, cleanServer(server));
}
