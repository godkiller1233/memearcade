/**
 * The admin console's server list.
 *
 * Only the bot process holds the Discord token, so the arcade server cannot ask
 * Discord which servers the bot is in - the bot has to say so. It reads
 * /users/@me/guilds at boot and re-reports on a timer, and the arcade keeps the
 * last report for the console. That is deliberately one-way: the console never
 * needs a Discord credential, and nothing here lets a web request act as the bot.
 *
 * Everything a guild calls itself is treated as untrusted text: names are
 * flattened onto one line and capped, ids have to be snowflakes, and the icon
 * hash is stripped to the characters a CDN path may contain. Anything that does
 * not pass is dropped, not guessed at, so a strange guild object can never break
 * the console or bloat the data file.
 */

/** A bot in more servers than this only reports the first slice; nobody reads 60 rows. */
export const MAX_GUILDS = 60;

/**
 * Channel counts cost one REST call per guild. Past this many guilds the count
 * is left unknown (null, shown as "—") rather than burning the rate limit on a
 * number the console can live without.
 */
export const MAX_CHANNEL_LOOKUPS = 20;

/** Discord channel types that can hold a reply: text, announcement, forum, media. */
const TEXT_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

/** Flattens a server-supplied string onto one line and caps it. */
function flat(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The report the console stores: one row per server, owned servers first, then
 * by name. `channels` is the number of places a reply could go, or null when the
 * count was not fetched (too many guilds, or that guild's channels were hidden).
 */
export function summarizeGuilds(rawGuilds, channelsByGuild = new Map()) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(rawGuilds) ? rawGuilds : []) {
    if (out.length >= MAX_GUILDS) break;
    const id = String(raw?.id ?? '');
    if (!/^\d{5,25}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const channels = channelsByGuild.get(id);
    out.push({
      id,
      name: flat(raw?.name, 80) || 'Unnamed server',
      icon: typeof raw?.icon === 'string' ? raw.icon.replace(/[^a-z0-9_]/gi, '').slice(0, 64) || null : null,
      owner: raw?.owner === true,
      channels: Array.isArray(channels) ? channels.filter((c) => TEXT_CHANNEL_TYPES.has(c?.type)).length : null,
    });
  }
  return out.sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name));
}

/**
 * Reads the guild list and reports it to the arcade. Started at boot, so the
 * console has an answer before anyone opens the panel, and repeated on a timer
 * because the server may restart while the bot keeps running - a restart would
 * otherwise leave the panel permanently empty.
 */
export class GuildReporter {
  constructor({ rest, arcade, me, log = () => {}, everyMs = 5 * 60000 }) {
    this.rest = rest;
    this.arcade = arcade;
    this.me = me;
    this.log = log;
    this.everyMs = Math.max(Number(everyMs) || 0, 2000);
    this.timer = null;
    this.busy = false;
  }

  /** One report. Concurrent calls collapse into the one already running. */
  async report() {
    if (this.busy) return null;
    this.busy = true;
    try {
      const guilds = await this.rest.guilds();
      const list = Array.isArray(guilds) ? guilds : [];
      const channels = new Map();
      if (list.length <= MAX_CHANNEL_LOOKUPS) {
        await Promise.all(
          list.map(async (guild) => {
            const id = String(guild?.id ?? '');
            try {
              channels.set(id, await this.rest.guildChannels(id));
            } catch {
              // The count is optional: a guild whose channels Discord hides
              // still belongs in the list, just without a number beside it.
            }
          }),
        );
      }
      const summary = summarizeGuilds(list, channels);
      await this.arcade.reportGuilds({
        appId: this.me?.id || null,
        username: this.me?.username || null,
        guilds: summary,
      });
      this.log(`reported ${summary.length} server${summary.length === 1 ? '' : 's'} to the arcade console`);
      return summary;
    } finally {
      this.busy = false;
    }
  }

  /** Report now, then keep the console's list fresh (and re-listed after outages). */
  start() {
    const run = () => this.report().catch((err) => this.log(`server list report failed: ${err.message}`));
    run();
    this.timer = setInterval(run, this.everyMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
