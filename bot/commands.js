/**
 * The bot's slash commands. Definitions are registered with Discord; the
 * handlers build the reply text and are kept free of Discord plumbing so they
 * can be tested directly.
 *
 * Posting, voting and your own stats need a linked account: the bot asks
 * /api/bot/link/start for a token and caches it, so the player only links
 * once. `/arcade player:<name>` looks up anyone's public profile, linked or
 * not - it reads the same public shape the website's player list exposes and
 * renders it as an embed (avatar thumbnail, bio, level colour) rather than a
 * wall of text. `/profile` goes a step further and uses the two sections of
 * that payload /arcade ignores: `recent` (games played per game) and
 * `achievements`.
 *
 * `/leaderboard game:` autocompletes from the live catalog (see autocomplete),
 * so players pick a real game instead of guessing its name or id. `/changelog`
 * renders the shipped ideas the site's changelog page shows.
 *
 * Every command also respects the owner's feature switches (see COMMAND_FEATURE
 * and FeatureGate): a feature the arcade has switched off - or scheduled off for
 * the night - answers with the same notice the website shows instead of serving
 * a closed board. The switch labels come from shared/features.js, so the bot and
 * the console can never name a switch differently.
 */
import { FEATURE_IDS, featureLabel } from '../shared/features.js';

const CATEGORY_ICON = { game: '🎮', feature: '✨', update: '🛠️', other: '💬' };
const STATUS_ORDER = ['open', 'planned', 'in-progress', 'done', 'declined'];
const CATEGORY_CHOICES = [
  { name: '🎮 New game', value: 'game' },
  { name: '✨ Feature', value: 'feature' },
  { name: '🛠️ Update', value: 'update' },
  { name: '💬 Other', value: 'other' },
];

export const COMMAND_DEFINITIONS = [
  {
    name: 'arcade',
    description: 'Your linked stats, or any player by name',
    options: [
      { type: 3, name: 'player', description: 'Any player to look up by name (default: your linked account)', max_length: 32 },
    ],
  },
  {
    name: 'profile',
    description: "A player's games played and achievements",
    options: [
      { type: 3, name: 'player', description: 'Any player to look up by name (default: your linked account)', max_length: 32 },
    ],
  },
  {
    name: 'leaderboard',
    description: 'Top players by level, wins or games - or one game',
    options: [
      {
        type: 3,
        name: 'sort',
        description: 'How to rank players (default: level)',
        choices: [
          { name: '⭐ Level (XP)', value: 'level' },
          { name: '🏆 Wins', value: 'wins' },
          { name: '🎮 Games played', value: 'games' },
        ],
      },
      // autocomplete: true offers the catalog as you type; typing freely still
      // works, and a submitted value may be an id or a name either way.
      { type: 3, name: 'game', description: 'Rank one game instead - its name or id (e.g. pong)', max_length: 40, autocomplete: true },
    ],
  },
  {
    name: 'ideas',
    description: 'Browse the arcade idea board with vote counts',
    options: [
      {
        type: 3,
        name: 'sort',
        description: 'How to order the ideas (default: top voted)',
        choices: [
          { name: '🔥 Top voted', value: 'top' },
          { name: '🕒 Newest', value: 'new' },
        ],
      },
      {
        type: 3,
        name: 'status',
        description: 'Only ideas in this state',
        choices: [{ name: 'All', value: 'all' }, ...STATUS_ORDER.map((s) => ({ name: s, value: s }))],
      },
      {
        type: 3,
        name: 'category',
        description: 'Only ideas of this kind',
        choices: [{ name: 'All', value: 'all' }, ...CATEGORY_CHOICES],
      },
    ],
  },
  {
    name: 'changelog',
    description: 'Ideas from the board that actually shipped, newest first',
  },
  {
    name: 'suggest',
    description: 'Suggest a new game, feature or update for the arcade',
    options: [
      { type: 3, name: 'title', description: 'One line: what should we add?', required: true, max_length: 120 },
      { type: 3, name: 'details', description: 'Describe it - what would it do, and why is it fun?', required: true, max_length: 2000 },
      { type: 3, name: 'category', description: 'What kind of idea is it? (default: feature)', choices: CATEGORY_CHOICES },
    ],
  },
  {
    name: 'vote',
    description: 'Upvote (or unvote) an idea from the board',
    options: [{ type: 3, name: 'idea', description: 'The idea id shown on /ideas', required: true, max_length: 12 }],
  },
  {
    name: 'link',
    description: 'Link your Discord account so you can post and vote as yourself',
  },
];

/** Keeps the linked-account tokens the bot uses for player-bound calls. */
export class LinkStore {
  constructor(arcade) {
    this.arcade = arcade;
    this.tokens = new Map(); // discord user id -> { token, name }
  }

  async tokenFor(user) {
    const cached = this.tokens.get(user.id);
    if (cached) return cached.token;
    const res = await this.arcade.linkStart(user.id, user.username || user.global_name || '');
    if (res?.linked && res.token) {
      const name = res.user?.name || 'player';
      this.tokens.set(user.id, { token: res.token, name });
      return res.token;
    }
    return null;
  }

  /** Runs `fn(token)`; a rejected session (server restarted, token expired) gets one fresh link. */
  async withToken(user, fn) {
    let token = await this.tokenFor(user);
    if (!token) return { unlinked: true };
    try {
      return { value: await fn(token) };
    } catch (err) {
      if (err?.status !== 401) throw err;
      this.tokens.delete(user.id);
      token = await this.tokenFor(user);
      if (!token) return { unlinked: true };
      return { value: await fn(token) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * feature switches
 * ------------------------------------------------------------------ */

/** Commands whose replies land in the channel; the rest answer privately. */
export const PUBLIC_COMMANDS = new Set(['ideas', 'changelog', 'leaderboard']);

/** Which switch each command needs; a command that is not listed needs none. */
export const COMMAND_FEATURE = {
  ideas: 'suggestions',
  suggest: 'suggestions',
  vote: 'suggestions',
  changelog: 'changelog',
  leaderboard: 'leaderboard',
};

/**
 * The reply for a command whose feature is switched off: it names the feature
 * exactly as the admin console does, says whether an owner closed it or a
 * schedule did, and - for a schedule - when it comes back, as Discord stamps in
 * the reader's own timezone (<t:...:t> short time, <t:...:R> relative).
 */
export function featureOffReply(id, flag = {}, { ephemeral = true } = {}) {
  const until = flag?.scheduled && flag?.until ? new Date(flag.until) : null;
  const stamp = until && !Number.isNaN(until.getTime()) ? Math.floor(until.getTime() / 1000) : null;
  return {
    content: [
      `🚪 **${featureLabel(id)} is turned off on this arcade.**`,
      stamp
        ? `It is on a schedule: it reopens <t:${stamp}:R> (<t:${stamp}:t>).`
        : 'The owner switched it off - try again later, or ask an admin to switch it back on.',
    ].join('\n'),
    ephemeral,
  };
}

/** One line for the boot log, so the operator sees what the arcade has closed. */
export function describeSwitches(flags) {
  if (!flags) return 'feature switches: could not be read - commands follow the server instead';
  const off = FEATURE_IDS.filter((id) => flags[id]?.on === false);
  const hidden = FEATURE_IDS.filter((id) => flags[id]?.on !== false && flags[id]?.hidden === true);
  if (!off.length && !hidden.length) return 'feature switches: everything is on and shown';
  const bits = [];
  if (off.length) bits.push(`${off.length} off (${off.map(featureLabel).join(', ')})`);
  if (hidden.length) bits.push(`${hidden.length} hidden (${hidden.map(featureLabel).join(', ')})`);
  const closed = off.filter((id) => flags[id]?.scheduled === true);
  if (closed.length) bits.push(`closed by a schedule right now: ${closed.map(featureLabel).join(', ')}`);
  return `feature switches: ${bits.join(' · ')}`;
}

/**
 * Reads the arcade's switch map and caches it briefly, because every command
 * asks.  A read that fails or times out answers "no flags", never "all clear":
 * the command then runs and the server's own refusal (the same 403 the website
 * gets) becomes the reply, so a hiccup can never leave the bot more permissive
 * than the arcade it talks to.
 */
export class FeatureGate {
  constructor(arcade, { ttlMs = 10000, timeoutMs = 1200, now = () => Date.now() } = {}) {
    this.arcade = arcade;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cached = null; // { at, flags }
    this.inFlight = null;
  }

  /** The switch map, or null when it could not be read. */
  async flags() {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.flags;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.arcade
      .meta({ timeoutMs: this.timeoutMs })
      .then((res) => {
        const flags = res?.config?.features || null;
        if (flags) this.cached = { at: this.now(), flags };
        return flags;
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The stored flag when this feature is switched off for players, else null. */
  async off(id) {
    const flags = await this.flags();
    return flags?.[id]?.on === false ? flags[id] : null;
  }

  /** True when a switch keeps this unadvertised: switched off, or hidden. */
  async hiddenOrOff(id) {
    const flags = await this.flags();
    const flag = flags?.[id];
    return !!flag && (flag.on === false || flag.hidden === true);
  }
}

const optionsToObject = (options = []) => Object.fromEntries(options.map((o) => [o.name, o.value]));
const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const num = (n) => Number(n || 0).toLocaleString('en-US');

const MEDALS = ['🥇', '🥈', '🥉'];

const LEADER_SORTS = {
  level: 'ranked by level',
  wins: 'ranked by wins',
  games: 'ranked by games played',
};

function gameName(catalog, id) {
  const game = (catalog?.games || []).find((g) => g.id === id);
  return game?.name || id;
}

/* ------------------------------------------------------------------ *
 * /arcade and /profile embeds
 * ------------------------------------------------------------------ */

/**
 * Level -> embed colour. Discord paints an embed's left edge in this colour,
 * so a profile's rung is readable before you read a word of it. The bands walk
 * the site's own palette (slate -> good green -> accent cyan -> violet ->
 * accent pink -> warn gold) and every level from 1 up lands on one.
 */
const LEVEL_COLORS = [
  { from: 50, color: 0xfbbf24 }, // gold - the top of the curve
  { from: 35, color: 0xff2fb0 }, // site accent
  { from: 20, color: 0xa78bfa }, // violet
  { from: 10, color: 0x22d3ee }, // site accent-2
  { from: 5, color: 0x34d399 }, // site good
  { from: 1, color: 0x6b7280 }, // slate - just starting out
];

export function levelColor(level) {
  const rung = Math.max(1, Math.floor(Number(level) || 1));
  const band = LEVEL_COLORS.find((b) => rung >= b.from) || LEVEL_COLORS[LEVEL_COLORS.length - 1];
  return band.color;
}

/**
 * Discord thumbnails need an image URL, and arcade avatars are emoji (see
 * AVATARS in server/store.js). Twemoji publishes every emoji as a PNG named by
 * its code points, so '👾' resolves to 1f47e.png. The avatar field accepts
 * anything, so text yields null and the caller drops the thumbnail rather than
 * pointing Discord at a broken image.
 */
export function avatarImageUrl(avatar) {
  const emoji = String(avatar || '').replace(/\uFE0F/g, '').trim();
  if (!emoji || /[\u0000-\u007F]/.test(emoji)) return null;
  const name = [...emoji].map((ch) => ch.codePointAt(0).toString(16)).join('-');
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${name}.png`;
}

/**
 * Title and thumbnail rules shared by both profile embeds. An emoji avatar
 * rides in the title only when it cannot be a thumbnail, so the avatar is never
 * missing entirely (see avatarImageUrl).
 */
function identity(player) {
  const thumbnail = avatarImageUrl(player.avatar);
  return {
    thumbnail,
    title: thumbnail ? String(player.name || 'Player') : `${player.avatar || '🎮'} ${player.name || 'Player'}`.trim(),
  };
}

/**
 * The linked player's profile as a Discord embed: the avatar as the thumbnail,
 * the name as the title, the bio above the level, coins and match record, and
 * a colour that encodes the level (see levelColor).
 */
export function arcadeEmbed(player, { topGame = null, catalog = null } = {}) {
  const s = player.stats || {};
  const games = s.games || 0;
  const winRate = games ? Math.round(((s.wins || 0) / games) * 100) : 0;
  const lines = [
    `⭐ **Level ${player.level}** · ${num(player.xp)} XP (${player.xpPct || 0}% to level ${(player.level || 1) + 1}) · 💰 ${num(player.coins)} coins`,
    `🏆 ${s.wins || 0} wins · ${s.losses || 0} losses · ${s.draws || 0} draws · ${games} games · ${winRate}% win rate`,
  ];
  if (topGame) lines.push(`🕹️ Most played: **${gameName(catalog, topGame[0])}** · ${topGame[1]} game${topGame[1] === 1 ? '' : 's'}`);
  if (s.streak || s.bestStreak) lines.push(`🔥 Streak ${s.streak || 0} · best ${s.bestStreak || 0}`);
  const bio = oneLine(player.bio || '', 400);
  const { thumbnail, title } = identity(player);
  const embed = {
    title,
    description: [bio ? `_${bio}_` : '', lines.join('\n')].filter(Boolean).join('\n\n'),
    color: levelColor(player.level),
  };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  return embed;
}

/**
 * The activity half of a public profile (GET /api/users/:id): the games the
 * player has actually played, with each one's share of their matches, and the
 * achievements the server hands out for winning, variety and streaks (see
 * achievementsFor in server/api.js). /arcade is the headline; this is the
 * detail behind it, as one field per section so Discord keeps them apart.
 */
export function profileEmbed(player, { byGame = [], achievements = [], catalog = null } = {}) {
  const games = player?.stats?.games || 0;
  const earned = Array.isArray(achievements) ? achievements : [];
  const total = byGame.reduce((n, [, count]) => n + (Number(count) || 0), 0) || games;
  const plays = byGame.slice(0, 8).map(([id, count]) => {
    const share = total ? Math.round((count / total) * 100) : 0;
    return `**${gameName(catalog, id)}** — ${num(count)} game${count === 1 ? '' : 's'} (${share}%)`;
  });
  if (byGame.length > 8) plays.push(`…and ${byGame.length - 8} more.`);
  const won = earned.slice(0, 10).map((a) => `${a.icon || '🏅'} **${a.name}**`);
  if (earned.length > 10) won.push(`…and ${earned.length - 10} more.`);
  const { thumbnail, title } = identity(player || {});
  const embed = {
    title,
    description: `⭐ **Level ${player?.level ?? 1}** · 🎮 ${num(games)} game${games === 1 ? '' : 's'} played · 🏅 ${earned.length} achievement${earned.length === 1 ? '' : 's'} earned`,
    color: levelColor(player?.level),
    fields: [
      { name: '🕹️ Games played', value: plays.length ? plays.join('\n') : '_None yet — open a room on the site and play a match._', inline: false },
      { name: '🏅 Achievements', value: won.length ? won.join('\n') : '_None yet — win your first match to earn 🥇 **First Blood**._', inline: false },
    ],
  };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  return embed;
}

/** The public player ranking from /api/users (see the arcade's player list). */
function formatLeaderboard(users, sort, total) {
  const lines = [`🏆 **Top players** · ${LEADER_SORTS[sort]} · ${num(total)} account${total === 1 ? '' : 's'}`];
  if (!users.length) {
    lines.push(sort === 'level' ? '_No players yet._' : '_Nobody has that stat yet - play a match and claim the top spot!_');
  } else {
    users.slice(0, 10).forEach((u, i) => {
      const s = u.stats || {};
      lines.push(`${MEDALS[i] || `**${i + 1}.**`} ${u.avatar || ''} **${u.name}** · Lv ${u.level} · ⭐ ${num(u.xp)} XP · 🏆 ${s.wins || 0} wins · 🎮 ${s.games || 0} games`);
    });
  }
  return lines.join('\n');
}

/** Finds a catalog game by id or display name; a partial name still counts. */
function findGame(catalog, wanted) {
  const needle = String(wanted).toLowerCase();
  const games = catalog?.games || [];
  return games.find((g) => String(g.id).toLowerCase() === needle)
    || games.find((g) => String(g.name).toLowerCase() === needle)
    || games.find((g) => String(g.id).toLowerCase().includes(needle) || String(g.name).toLowerCase().includes(needle))
    || null;
}

/**
 * One game's board from /api/leaderboard?game=. The arcade ranks it by the
 * points its engine awards, and only falls back to games played when the game
 * has none yet, so the header says which number the list is sorted by.
 */
function formatGameBoard(game, entries, rankedBy = 'plays') {
  const title = [game.icon, game.name].filter(Boolean).join(' ');
  const byPoints = rankedBy === 'points';
  const lines = [`🎮 **${title} top players** · ranked by ${byPoints ? 'points' : 'games played'}`];
  if (!entries.length) {
    lines.push(`_Nobody has played ${game.name} yet - open a room and take the top spot!_`);
  } else {
    entries.slice(0, 10).forEach((u, i) => {
      const plays = u.plays ?? u.score ?? 0;
      const games = `🎮 ${num(plays)} ${plays === 1 ? 'game' : 'games'}`;
      const score = byPoints ? `⭐ ${num(u.points || 0)} ${u.points === 1 ? 'point' : 'points'} · ${games}` : games;
      lines.push(`${MEDALS[i] || `**${i + 1}.**`} ${u.avatar || ''} **${u.name}** · ${score} · 🏆 ${num(u.wins || 0)} wins · Lv ${u.level}`);
    });
  }
  return lines.join('\n');
}

function boardHeader(res, { sort }) {
  const counts = res.counts || {};
  const parts = [`${res.total} idea${res.total === 1 ? '' : 's'}`];
  for (const s of STATUS_ORDER) if (counts[s]) parts.push(`${counts[s]} ${s === 'in-progress' ? 'in progress' : s}`);
  return `💡 **Idea board** · ${sort === 'new' ? 'newest first' : 'top voted'} · ${parts.join(' · ')}`;
}

function ideaLine(s, index) {
  const icon = CATEGORY_ICON[s.category] || '💬';
  const status = s.status === 'in-progress' ? 'in progress' : s.status;
  const vote = s.votes === 1 ? '▲ 1' : `▲ ${s.votes}`;
  return `**${index}.** ${vote} · ${icon} ${s.category} · *${status}* — **${oneLine(s.title, 90)}** \`${s.id}\`\n⤷ ${oneLine(s.text, 140)}`;
}

/**
 * One shipped idea. The site's changelog page is the model: the category, the
 * votes it earned, who pitched it and the note staff left when it shipped.
 */
function changelogLine(entry, index) {
  const icon = CATEGORY_ICON[entry.category] || '💬';
  const bits = [`${icon} ${entry.category}`];
  // Discord renders <t:seconds:R> as "2 days ago", the site's own wording.
  const shipped = Math.floor(Number(entry.shippedAt) / 1000);
  if (Number.isFinite(shipped) && shipped > 0) bits.push(`shipped <t:${shipped}:R>`);
  bits.push(`▲ ${entry.votes || 0}`, `by ${oneLine(entry.fromName || 'someone', 24)}`);
  const lines = [`**${index}.** ${bits.join(' · ')} — **${oneLine(entry.title, 90)}**\n⤷ ${oneLine(entry.text, 140)}`];
  if (entry.note) lines.push(`🛡️ ${oneLine(entry.by || 'staff', 24)}: ${oneLine(entry.note, 120)}`);
  return lines.join('\n');
}

/** The shipped-ideas list from /api/changelog, newest first. */
function formatChangelog(res) {
  const entries = res.entries || [];
  const total = res.total || 0;
  const lines = [`📦 **Changelog** · ${num(total)} idea${total === 1 ? '' : 's'} shipped · newest first`];
  if (!entries.length) {
    lines.push('_Nothing has shipped yet - vote on the idea board and the winners land here._ Vote with `/vote`, or pitch something with `/suggest`.');
  } else {
    entries.slice(0, 8).forEach((e, i) => lines.push(changelogLine(e, i + 1)));
    if (entries.length > 8) lines.push(`…and ${entries.length - 8} more - the full list is on the site.`);
  }
  const content = lines.join('\n');
  return content.length > 1900 ? `${content.slice(0, 1880)}\n…` : content;
}

function formatBoard(res, opts) {
  const lines = [boardHeader(res, opts)];
  const ideas = res.suggestions || [];
  if (!ideas.length) {
    lines.push('_No ideas match that filter yet._ Use `/suggest` to pitch the first one.');
  } else {
    ideas.slice(0, 8).forEach((s, i) => lines.push(ideaLine(s, i + 1)));
    if (ideas.length > 8) lines.push(`…and ${ideas.length - 8} more - narrow it down with \`status:\` or \`category:\`.`);
    lines.push('Vote with `/vote idea:<id>`, or add your own with `/suggest`.');
  }
  const content = lines.join('\n');
  return content.length > 1900 ? `${content.slice(0, 1880)}\n…` : content;
}

/** Public profile lookup (/api/users/:id); a 404 is a normal miss, anything else bubbles up. */
async function findPlayer(arcade, nameOrId) {
  return arcade.user(nameOrId).catch((err) => {
    if (err?.status !== 404) throw err;
    return null;
  });
}

/** A name that missed still helps: the arcade searches names the same way /leaderboard does. */
function noPlayerReply(wanted, near) {
  const names = (near?.users || []).map((u) => `**${u.name}**`);
  const safe = oneLine(wanted, 40).replace(/[*_`~|]/g, '');
  return {
    content: [
      `🔍 No arcade player matches **${safe}**.`,
      names.length ? `Did you mean ${names.join(', ')}?` : 'Check the spelling, or browse `/leaderboard` for names.',
    ].join('\n'),
    ephemeral: true,
  };
}

const UNLINKED_REPLY = [
  '🔗 **Link your account first.**',
  'Run `/link` here, then enter the code on the website: **Settings → Discord bot**.',
  'Once linked, `/arcade`, `/profile`, `/suggest` and `/vote` act as your arcade account.',
].join('\n');

/**
 * Runs one command and returns the reply. Most commands answer with text; the
 * profile commands (/arcade and /profile) answer with a single embed instead
 * (see arcadeEmbed and profileEmbed).
 * @returns {Promise<{content: string, embeds?: object[], ephemeral: boolean}>}
 */
export async function runCommand(name, rawOptions, ctx) {
  const options = optionsToObject(rawOptions);
  const { arcade, links, user, features } = ctx;

  // A switched-off feature answers with the same notice the website shows,
  // before any validation or lookup: the board is closed, not empty.
  const needed = COMMAND_FEATURE[name];
  if (needed && features) {
    const flag = await features.off(needed);
    if (flag) return featureOffReply(needed, flag, { ephemeral: !PUBLIC_COMMANDS.has(name) });
  }

  if (name === 'ideas') {
    const sort = options.sort === 'new' ? 'new' : 'top';
    const status = options.status || 'all';
    const category = options.category || 'all';
    const res = await arcade.suggestions({ sort, status, category });
    return { content: formatBoard(res, { sort, status, category }), ephemeral: false };
  }

  if (name === 'changelog') {
    const res = await arcade.changelog();
    return { content: formatChangelog(res), ephemeral: false };
  }

  if (name === 'arcade') {
    /** One reply builder for both paths; the catalog lookup never breaks it. */
    const arcadeReply = async (player) => {
      const byGame = Object.entries(player.stats?.byGame || {}).sort((a, b) => b[1] - a[1]);
      const topGame = byGame[0] || null;
      // The catalog only prettifies the top-game name - it must never break the reply.
      const catalog = topGame ? await arcade.catalog().catch(() => null) : null;
      return { content: '', embeds: [arcadeEmbed(player, { topGame, catalog })], ephemeral: true };
    };

    // An explicit name works for anyone - linked or not - and shows the
    // public profile, the same shape the website's player list exposes.
    const wanted = String(options.player || '').trim();
    if (wanted) {
      const found = await findPlayer(arcade, wanted);
      if (found?.user) return arcadeReply(found.user);
      const near = await arcade.players({ q: wanted, limit: 3 }).catch(() => null);
      return noPlayerReply(wanted, near);
    }

    const attempt = await links.withToken(user, (token) => arcade.botUser(token));
    if (attempt.unlinked) return { content: UNLINKED_REPLY, ephemeral: true };
    const player = attempt.value?.user;
    if (!player) return { content: '⚠️ The arcade sent back no player for that link - try `/link` again.', ephemeral: true };
    return arcadeReply(player);
  }

  if (name === 'profile') {
    /**
     * Both paths end on the public payload, because only /api/users/:id carries
     * the games-played and achievement sections.
     */
    const profileReply = async ({ user: player, recent, achievements }) => {
      const byGame = Object.entries(recent || player?.stats?.byGame || {}).sort((a, b) => b[1] - a[1]);
      // The catalog only prettifies game names - it must never break the reply.
      const catalog = byGame.length ? await arcade.catalog().catch(() => null) : null;
      return { content: '', embeds: [profileEmbed(player, { byGame, achievements, catalog })], ephemeral: true };
    };

    const wanted = String(options.player || '').trim();
    if (wanted) {
      const found = await findPlayer(arcade, wanted);
      if (found?.user) return profileReply(found);
      const near = await arcade.players({ q: wanted, limit: 3 }).catch(() => null);
      return noPlayerReply(wanted, near);
    }

    const attempt = await links.withToken(user, (token) => arcade.botUser(token));
    if (attempt.unlinked) return { content: UNLINKED_REPLY, ephemeral: true };
    const player = attempt.value?.user;
    if (!player) return { content: '⚠️ The arcade sent back no player for that link - try `/link` again.', ephemeral: true };
    // /api/bot/user proves the link but omits the profile extras, so read the
    // account's own public profile for them.
    return profileReply(await arcade.user(player.id));
  }

  if (name === 'leaderboard') {
    // Per-game mode: map whatever the player typed onto a catalog game. If the
    // catalog cannot be reached the typed value is tried as an id, so the
    // board still works.
    const wantedGame = String(options.game || '').trim();
    if (wantedGame) {
      const catalog = await arcade.catalog().catch(() => null);
      const game = findGame(catalog, wantedGame);
      if (!game && catalog) {
        const needle = wantedGame.toLowerCase();
        const near = (catalog.games || [])
          .filter((g) => String(g.id).toLowerCase().includes(needle) || String(g.name).toLowerCase().includes(needle))
          .slice(0, 3)
          .map((g) => `**${g.name}** (\`${g.id}\`)`);
        const safe = oneLine(wantedGame, 40).replace(/[*_`~|]/g, '');
        // /leaderboard defers publicly (its privacy is fixed before the
        // lookup runs), so even a correction lands in the channel.
        return {
          content: [
            `🔍 No arcade game matches **${safe}**.`,
            near.length ? `Did you mean ${near.join(', ')}?` : 'Try a game id from the site, like `pong` or `tic-tac-toe`.',
          ].join('\n'),
          ephemeral: false,
        };
      }
      const played = game || { id: wantedGame, name: oneLine(wantedGame, 40), icon: '🎮' };
      const board = await arcade.gameLeaderboard(played.id);
      return { content: formatGameBoard(played, board?.entries || [], board?.rankedBy), ephemeral: false };
    }

    const sort = ['level', 'wins', 'games'].includes(options.sort) ? options.sort : 'level';
    const res = await arcade.players({ sort, limit: 10 });
    const keep = sort === 'wins' ? (u) => (u.stats?.wins || 0) > 0
      : sort === 'games' ? (u) => (u.stats?.games || 0) > 0
      : () => true;
    return { content: formatLeaderboard((res.users || []).filter(keep), sort, res.total || 0), ephemeral: false };
  }

  if (name === 'link') {
    const existing = await links.tokenFor(user);
    if (existing) {
      const info = await arcade.botUser(existing).catch(() => null);
      const who = info?.user?.name || 'your arcade account';
      return { content: `✅ Already linked to **${who}**. Stats and ideas here show up under that name.`, ephemeral: true };
    }
    const start = await arcade.linkStart(user.id, user.username || '');
    const code = start?.code || '—';
    return {
      content: [
        '🔗 **Link your Discord account**',
        `1. Open the arcade and sign in: ${arcade.url}`,
        '2. Go to **Settings → Discord bot** and enter this code:',
        `\n   \`${code}\`\n`,
        'The code expires in 15 minutes. Then `/arcade`, `/profile`, `/suggest` and `/vote` work as you.',
      ].join('\n'),
      ephemeral: true,
    };
  }

  if (name === 'suggest') {
    const title = String(options.title || '').trim();
    const text = String(options.details || '').trim();
    if (title.length < 4) return { content: 'Give your idea a title (at least 4 characters).', ephemeral: true };
    if (text.length < 10) return { content: 'Add a little more detail (at least 10 characters).', ephemeral: true };
    const category = CATEGORY_CHOICES.some((c) => c.value === options.category) ? options.category : 'feature';
    const attempt = await links.withToken(user, (token) => arcade.createSuggestion({ title, text, category }, token));
    if (attempt.unlinked) return { content: UNLINKED_REPLY, ephemeral: true };
    const idea = attempt.value?.suggestion;
    return {
      content: [
        `✅ **Posted to the idea board!** ${CATEGORY_ICON[category] || ''}`,
        `**${idea?.title || title}** \`${idea?.id || ''}\` · ▲ ${idea?.votes ?? 1}`,
        'Your vote is already on it. See the board with `/ideas`.',
      ].join('\n'),
      ephemeral: true,
    };
  }

  if (name === 'vote') {
    const wanted = String(options.idea || '').trim().replace(/^#/, '');
    if (wanted.length < 4) return { content: 'Pass an idea id from `/ideas` (at least 4 characters).', ephemeral: true };
    const board = await arcade.suggestions({ status: 'all', sort: 'top' });
    const match = (board.suggestions || []).find((s) => s.id === wanted || s.id.startsWith(wanted));
    if (!match) return { content: `No idea matches \`${wanted}\`. Run \`/ideas\` and copy an id.`, ephemeral: true };
    const attempt = await links.withToken(user, (token) => arcade.vote(match.id, token));
    if (attempt.unlinked) return { content: UNLINKED_REPLY, ephemeral: true };
    const res = attempt.value || {};
    const verb = res.voted ? 'Upvoted' : 'Removed your vote from';
    return {
      content: `${res.voted ? '▲' : '▽'} ${verb} **${oneLine(match.title, 90)}** - now ▲ ${res.votes}.\n\`${match.id}\` · ${match.status === 'in-progress' ? 'in progress' : match.status}`,
      ephemeral: true,
    };
  }

  return { content: `Unknown command \`${name}\`.`, ephemeral: true };
}

/* ------------------------------------------------------------------ *
 * option autocomplete
 * ------------------------------------------------------------------ */

// Discord rejects the whole callback above 25 choices, so the list is capped.
const MAX_CHOICES = 25;

/** How well a catalog game matches what the player has typed; 0 means no match. */
function gameMatch(game, typed) {
  if (!typed) return 1;
  const id = String(game.id || '').toLowerCase();
  const name = String(game.name || '').toLowerCase();
  if (id === typed || name === typed) return 4;
  if (id.startsWith(typed) || name.startsWith(typed)) return 3;
  if (id.includes(typed) || name.includes(typed)) return 2;
  return 0;
}

/**
 * The choices Discord shows while an option is being typed, built from the
 * live catalog so every suggested value is a real game id. Only the option
 * Discord marks `focused` is answered - that is the option being typed - and
 * an unrecognised command or option yields none. An empty value offers the
 * catalog itself, so the option doubles as a browsable picker.
 *
 * The picker is the advertised game library, so it respects the switches too:
 * when the board itself is closed, or the owner has hidden the library from
 * players, no choices are offered - a typed id or name still reaches the board,
 * exactly like a deep link on the site still reaches a hidden page.
 *
 * Discord allows autocomplete 3 seconds and rejects a malformed callback, so
 * the caller must answer with [] rather than nothing when this throws (see
 * bot/index.js); the catalog read here is bounded to leave room for that reply.
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
export async function autocomplete(name, rawOptions, ctx) {
  const focused = (rawOptions || []).find((o) => o.focused);
  if (name !== 'leaderboard' || focused?.name !== 'game') return [];
  if (ctx.features) {
    if (await ctx.features.off('leaderboard')) return [];
    if (await ctx.features.hiddenOrOff('catalog')) return [];
  }
  const typed = String(focused.value ?? '').trim().toLowerCase();
  const catalog = await ctx.arcade.catalog({ timeoutMs: 1500 }).catch(() => null);
  return (catalog?.games || [])
    .map((game) => ({ game, score: gameMatch(game, typed) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || String(a.game.name).localeCompare(String(b.game.name)))
    .slice(0, MAX_CHOICES)
    .map(({ game }) => ({
      name: `${game.icon ? `${game.icon} ` : ''}${game.name}`.slice(0, 100),
      value: String(game.id).slice(0, 100),
    }));
}

export { formatBoard, formatChangelog, changelogLine, formatLeaderboard, formatGameBoard, findGame, ideaLine, optionsToObject };
