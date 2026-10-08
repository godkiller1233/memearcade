#!/usr/bin/env node
/**
 * Memes Arcade - server entry point.
 *
 * Boots: JSON database -> game engines -> HTTP static/REST -> WebSocket hub,
 * seeds the administrator account, and prints practical "how do I play with
 * friends" instructions including the LAN URLs.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ensureDirs, log, dataIsEphemeral } from './config.js';
import { db } from './lib/db.js';
import { createApp } from './lib/http.js';
import { createUser, getUserByName, setPassword, audit } from './store.js';
import { GameRooms, loadEngines } from './games.js';
import { RealtimeHub } from './realtime.js';
import { registerApi, botSecret } from './api.js';
import { createScheduleSweeper } from './lib/schedule.js';
import { API_VERSION, APP_VERSION } from '../shared/version.js';

async function main() {
  process.title = 'memes-arcade';
  ensureDirs();

  log(`Memes Arcade v${APP_VERSION} (api v${API_VERSION}) starting...`);
  db.load();
  log(`database: ${Object.keys(db.data.users).length} accounts, ${db.data.stats.gamesPlayed} games played`);

  await loadEngines();

  const admin = seedAdmin();

  const app = createApp({
    mounts: [
      { prefix: '/', dir: config.webDir },
      { prefix: '/docs', dir: path.join(config.dataDir, '..', 'docs') },
    ],
    meta: { cors: config.cors, corsOrigins: config.corsOrigins },
  });

  const rooms = new GameRooms({});
  const hub = new RealtimeHub({ rooms });
  registerApi(app, { rooms, hub });
  hub.attach(app.server);
  // Scheduled feature switches: push the change to open clients as windows
  // open and close.  The timer is unref'd, so it never holds the process open.
  const sweeper = createScheduleSweeper({ hub, intervalMs: config.scheduleTickMs });

  const port = config.port;
  await new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (p) => {
      app.server.listen(p, config.host);
    };
    app.server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      // A hosting platform routes to the exact PORT it assigned: retrying on a
      // neighbouring port there would leave the service unreachable.
      if (config.strictPort) {
        return reject(new Error(`Port ${port} is already in use. On Render, PORT is assigned by the platform - check for a second running copy.`));
      }
      attempt++;
      if (attempt > 10) return reject(new Error(`Ports ${port}-${port + 10} are all busy. Set MEMES_PORT to a free port.`));
      log(`port ${port + attempt - 1} is busy - trying ${port + attempt}...`);
      tryListen(port + attempt);
    });
    app.server.on('listening', resolve);
    tryListen(port);
  });
  const actualPort = app.server.address().port;
  db.data.config.port = actualPort;
  db.touch();

  banner(actualPort, admin);

  const shutdown = (signal) => {
    log(`${signal} received - shutting down`);
    sweeper.stop();
    hub.shutdown();
    rooms.rooms.clear?.();
    db.close();
    setTimeout(() => process.exit(0), 250);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.stack || err));
  process.on('uncaughtException', (err) => log('uncaught exception:', err?.stack || err));
}

function seedAdmin() {
  const name = config.admin.username;
  let user = getUserByName(name);
  if (user) {
    if (user.role !== 'owner') {
      user.role = 'owner';
      db.touch();
      log(`admin: promoted existing account "${user.name}" to owner`);
    }
    return { user, created: false, password: null };
  }

  const password = config.admin.password || generatePassword();
  user = createUser({ name, password, role: 'owner', bio: 'Founder of Memes Arcade.' });
  audit(user, 'admin.seed', user.id, {});
  db.touch();
  db.flush();

  const file = path.join(config.dataDir, 'ADMIN-CREDENTIALS.txt');
  const body = [
    'MEMES ARCADE - ADMINISTRATOR ACCOUNT',
    '====================================',
    `username: ${name}`,
    `password: ${password}`,
    '',
    'Change the password after your first sign-in (Settings -> Account).',
    `Sign in at ${config.publicUrl || `http://localhost:${config.port}`}/ then open the Admin tab.`,
    '',
    'Set MEMES_ADMIN_PASS in .env to control this password on a fresh install.',
  ].join('\n');
  try {
    fs.writeFileSync(file, body, { mode: 0o600 });
  } catch (err) {
    log('admin: could not write ADMIN-CREDENTIALS.txt:', err.message);
  }
  return { user, created: true, password, file };
}

function generatePassword() {
  const words = ['arcade', 'pixel', 'neon', 'meme', 'jump', 'quest', 'laser', 'party'];
  const w = words[crypto.randomInt(words.length)];
  const w2 = words[crypto.randomInt(words.length)];
  return `${w}-${w2}-${crypto.randomInt(1000, 9999)}`;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function banner(port, admin) {
  const lines = [];
  lines.push('');
  lines.push('   ███╗   ███╗███████╗███╗   ███╗███████╗███████╗');
  lines.push('   ████╗ ████║██╔════╝████╗ ████║██╔════╝██╔════╝');
  lines.push('   ██╔████╔██║█████╗  ██╔████╔██║█████╗  ███████╗');
  lines.push('   ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██╔══╝  ╚════██║');
  lines.push('   ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║███████╗███████║');
  lines.push('   ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚══════╝   A R C A D E');
  lines.push('');
  const base = config.publicUrl || `http://localhost:${port}`;
  lines.push(`   Website .......... ${base}/`);
  if (!config.publicUrl && !config.onPlatform) {
    const lan = lanAddresses().map((ip) => `http://${ip}:${port}/`);
    if (lan.length) lines.push(`   Same wifi ........ ${lan.join('  ')}`);
  }
  lines.push(`   REST API ......... ${base}/api/meta`);
  lines.push(`   Health check ..... ${base}/api/health`);
  lines.push(`   WebSocket ........ ${base.replace(/^http/, 'ws')}/ws`);
  lines.push('');
  if (admin.created) {
    lines.push(`   ADMIN ACCOUNT .... ${admin.user.name} / ${admin.password}`);
    lines.push(`   (also saved to ${path.relative(process.cwd(), admin.file || path.join(config.dataDir, 'ADMIN-CREDENTIALS.txt'))})`);
  } else {
    lines.push(`   ADMIN ACCOUNT .... ${admin.user.name} (existing password unchanged)`);
  }
  lines.push(`   BOT SECRET ....... ${botSecret()}`);
  lines.push('');
  if (config.onPlatform) {
    lines.push(`   Hosted mode ...... ${config.dataDir} is ephemeral unless a persistent disk is attached.`);
    lines.push('   Set MEMES_ADMIN_PASS + MEMES_BOT_SECRET in the dashboard so restarts keep');
    lines.push('   the same admin password and bot token. Full guide: docs/DEPLOY.md');
  } else {
    lines.push('   Play with friends on this wifi: share the "Same wifi" link above.');
    lines.push('   Play over the internet: deploy to Render (see docs/DEPLOY.md) or run a tunnel,');
    lines.push('   then set MEMES_PUBLIC_URL so invite links point at your address.');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err?.stack || err);
  process.exit(1);
});
