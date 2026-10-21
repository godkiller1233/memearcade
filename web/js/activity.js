/**
 * Discord Activity shell.
 *
 * The Activity is the same website in an iframe: this module only handles the
 * part that differs.
 *
 *   1. Sign in through Discord's Embedded App SDK (the client secret stays on
 *      the server - see server/lib/discord-activity.js).
 *   2. Turn that Discord identity into an ordinary arcade session, so every
 *      game, room and stat works exactly as it does on the website.
 *   3. Auto-join the room for this Activity instance. Discord gives everyone
 *      who opens the same Activity the same instance id, so there is no join
 *      code to read out - and when the host picks a game, the others follow.
 *
 * Opened outside Discord (a curious owner pasting the URL in a browser) it
 * explains how to launch it instead of hanging on an SDK handshake that can
 * never complete.
 */
import { $, el, btn, pill, toast } from './dom.js';
import { api } from './api.js';
import { state, setMe, saveLocal } from './store.js';
import { rt } from './realtime.js';
import { views } from './views.js';

const params = new URLSearchParams(location.search);

/** The page the Developer Portal entry point points at. */
export const ACTIVITY_PAGE = location.pathname.replace(/\/+$/, '') === '/activity';

/**
 * A real Activity frame. The SDK reads all of these from the query string and
 * throws without them, so they are the honest test - an ordinary iframe of the
 * site is not an Activity.
 */
export const ACTIVITY_FRAME = params.has('frame_id') && params.has('instance_id');

/** True once bootActivity() has a Discord session and an arcade one. */
export function activityMode() {
  return !!activity;
}

let activity = null;
let pollTimer = null;
/** True while this player is held for the next round instead of playing. */
let waitingNextRound = false;

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function notice(title, lines, actions = []) {
  const boot = $('#boot');
  boot?.classList.remove('hidden');
  $('#boot-status').textContent = title;
  $('#boot-detail').textContent = lines.filter(Boolean).join('\n');
  const box = $('#boot-actions');
  if (box) box.replaceChildren(...actions);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} took too long - Discord did not answer.`)), ms)),
  ]);
}

/**
 * Brings the Activity up. Returns true when the app shell should start; on any
 * failure it paints the reason into the boot card and returns false, because a
 * blank frame with a spinner is the worst possible answer.
 */
export async function bootActivity(meta) {
  if (!ACTIVITY_FRAME) {
    notice(
      '🕹️ Memes Arcade in Discord',
      [
        'This page is the Discord Activity - it runs inside Discord, next to your voice channel.',
        '',
        'To play: add the bot to a server, then run /play in any text or voice channel.',
        'Everyone who opens the Activity from that message joins the same room automatically.',
      ],
      [btn('Open the arcade instead', () => { location.href = '/'; }, { variant: 'primary' })],
    );
    return false;
  }

  const config = meta?.config?.discordActivity;
  if (!config?.enabled) {
    const missing = config?.missing?.length ? config.missing.join(' and ') : 'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET';
    notice(
      'Discord Activities are not set up yet',
      [
        'This arcade has not been given its Discord app credentials, so it cannot finish signing you in.',
        '',
        `An admin needs to set ${missing} on the server (Developer Portal → OAuth2), then redeploy.`,
      ],
      [btn('Open the arcade in a browser', () => { location.href = '/'; })],
    );
    return false;
  }

  let DiscordSDK;
  try {
    ({ DiscordSDK } = await import('/vendor/discord-sdk/index.mjs'));
  } catch (err) {
    notice('The Discord SDK could not load', [
      'The arcade could not fetch its Discord client library, so the Activity cannot start.',
      String(err?.message || err || ''),
    ], [btn('Try again', () => location.reload(), { variant: 'primary' })]);
    return false;
  }

  try {
    const sdk = new DiscordSDK(config.clientId);
    await withTimeout(sdk.ready(), 20000, 'The Discord handshake');

    const { code } = await withTimeout(sdk.commands.authorize({
      client_id: config.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    }), 30000, 'Discord sign-in');

    // Only the server can turn that code into a token: it holds the secret.
    const exchanged = await api.post('/api/discord/activity/token', { code });
    const accessToken = exchanged?.access_token;
    if (!accessToken) throw new Error('Discord did not return an access token.');

    // Hand the token back to Discord so the frame is authenticated...
    const auth = await withTimeout(sdk.commands.authenticate({ access_token: accessToken }), 20000, 'Discord authentication');
    // ...and give the same proof to the arcade, which checks it with Discord
    // itself and returns a normal session for this player.
    const session = await api.post('/api/discord/activity/session', {
      access_token: accessToken,
      instanceId: sdk.instanceId,
      channelId: sdk.channelId,
      guildId: sdk.guildId,
    });
    if (!session?.token) throw new Error('The arcade did not return a session.');

    state.token = session.token;
    setMe(session.user);
    saveLocal();
    document.body.classList.add('activity-mode');
    document.documentElement.dataset.activity = '1';

    activity = {
      sdk,
      instanceId: sdk.instanceId,
      channelId: sdk.channelId,
      guildId: sdk.guildId,
      discord: session.discord || { id: auth?.user?.id, username: auth?.user?.username },
      account: session.user,
    };
    // The SDK can tell us when someone joins or leaves, but participants are
    // also just players in the room - the roster already shows them.
    return true;
  } catch (err) {
    notice('Could not start the Activity', [
      String(err?.message || err || 'Discord sign-in failed.'),
      '',
      'Closing the Activity and opening it again usually fixes a stale sign-in.',
    ], [
      btn('Try again', () => location.reload(), { variant: 'primary' }),
      btn('Open the arcade in a browser', () => { location.href = '/'; }),
    ]);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * the instance room
 * ------------------------------------------------------------------ */

/**
 * Keep this client on the room for its Activity instance. Polling is the point:
 * the room may not exist yet (the host has not picked a game), or the host may
 * have switched games, which closes the old room and opens a new one. A repeat
 * call while seated is a no-op on the server.
 */
export function startActivitySync() {
  clearInterval(pollTimer);
  const tick = () => {
    if (!activity || !rt.open) return;
    rt.send({ t: 'room', op: 'instance', instanceId: activity.instanceId });
  };
  pollTimer = setInterval(tick, 3000);
  const soon = setInterval(() => {
    if (rt.open) {
      clearInterval(soon);
      tick();
    }
  }, 200);
  setTimeout(() => clearInterval(soon), 20000);
}

/** Host picks a game, or switches the room to another one. */
export function requestGame(gameId) {
  if (!activity) return;
  rt.send({ t: 'room', op: 'instance', instanceId: activity.instanceId, gameId });
}

function showView(name) {
  if (typeof window.__setView === 'function') window.__setView(name);
}

rt.on('room:instance', (msg) => {
  // No room yet in this Activity: show the picker instead of an empty stage.
  if (!msg?.room && state.view !== 'activity') showView('activity');
});

// A player held for the next round is seated by the server at the start of
// it; the first `game` message without `waiting` is that moment, and it should
// not look like the board simply appeared.
rt.on('game', (msg) => {
  if (!activity) return;
  const wasWaiting = waitingNextRound;
  waitingNextRound = !!msg?.waiting;
  if (wasWaiting && !waitingNextRound && msg?.room?.players?.some((p) => p.id === state.me?.id)) {
    toast('Your seat is ready - the next round is starting.', 'good', 4000);
  }
});

/* ------------------------------------------------------------------ *
 * the picker
 * ------------------------------------------------------------------ */

views.activity = (mount) => {
  const room = state.room;
  const mine = room && room.host === state.me?.id;
  const games = (state.catalog || []).filter((game) => game.playable);

  // The round was already running when this player opened the Activity: they
  // are queued for the next one.  Say so plainly instead of dropping them into
  // a spectator view of a match they cannot influence.
  const queue = room?.waiting || [];
  const place = queue.findIndex((w) => w.id === state.me?.id);
  if (room && place >= 0) {
    const live = room.status === 'playing';
    mount.appendChild(el('div', { class: 'card activity-waiting' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' },
          el('span', { class: 'icon', text: room.game?.icon || '🎮' }),
          el('h2', { text: room.game?.name || 'Game' }),
          pill('next round')),
        pill(`#${place + 1} in line`)),
      el('p', { text: live
        ? `A round is already running with ${room.players?.length || 0} players, so you are waiting for the next one.`
        : 'Every seat is taken right now, so you are waiting for the next one.' }),
      el('p', { class: 'muted', text: 'Nothing to do: the host starting the next round puts you in a seat automatically.' }),
      queue.length > 1
        ? el('p', { class: 'muted small', text: `Also waiting: ${queue.filter((w) => w.id !== state.me?.id).map((w) => w.name).join(', ')}.` })
        : null,
      el('p', { class: 'muted small', text: activityMode()
        ? 'You can leave this Activity open - Discord keeps it here next to the channel.'
        : 'Leave this page open; the next round picks you up.' }),
    ));
    return;
  }

  // Already in a game: offer the way back, and only the host may replace it.
  if (room && !mine) {
    mount.appendChild(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' },
          el('span', { class: 'icon', text: room.game?.icon || '🎮' }),
          el('h2', { text: room.game?.name || 'Game' }),
          pill(room.status)),
        btn('↩ Back to the game', () => showView('play'), { cls: 'sm', variant: 'primary' })),
      el('p', { class: 'muted', text: 'The host picked this game. When they change it, everyone here moves with them.' }),
    ));
    return;
  }

  mount.appendChild(el('div', { class: 'card' },
    el('div', { class: 'row spread' },
      el('div', { class: 'row' },
        el('h2', { text: room ? '🔄 Change the game' : '🎮 Pick a game' }),
        pill(room ? 'host' : 'waiting')),
      room ? btn('↩ Back to the game', () => showView('play'), { cls: 'sm' }) : null),
    el('p', { class: 'muted', text: room
      ? 'Picking another game closes this room and opens a new one; everyone in the Activity follows automatically.'
      : 'Everyone who opens this Activity joins the same room - no code to share. Pick a game to start it.' }),
    games.length
      ? el('div', { class: 'activity-games' }, games.map((game) => el('button', {
          class: 'btn activity-game',
          title: `${game.blurb || ''} · ${game.players?.min ?? 2}-${game.players?.max ?? 8} players`,
          onClick: () => requestGame(game.id),
        },
        el('span', { class: 'icon', text: game.icon || '🎮' }),
        el('span', { class: 'activity-game-name', text: game.name }),
        el('span', { class: 'muted small', text: `${game.players?.min ?? 2}-${game.players?.max ?? 8} 👤` }))))
      : el('p', { class: 'muted', text: 'No games are playable right now - an owner may have switched them off.' }),
  ));
};

/* ------------------------------------------------------------------ *
 * the bar
 * ------------------------------------------------------------------ */

/**
 * A slim strip over the game, because the website's navigation is hidden in an
 * Activity. It says which game the Activity is on and gives the host the one
 * action that only makes sense here: change it.
 */
export function mountActivityBar() {
  if (!activityMode() || $('#activity-bar')) return;
  const bar = el('div', { class: 'activity-bar', id: 'activity-bar' });
  document.body.appendChild(bar);
  let last = '';
  const paint = () => {
    const room = state.room;
    // Changing the game closes the room, so it is a lobby action only - not a
    // button that could end a match by accident.
    const mine = room && room.host === state.me?.id && room.status !== 'playing';
    const queued = !!(room?.waiting || []).some((w) => w.id === state.me?.id);
    const waiting = room?.waiting?.length || 0;
    const text = room
      ? queued
        ? `⏳ ${room.game?.name || 'Game'} · waiting for the next round`
        : `${room.game?.icon || '🎮'} ${room.game?.name || 'Game'} · ${room.players?.length || 0} in the room${room.status === 'playing' ? ' · live' : ''}${waiting ? ` · ${waiting} waiting` : ''}`
      : '🕹️ Memes Arcade · no game yet';
    const key = `${text}|${mine}|${room ? 'r' : 'n'}`;
    if (key === last) return;
    last = key;
    bar.replaceChildren(
      el('span', { class: 'activity-bar-text', text }),
      mine ? btn('🔄 Change game', () => showView('activity'), { cls: 'sm' }) : null,
    );
  };
  paint();
  setInterval(paint, 1000);
  rt.on('game', paint);
  rt.on('room:closed', paint);
}

/**
 * A little Discord-flavoured greeting once the room is live, so the first
 * person in knows what to do without reading the site.
 */
export function activityWelcome() {
  if (!activityMode()) return;
  const created = activity.account?.name;
  toast(`Signed in as ${created || 'your Discord account'}${activity.discord?.name ? ` (${activity.discord.name})` : ''}`, 'good', 4000);
}
