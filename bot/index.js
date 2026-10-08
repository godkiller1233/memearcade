#!/usr/bin/env node
/**
 * Memes Arcade Discord bot.
 *
 *   DISCORD_TOKEN=...  ARCADE_BOT_SECRET=...  node bot/index.js   (npm run bot)
 *
 * It registers the idea-board slash commands and answers interactions:
 * /ideas (public board), /changelog (shipped ideas), /suggest, /vote and
 * /link. Posting and voting use the linked account's session, obtained through
 * the server's /api/bot/link flow.
 * It also answers autocomplete for /leaderboard game: from the live catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arcade } from './arcade.js';
import { DiscordRest, DiscordGateway } from './discord.js';
import { COMMAND_DEFINITIONS, FeatureGate, LinkStore, PUBLIC_COMMANDS, autocomplete, describeSwitches, runCommand } from './commands.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Same .env contract as the server: real environment variables win. */
function loadDotEnv(file = path.join(HERE, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const config = {
  discordToken: process.env.DISCORD_TOKEN || '',
  botSecret: process.env.ARCADE_BOT_SECRET || '',
  arcadeUrl: process.env.ARCADE_URL || 'http://127.0.0.1:8787',
  guildId: process.env.DISCORD_GUILD_ID || '',
  apiBase: process.env.DISCORD_API_BASE || 'https://discord.com/api/v10',
  gatewayUrl: process.env.DISCORD_GATEWAY_URL || '',
  /**
   * How long the bot may trust the switch map it read.  Commands ask on every
   * invocation, so a short cache keeps that to one call; 0 reads the switches
   * afresh for every command (what the checks use).
   */
  featureTtlMs: (() => {
    const n = Number(process.env.BOT_FEATURE_TTL_MS);
    return Number.isFinite(n) && n >= 0 ? n : 10000;
  })(),
};

const log = (msg) => console.log(`[bot] ${msg}`);

function die(msg) {
  console.error(`[bot] ${msg}`);
  process.exit(1);
}

async function main() {
  if (!config.discordToken) {
    die('DISCORD_TOKEN is missing. Put it in bot/.env (see bot/.env.example) or export it.');
  }
  if (!config.botSecret || config.botSecret.length < 16) {
    die('ARCADE_BOT_SECRET is missing. Get it from the arcade: Admin console -> 🤖 Discord bot, then put it in bot/.env.');
  }
  if (typeof WebSocket !== 'function') {
    die('This bot needs Node 22 or newer (it uses the built-in WebSocket).');
  }

  const arcade = new Arcade({ url: config.arcadeUrl, botToken: config.botSecret });
  try {
    const health = await arcade.health();
    log(`arcade reachable at ${config.arcadeUrl} (${health.engines} engines)`);
  } catch (err) {
    log(`warning: ${err.message} - commands will reply with an error until it is up`);
  }

  // The owner's feature switches, read once at boot: an owner who scheduled the
  // idea board off for the night should hear it from the bot log rather than
  // from a player.  Every command re-reads through the same gate.
  const features = new FeatureGate(arcade, { ttlMs: config.featureTtlMs });
  log(describeSwitches(await features.flags()));

  const rest = new DiscordRest({ token: config.discordToken, base: config.apiBase });
  let me;
  try {
    me = await rest.me();
  } catch (err) {
    die(`Discord rejected the bot token: ${err.message}`);
  }
  rest.applicationId = me.id; // for a bot, the application id is the user id
  log(`signed in to Discord as ${me.username}`);

  try {
    const registered = config.guildId
      ? await rest.putGuildCommands(config.guildId, COMMAND_DEFINITIONS)
      : await rest.putGlobalCommands(COMMAND_DEFINITIONS);
    log(`registered ${registered.length} slash commands ${config.guildId ? `in guild ${config.guildId}` : '(globally - Discord can take up to an hour to show them the first time)'}`);
  } catch (err) {
    log(`command registration failed: ${err.message} (existing commands still work)`);
  }

  const links = new LinkStore(arcade);

  /**
   * Autocomplete: answer from the live catalog inside Discord's 3s window.
   * Nothing may be deferred here, so any failure falls back to no choices - an
   * empty list is a valid answer, a missing one is not.
   */
  async function handleAutocomplete(interaction) {
    const name = interaction.data?.name || 'unknown';
    let choices = [];
    try {
      choices = await autocomplete(name, interaction.data?.options || [], { arcade, features });
    } catch (err) {
      log(`/${name} autocomplete failed: ${err.message}`);
    }
    await rest
      .interactionCallback(interaction.id, interaction.token, { type: 8, data: { choices } })
      .catch((err) => log(`/${name} autocomplete reply failed: ${err.message}`));
  }

  async function handleInteraction(interaction) {
    if (interaction.type === 4) return handleAutocomplete(interaction); // AUTOCOMPLETE
    if (interaction.type !== 2) return; // APPLICATION_COMMAND only
    const name = interaction.data?.name || 'unknown';
    const user = interaction.member?.user || interaction.user || {};
    // /ideas, /changelog and /leaderboard are public; the rest reply privately.
    const ephemeral = !PUBLIC_COMMANDS.has(name);
    try {
      // Defer first: the arcade round-trip may take longer than Discord's 3s window.
      await rest.interactionCallback(interaction.id, interaction.token, {
        type: 5,
        data: ephemeral ? { flags: 64 } : undefined,
      });
      const reply = await runCommand(name, interaction.data?.options || [], { arcade, links, user, features, log });
      const payload = {
        content: String(reply.content || '').slice(0, 1990),
        allowed_mentions: { parse: [] },
      };
      // /arcade and /profile answer with an embed instead of text; Discord
      // accepts an empty content beside one, and the card beats the prose.
      if (reply.embeds?.length) payload.embeds = reply.embeds;
      await rest.editOriginal(interaction.token, payload);
      log(`/${name} by ${user.username || 'someone'}`);
    } catch (err) {
      log(`/${name} failed: ${err.message}`);
      await rest
        .editOriginal(interaction.token, { content: `⚠️ ${err.message || 'Something went wrong.'}`.slice(0, 1990) })
        .catch(() => {});
    }
  }

  const gateway = new DiscordGateway({
    token: config.discordToken,
    gatewayUrl: async () => config.gatewayUrl || (await rest.gateway()).url,
    onDispatch: (type, data) => {
      if (type === 'INTERACTION_CREATE') handleInteraction(data);
    },
    log,
  });
  gateway.start();
  log('listening for slash commands - press Ctrl+C to stop');

  const shutdown = () => {
    log('shutting down');
    gateway.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A fatal gateway error (bad token, blocked intents) should not retry forever.
  const fatalTimer = setInterval(() => {
    if (gateway.fatal) {
      clearInterval(fatalTimer);
      die(`Discord gateway refused to start: ${gateway.fatal}`);
    }
  }, 1000);
  fatalTimer.unref();
}

main().catch((err) => die(err.stack || err.message));
