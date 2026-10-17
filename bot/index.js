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
 *
 * Slash commands can take up to an hour to appear, and never do when the invite
 * was made without the applications.commands scope - so every command also
 * answers to a message: `!memearcade <command>` (see parseTextCommand).  Public
 * answers land in the channel; private ones (your stats, a link code, a vote)
 * are DMed, because a text reply has no ephemeral flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arcade } from './arcade.js';
import { DiscordRest, DiscordGateway, FULL_INTENTS } from './discord.js';
import { GuildReporter } from './presence.js';
import { COMMAND_DEFINITIONS, FeatureGate, LinkStore, PUBLIC_COMMANDS, TEXT_PREFIX, autocomplete, describeSwitches, parseTextCommand, runCommand, textCommandHelp, textFallbackHints } from './commands.js';

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
  /**
   * How often the console's server list is refreshed. The bot reports once at
   * boot regardless; the timer is what repairs a list after the arcade restarts
   * (which wipes its copy) without needing a bot restart too.
   */
  guildReportMs: (() => {
    const n = Number(process.env.BOT_GUILD_REPORT_MS);
    return Number.isFinite(n) && n >= 2000 ? n : 5 * 60000;
  })(),
};

const log = (msg) => console.log(`[bot] ${msg}`);

/** Replaced by main()'s shutdown once the gateway is up. */
let stopNow = () => process.exit(0);

/** How often the bot checks that the site it was started by is still there. */
const PARENT_POLL_MS = 5000;

/**
 * The site starts this bot as its child and stops it with itself, but a SIGKILL,
 * a crash or `node --watch` restarting the server cannot be handled. Left alone,
 * the old bot would stay online as a duplicate answering every command twice.
 * BOT_PARENT_PID is the site's pid; when it disappears, this process goes too.
 * Only the site sets it - `npm run bot` has no parent to watch.
 */
function watchParent(pid = Number(process.env.BOT_PARENT_PID)) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === 'EPERM') return; // alive, just not this user's to signal
      log(`the arcade process (${pid}) is gone - stopping`);
      stopNow();
    }
  }, PARENT_POLL_MS);
  timer.unref?.();
}

/**
 * A fatal, expected failure: stop main() by throwing, so reportFatal() reports
 * it once instead of leaving no way out of the middle of startup.
 */
function die(msg) {
  const err = new Error(msg);
  err.fatal = true;
  throw err;
}

/**
 * Print a fatal error and leave. No process.exit() here: on Windows it aborts
 * while the arcade's keep-alive sockets are still open (libuv's
 * "handle->flags & UV_HANDLE_CLOSING" assertion), which made a rejected token
 * look like a crash. Setting the exit code and letting the loop drain exits as
 * soon as stderr is written and the sockets idle out; the unref'd timer is only
 * a last resort so a stuck handle cannot keep us online.
 */
function reportFatal(err) {
  process.exitCode = 1;
  const text = err?.fatal ? err.message : err?.stack || err?.message || String(err);
  process.stderr.write(`[bot] ${text}\n`);
  setTimeout(() => process.exit(1), 15000).unref();
}

async function main() {
  watchParent();
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

  // The console's server list: reported at boot, then kept fresh. Only this
  // process holds the Discord token, so this is the arcade's only way to know.
  const presence = new GuildReporter({ rest, arcade, me, log, everyMs: config.guildReportMs });
  presence.start();

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

  /** The reply shape both paths share: text first, embeds beside it when a command has them. */
  const messagePayload = (content, embeds, extra = {}) => {
    const payload = { content: String(content || '').slice(0, 1990), allowed_mentions: { parse: [] }, ...extra };
    if (embeds?.length) payload.embeds = embeds;
    return payload;
  };

  /** Quote the triggering message where Discord allows it, so a busy channel keeps context. */
  const reference = (message) =>
    message?.id ? { message_id: message.id, fail_if_not_exists: false } : undefined;

  /**
   * A private answer has no ephemeral flag on a message, so it goes to a DM.
   * If the player's privacy settings reject DMs the content is withheld - a
   * link code or another account's stats must never land in the channel - and
   * the channel only hears that the DM could not be delivered.
   */
  async function sendPrivate(user, payload, channelId, message) {
    try {
      const dm = await rest.createDmChannel(user.id);
      if (!dm?.id) throw new Error('Discord returned no DM channel');
      await rest.createMessage(dm.id, payload);
      return true;
    } catch (err) {
      log(`${TEXT_PREFIX} DM to ${user.username || user.id} could not be sent: ${err.message}`);
      const note = '📬 **That answer is private, so it goes by DM** - but Discord would not let me message you. Allow direct messages from server members in your privacy settings, then try again.';
      await rest.createMessage(channelId, messagePayload(note, null, { message_reference: reference(message) })).catch(() => {});
      return false;
    }
  }

  /**
   * The text fallback: `!memearcade <command> [options]`.  Everything after the
   * parse is the same runCommand the interactions use, so the feature switches,
   * the link checks and the validation are shared.
   */
  async function handleMessageCreate(message) {
    if (!message || message.author?.bot || message.webhook_id) return;
    const parsed = parseTextCommand(message.content);
    if (!parsed) return;
    const channelId = message.channel_id;
    const user = {
      id: message.author?.id,
      username: message.author?.username,
      global_name: message.author?.global_name,
    };
    if (!channelId || !user.id) return;
    const who = user.username || 'someone';

    try {
      if (parsed.help) {
        await rest.createMessage(channelId, messagePayload(textCommandHelp(), null, { message_reference: reference(message) }));
        log(`${TEXT_PREFIX} help by ${who}`);
        return;
      }
      if (parsed.error) {
        // A typo is answered where it was typed, never DMed.
        await rest.createMessage(channelId, messagePayload(parsed.error, null, { message_reference: reference(message) }));
        log(`${TEXT_PREFIX} usage error by ${who}: ${parsed.error.slice(0, 80)}`);
        return;
      }

      const reply = await runCommand(parsed.name, parsed.options, { arcade, links, user, features, log });
      const payload = messagePayload(textFallbackHints(reply.content), reply.embeds, reply.ephemeral ? {} : { message_reference: reference(message) });
      if (reply.ephemeral) await sendPrivate(user, payload, channelId, message);
      else await rest.createMessage(channelId, payload);
      log(`${TEXT_PREFIX} ${parsed.name} by ${who}`);
    } catch (err) {
      log(`${TEXT_PREFIX} ${parsed.name || 'command'} failed: ${err.message}`);
      await rest
        .createMessage(channelId, messagePayload(`⚠️ ${err.message || 'Something went wrong.'}`, null, { message_reference: reference(message) }))
        .catch(() => {});
    }
  }

  const gateway = new DiscordGateway({
    token: config.discordToken,
    // MESSAGE_CONTENT is privileged; the gateway drops it (and says so) when
    // the Developer Portal has not enabled it, rather than going offline.
    intents: FULL_INTENTS,
    gatewayUrl: async () => config.gatewayUrl || (await rest.gateway()).url,
    onDispatch: (type, data) => {
      if (type === 'INTERACTION_CREATE') handleInteraction(data);
      else if (type === 'MESSAGE_CREATE') handleMessageCreate(data);
    },
    log,
  });
  gateway.start();
  log(`listening for slash commands and ${TEXT_PREFIX} text commands - press Ctrl+C to stop`);

  const shutdown = () => {
    log('shutting down');
    presence.stop();
    gateway.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  stopNow = shutdown;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A fatal gateway error (bad token, blocked intents) should not retry forever.
  const fatalTimer = setInterval(() => {
    if (gateway.fatal) {
      clearInterval(fatalTimer);
      gateway.stop();
      reportFatal(new Error(`Discord gateway refused to start: ${gateway.fatal}`));
    }
  }, 1000);
  fatalTimer.unref();
}

main().catch(reportFatal);
