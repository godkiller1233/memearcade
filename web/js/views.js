/**
 * All app views.  Each view exports `render(mount, ctx)` and may register
 * cleanups in ctx.onCleanup so switching views tears down timers/hosts.
 */
import { el, btn, pill, avatar, toast, modal, fmtNum, timeAgo, confirmDialog } from './dom.js';
import { state, setSettings, isStaff, isAdmin, THEMES, KEYBIND_ACTIONS, setSettings as saveSettings } from './store.js';
import { api } from './api.js';
import { rt, partyOp, joinRoom, sendChat } from './realtime.js';
import { LocalHost, OnlineHost, seatsFor, botSeat } from './host.js';
import * as UI from '../games/engines/ui.js';

export const views = {};

/* ------------------------------------------------------------------ *
 * shared bits
 * ------------------------------------------------------------------ */

export function gameCard(game, { onPlay }) {
  const card = el('div', { class: `game-card ${game.playable ? '' : 'planned'}` },
    el('div', { class: 'row spread' },
      el('span', { class: 'icon', text: game.icon || '🎮' }),
      pill(game.playable ? `${game.players.min}${game.players.max !== game.players.min ? `-${game.players.max}` : ''} players` : 'in development', game.playable ? '' : 'warn'),
    ),
    el('strong', { text: game.name }),
    el('div', { class: 'muted small', text: game.blurb }),
    el('div', { class: 'meta-line' },
      pill(game.category),
      pill(`${game.minutes} min`),
      ...(game.tags || []).slice(0, 2).map((t) => pill(t)),
      game.discordActivity ? pill('Discord', 'good') : null,
    ),
    onPlay ? el('div', { class: 'row' },
      btn('Play', () => onPlay(game), { variant: 'primary', disabled: !game.playable }),
      btn('Details', () => showGameDetails(game), { cls: 'sm' }),
    ) : null,
  );
  return card;
}

export function showGameDetails(game) {
  const body = el('div', { class: 'col' },
    el('div', { class: 'muted', text: game.blurb }),
    el('div', { class: 'meta-line' }, pill(game.category), pill(`${game.players.min}-${game.players.max} players`), pill(`${game.minutes} min`), game.status !== 'playable' ? pill(game.status, 'warn') : null),
    game.engineMeta?.rules?.length ? el('div', {}, el('h4', { text: 'How to play' }), el('ul', {}, game.engineMeta.rules.map((r) => el('li', { text: r })))) : null,
    (game.variants || []).length ? el('div', {}, el('h4', { text: 'Variants' }),
      el('div', { class: 'option-grid' }, game.variants.map((v) => el('div', { class: 'option' }, el('strong', { text: v.name }), el('span', { class: 'option-desc', text: v.desc }))))) : null,
    (game.engineMeta?.options || []).length ? el('div', {}, el('h4', { text: 'Settings' }),
      el('div', { class: 'row' }, game.engineMeta.options.map((o) => pill(`${o.label}: ${o.default ?? 'default'}`)))) : null,
    el('div', { class: 'row' },
      btn('Play solo vs bots', () => { handle.close(); startSoloGame(game); }, { variant: 'primary', disabled: !game.playable }),
      btn('Local (pass device)', () => { handle.close(); startLocalGame(game); }, { disabled: !game.playable }),
      btn('Create online room', () => { handle.close(); createRoom(game); }, { disabled: !game.playable }),
    ),
  );
  const handle = modal(game.name, body);
}

/* ------------------------------------------------------------------ *
 * home
 * ------------------------------------------------------------------ */

views.home = (mount) => {
  const me = state.me;
  const featured = (state.server?.config?.featured || []).map((id) => state.catalog.find((g) => g.id === id)).filter(Boolean);
  const playable = state.catalog.filter((g) => g.playable);

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: `Welcome back, ${me?.name || 'player'} 👋` }),
    el('p', { class: 'muted', text: state.server?.config?.motd || 'Pick something to play.' }),
    el('div', { class: 'row' },
      btn('🎲 Surprise me', () => {
        const pick = playable[Math.floor(Math.random() * playable.length)];
        if (pick) startSoloGame(pick);
      }, { variant: 'primary' }),
      btn('🎈 Start a party', () => partyOp('create')),
      btn('🔎 Browse all games', () => window.__setView('catalog')),
    ),
  ));

  mount.appendChild(el('div', { class: 'stat-grid' },
    stat('Playable games', `${playable.length}/${state.catalog.length}`),
    stat('Your level', me?.level ?? 1),
    stat('Wins', me?.stats?.wins ?? 0),
    stat('Games played', me?.stats?.games ?? 0),
    stat('Online now', fmtNum(state.globalStats?.online ?? 0)),
    stat('Open rooms', fmtNum(state.lobby?.length ?? 0)),
  ));

  if (featured.length) {
    mount.appendChild(el('h3', { text: 'Featured' }));
    mount.appendChild(el('div', { class: 'grid cards' }, featured.map((g) => gameCard(g, { onPlay: (game) => startSoloGame(game) }))));
  }

  mount.appendChild(el('h3', { text: 'Quick plays' }));
  mount.appendChild(el('div', { class: 'grid cards' },
    playable.filter((g) => g.minutes <= 12).slice(0, 8).map((g) => gameCard(g, { onPlay: (game) => startSoloGame(game) }))));

  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: 'Play with friends' }),
    el('p', { class: 'muted', text: 'Everyone on this wifi can join with the LAN link printed by the server. Create a party, share the 4-letter code, then hit start.' }),
    el('div', { class: 'row' },
      btn('Create party', () => partyOp('create'), { variant: 'primary' }),
      btn('Join by code', () => promptJoinCode()),
      btn('Open lobby', () => window.__setView('lobby')),
    ),
    window.__lanHint ? el('p', { class: 'mono small', text: window.__lanHint }) : null,
  ));

  mount.appendChild(el('div', { class: 'card' },
    el('h3', { text: '💡 Got an idea?' }),
    el('p', { class: 'muted', text: 'Suggest a new game, a feature or an update - and vote on what everyone else wants next.' }),
    el('div', { class: 'row' },
      btn('Open the idea board', () => window.__setView('suggestions'), { variant: 'primary' }),
    ),
  ));

  mount.appendChild(el('div', { class: 'card download-hero' },
    el('span', { class: 'big-icon', text: '⬇️' }),
    el('div', { style: { flex: '1', minWidth: '220px' } },
      el('h3', { text: 'Get the desktop app' }),
      el('p', { class: 'muted', text: 'Desktop Lite is a tiny window around this website. Desktop Host ships every file, so you can host your own games and matches offline or on your wifi.' }),
    ),
    el('div', { class: 'row' },
      btn('Browse downloads', () => window.__setView('download'), { variant: 'primary' }),
    ),
  ));
};

function stat(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-num', text: String(value) }), el('div', { class: 'muted small', text: label }));
}

/* ------------------------------------------------------------------ *
 * catalog
 * ------------------------------------------------------------------ */

views.catalog = (mount) => {
  const query = { q: '', category: '' };
  const list = el('div', { class: 'grid cards' });
  const search = el('input', { class: 'input', placeholder: 'Search games…', value: query.q });
  const cats = el('div', { class: 'tabs-list' });

  const draw = () => {
    const q = query.q.trim().toLowerCase();
    const games = state.catalog.filter((g) =>
      (!query.category || g.category === query.category) &&
      (!q || g.name.toLowerCase().includes(q) || (g.tags || []).some((t) => t.toLowerCase().includes(q))));
    list.replaceChildren(...games.map((g) => gameCard(g, {
      onPlay: (game) => {
        if (game.modes.includes('solo') && game.players.min <= 1) return startSoloGame(game);
        showPlayOptions(game);
      },
    })));
    if (!games.length) list.appendChild(el('div', { class: 'muted', text: 'No games match that search.' }));
  };

  const categories = [...new Set(state.catalog.map((g) => g.category))];
  cats.appendChild(btn('All', () => { query.category = ''; draw(); }, { cls: 'sm' }));
  for (const c of categories) cats.appendChild(btn(c, () => { query.category = c; draw(); }, { cls: 'sm' }));
  search.addEventListener('input', () => { query.q = search.value; draw(); });

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Games' }),
    el('p', { class: 'muted', text: `${state.catalog.filter((g) => g.playable).length} ready to play right now - the rest are on the roadmap and appear greyed out.` }),
    el('div', { class: 'row' }, search, ...cats.children),
  ));
  mount.appendChild(list);
  draw();
};

function showPlayOptions(game) {
  const body = el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'How do you want to play?' }),
    el('div', { class: 'option-grid' },
      optionCard('Solo vs bots', 'You against the house AI. Jump straight in.', () => { handle.close(); startSoloGame(game); }),
      optionCard('Local hot-seat', 'Several players sharing this device.', () => { handle.close(); startLocalGame(game); }),
      optionCard('Online room', 'Create a room and share the code - or let a party carry you in.', () => { handle.close(); createRoom(game); }),
    ),
  );
  const handle = modal(`Play ${game.name}`, body);
}

function optionCard(title, desc, onClick) {
  return el('button', { class: 'option', onClick: onClick },
    el('strong', { text: title }), el('span', { class: 'option-desc', text: desc }), el('span', { class: 'pill', text: 'Start →' }));
}

/* ------------------------------------------------------------------ *
 * game launching (solo / local / online)
 * ------------------------------------------------------------------ */

export async function loadEngine(gameId) {
  const mod = await import('../games/engines/registry-loader.js');
  return mod.loadEngine(gameId);
}

export async function startSoloGame(game) {
  const engine = await loadEngine(game.engine || game.id);
  if (!engine) return toast(`${game.name} is still in development.`, 'warn');
  window.__mountGame({ mode: 'solo', game, engine });
}

export async function startLocalGame(game) {
  const engine = await loadEngine(game.engine || game.id);
  if (!engine) return toast(`${game.name} is still in development.`, 'warn');
  const body = el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'How many humans are sharing this device? Bots fill the remaining seats.' }),
    el('div', { class: 'row' },
      ...[2, 3, 4].map((n) => btn(`${n} players`, () => {
        handle.close();
        window.__mountGame({ mode: 'local', game, engine, humans: n });
      })),
    ),
  );
  const handle = modal(`Local play - ${game.name}`, body);
}

export function joinGameRoom(game) {
  createRoom(game);
}

export async function createRoom(game, options = {}) {
  state.localGame = null;
  joinRoom({ gameId: game.engine || game.id, options, fillBots: !!options.fillBots, botLevel: 2 });
  window.__setView('play');
}

export async function startBotRoom(game) {
  state.localGame = null;
  joinRoom({ gameId: game.engine || game.id, fillBots: true, options: {} });
  window.__setView('play');
}

/* ------------------------------------------------------------------ *
 * lobby
 * ------------------------------------------------------------------ */

views.lobby = (mount) => {
  const rooms = state.lobby || [];
  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Lobby' }),
    el('p', { class: 'muted', text: 'Open rooms right now. Join one, or start your own from the Games tab.' }),
    el('div', { class: 'row' },
      btn('Refresh', () => rt.send({ t: 'lobby' }), { cls: 'sm' }),
      btn('Join by code', () => promptJoinCode()),
      state.party ? btn('Start party game', () => partyOp('start'), { variant: 'primary' }) : null,
    ),
  ));

  if (!rooms.length) {
    mount.appendChild(el('div', { class: 'card muted', text: 'No public rooms are open. Be the host - pick any game and create a room.' }));
  }
  for (const room of rooms) {
    mount.appendChild(el('div', { class: 'room-row' },
      el('span', { text: room.game?.icon || '🎮' }),
      el('div', { class: 'name' },
        el('strong', { text: room.game?.name || room.gameId }),
        el('div', { class: 'muted small', text: `host ${room.host} · ${room.status} · ${room.players.length} players${room.spectators ? ` · ${room.spectators} watching` : ''}` }),
      ),
      pill(room.code),
      room.status === 'playing'
        ? btn('Spectate', () => { rt.send({ t: 'room', op: 'spectate', roomId: room.id }); window.__setView('play'); }, { cls: 'sm' })
        : btn('Join', () => { state.localGame = null; rt.send({ t: 'room', op: 'join', roomId: room.id }); window.__setView('play'); }, { variant: 'primary', cls: 'sm' }),
    ));
  }
};

export function promptJoinCode() {
  const input = el('input', { class: 'input', placeholder: 'Room or party code', maxlength: 12 });
  const handle = modal('Join by code', el('div', { class: 'col' }, input,
    el('div', { class: 'row' },
      btn('Join room', () => { state.localGame = null; rt.send({ t: 'room', op: 'join', code: input.value.trim().toUpperCase() }); handle.close(); window.__setView('play'); }, { variant: 'primary' }),
      btn('Join party', () => { partyOp('join', { code: input.value.trim().toUpperCase() }); handle.close(); }),
    )));
  setTimeout(() => input.focus(), 30);
}

/* ------------------------------------------------------------------ *
 * room helpers (the room shell itself lives in main.js, next to the stage)
 * ------------------------------------------------------------------ */

/** Copy an invite link, falling back to showing it when the clipboard is blocked. */
function copyInvite(link, label) {
  navigator.clipboard?.writeText(link).then(() => toast(`${label} copied!`, 'good'), () => toast(link));
}

export function shareRoom(room) {
  copyInvite(`${location.origin}/?room=${room.code}`, 'Room invite link');
}

export function shareParty(party) {
  copyInvite(`${location.origin}/?party=${party.code}`, 'Party invite link');
}

/* ------------------------------------------------------------------ *
 * friends
 * ------------------------------------------------------------------ */

views.friends = (mount) => {
  const accepted = state.friends.filter((f) => f.friendStatus === 'accepted');
  const incoming = state.friends.filter((f) => f.friendStatus === 'pending' && f.direction === 'incoming');
  const outgoing = state.friends.filter((f) => f.friendStatus === 'pending' && f.direction === 'outgoing');
  const name = el('input', { class: 'input', placeholder: 'Username' });

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Friends' }),
    el('div', { class: 'row' }, name, btn('Send request', () => {
      const value = name.value.trim();
      if (!value) return;
      rt.send({ t: 'friend', op: 'request', name: value });
      name.value = '';
    }, { variant: 'primary' }),
      btn('Open chat', () => window.__setView('chat'), { cls: 'sm' })),
  ));

  if (incoming.length) {
    mount.appendChild(el('h3', { text: `Requests (${incoming.length})` }));
    mount.appendChild(el('div', { class: 'col' }, incoming.map((f) => friendRow(f, [
      btn('Accept', () => rt.send({ t: 'friend', op: 'accept', userId: f.id }), { variant: 'primary', cls: 'sm' }),
      btn('Decline', () => rt.send({ t: 'friend', op: 'remove', userId: f.id }), { cls: 'sm' }),
    ]))));
  }
  if (outgoing.length) {
    mount.appendChild(el('h3', { text: 'Waiting for them' }));
    mount.appendChild(el('div', { class: 'col' }, outgoing.map((f) => friendRow(f, [
      btn('Cancel', () => rt.send({ t: 'friend', op: 'remove', userId: f.id }), { cls: 'sm' }),
    ]))));
  }
  mount.appendChild(el('h3', { text: `All friends (${accepted.length})` }));
  if (!accepted.length) mount.appendChild(el('div', { class: 'card muted', text: 'No friends yet - add someone by username above.' }));
  mount.appendChild(el('div', { class: 'col' }, accepted.map((f) => friendRow(f, [
    btn('DM', () => { window.__openDm(f.id); }, { cls: 'sm' }),
    btn('Invite', () => { partyOp('invite', { userId: f.id }); toast(`Invited ${f.name}`, 'good'); }, { cls: 'sm' }),
    btn('Remove', () => confirmDialog('Remove friend', `Remove ${f.name} from your friends?`, () => rt.send({ t: 'friend', op: 'remove', userId: f.id })), { cls: 'sm' }),
  ]))));
};

function friendRow(f, actions) {
  return el('div', { class: 'friend-row' },
    el('span', { class: `presence ${f.presence || 'offline'}` }),
    avatar(f),
    el('div', { class: 'name' },
      el('strong', { text: f.name }),
      el('div', { class: 'muted small', text: `level ${f.level} · ${f.presence || 'offline'} · ${f.stats?.wins || 0} wins` }),
    ),
    ...actions,
  );
}

/* ------------------------------------------------------------------ *
 * chat
 * ------------------------------------------------------------------ */

/** Party chat is broadcast under `party:<id>`; the tab speaks `party`. */
const chatScopeKey = (scope) => (scope === 'party' && state.party?.id ? `party:${state.party.id}` : scope);

views.chat = (mount) => {
  const scope = state.chatScope || 'global';
  const target = state.chatTarget;
  const messages = scope === 'dm' && target ? (state.dms[target] || []) : (state.messages[chatScopeKey(scope)] || []);
  const body = el('div', { class: 'chat-list', style: { maxHeight: '48vh' } });
  const input = el('input', { class: 'input', placeholder: 'Write a message…' });

  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChat(scope, text, scope === 'dm' ? target : null);
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });

  const tabs = el('div', { class: 'tabs-list' },
    chatTab('global', 'Global', scope, target),
    chatTab('party', 'Party', scope, target),
    ...state.conversations.slice(0, 8).map((c) => chatTab('dm', c.name, scope, target, c.userId)),
  );

  const draw = () => {
    const list = state.chatScope === 'dm' && state.chatTarget ? (state.dms[state.chatTarget] || []) : (state.messages[chatScopeKey(state.chatScope)] || []);
    // System lines (joins, departures) have no author: a name would be a lie.
    body.replaceChildren(...list.slice(-120).map((m) => el('div', { class: `chat-line ${m.kind || ''}` },
      m.kind === 'system' ? null : el('b', { class: 'chat-name', text: m.name || (m.from === state.me?.id ? 'you' : '???') }),
      el('span', { class: 'chat-text', text: m.text }),
      el('span', { class: 'muted small', text: new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))));
    body.scrollTop = body.scrollHeight;
  };

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Chat' }),
    tabs,
    body,
    el('div', { class: 'input-row' }, input, btn('Send', send, { variant: 'primary' })),
    el('p', { class: 'muted small', text: 'Global chat is open to everyone online. DMs go to friends only (they can change that in Settings → Privacy).' }),
  ));
  draw();
  window.__redrawChat = draw;
};

function chatTab(scope, label, currentScope, currentTarget, targetId = null) {
  const on = scope === currentScope && (scope !== 'dm' || targetId === currentTarget);
  return btn(label, () => {
    state.chatScope = scope;
    state.chatTarget = scope === 'dm' ? targetId : null;
    window.__setView('chat');
  }, { cls: `sm ${on ? 'primary' : ''}` });
}

export { UI };

/* The profile / settings / admin / download views live in their own modules
   (they pull in audio + admin APIs the play views never need).  Registering
   them here keeps the router in main.js to a single lookup table. */
function register(names, mod, map) {
  const wanted = names.some((n) => state.view === n);
  for (const [name, key] of Object.entries(map)) views[name] = mod[key];
  // Only redraw when the user is already looking at a view we just provided -
  // and only once, or a view that mounts asynchronously renders twice.
  if (wanted && !views.__lateRendered) {
    views.__lateRendered = true;
    queueMicrotask(() => window.__render?.());
  }
}

import('./views-settings.js').then((m) => register(['profile', 'settings'], m, {
  profile: 'profileView', settings: 'settingsView',
}));
import('./views-admin.js').then((m) => register(['admin'], m, { admin: 'adminView' }));
import('./views-suggestions.js').then((m) => register(['suggestions'], m, { suggestions: 'suggestionsView' }));
import('./views-changelog.js').then((m) => register(['changelog'], m, { changelog: 'changelogView' }));
import('./views-download.js').then((m) => register(['download'], m, { download: 'downloadView' }));
