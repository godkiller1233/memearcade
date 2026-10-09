/**
 * Memes Arcade client bootstrap.
 * Boot -> compatibility check -> session restore -> auth or app shell,
 * then a small router drives the views while the WebSocket keeps state fresh.
 */
import { $, el, clear, btn, pill, avatar, toast, modal, fmtNum } from './dom.js';
import {
  state, loadLocal, saveLocal, applyTheme, cycleTheme, notify, onChange, setSettings,
  setMe, merge, isStaff, isAdmin, resetClientState, setServerConfig, featureOn, featureHidden, featureRaw,
  CLIENT_VERSION,
} from './store.js';
import { api, fetchMeta, restoreSession, login, register, guest, logout, loadCatalog, isSignedIn } from './api.js';
import { rt, sendChat, addBot, startRoom } from './realtime.js';
import { views, startSoloGame, promptJoinCode, shareRoom, shareParty } from './views.js';
import { LocalHost, OnlineHost, seatsFor } from './host.js';
import { roomAlertText } from './netcode.js';
import { unlockAudio, toggleMusic, sfx, currentTrack } from './audio.js';
import { loadEngine } from '../games/engines/registry-loader.js';
import { watchBuilds } from './build-watch.js';

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

async function boot() {
  loadLocal();
  applyTheme();
  const status = $('#boot-status');
  const detail = $('#boot-detail');
  try {
    const meta = await fetchMeta();
    status.textContent = `${meta.app} v${meta.appVersion} · API v${meta.apiVersion}`;
    detail.textContent = `${meta.counts?.playable ?? 0} games playable · ${meta.counts?.registered ?? 0} accounts · ${meta.counts?.online ?? 0} online`;
    state.catalog = meta.catalog || [];
    state.categories = [...new Set(state.catalog.map((g) => g.category))];
    setServerConfig(meta.config);
    // Remember the build this page booted with and start watching for a newer
    // one (see the live-builds section below).
    loadedBuild = String(meta.config?.build || '');
    startBuildWatch();
    const restoreNote = document.createElement('div');
    restoreNote.className = 'muted small';
    restoreNote.textContent = meta.degraded?.length ? `Compatibility: ${meta.degraded.join(', ')}` : 'Compatibility: full';
    detail.appendChild(restoreNote);
  } catch (err) {
    const upgrade = err.status === 426 || err.payload?.upgrade;
    status.textContent = upgrade ? 'This client is out of date' : 'Cannot reach the arcade server';
    detail.textContent = upgrade
      ? `${err.message}\n\nThis build is v${CLIENT_VERSION}; the server needs a newer one. Reload to pick up the latest files.`
      : `${err.message}\n\nStart it with:  npm start\nThen reload this page.\n(check data/boot.log if it refuses to start)`;
    const actions = $('#boot-actions');
    actions.replaceChildren(
      btn(upgrade ? 'Reload client' : 'Retry', () => location.reload(), { variant: 'primary' }),
      btn('Open API status', () => window.open('/api/meta', '_blank'), { cls: 'sm' }),
    );
    return;
  }

  try {
    await restoreSession();
  } catch {}

  $('#boot').classList.add('hidden');
  if (state.me && isSignedIn()) startApp();
  else showAuth();
}

/* ------------------------------------------------------------------ *
 * auth screen
 * ------------------------------------------------------------------ */

let authMode = 'login';

function showAuth() {
  $('#auth').classList.remove('hidden');
  $('#boot').classList.add('hidden');
  const form = $('#auth-form');
  const name = $('#auth-name');
  const pass = $('#auth-pass');
  const error = $('#auth-error');
  const submit = $('#auth-submit');
  $('#auth-footer').textContent = `Client v${CLIENT_VERSION} · server API v${state.server?.apiVersion ?? '?'}`;

  for (const tab of document.querySelectorAll('[data-auth-tab]')) {
    tab.onclick = () => {
      authMode = tab.dataset.authTab;
      for (const t of document.querySelectorAll('[data-auth-tab]')) t.classList.toggle('on', t === tab);
      submit.textContent = authMode === 'login' ? 'Sign in' : 'Create account';
      error.textContent = '';
    };
  }
  $('#auth-guest').onclick = async () => {
    try {
      await guest();
      saveLocal();
      startApp();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  $('#auth-theme').onclick = () => {
    cycleTheme();
    $('#auth-theme').textContent = `🎨 ${state.settings.theme}`;
  };
  $('#auth-download').onclick = () => {
    $('#auth').classList.add('hidden');
    pendingRoomInvite = null; // they chose the download page over the invite
    pendingPartyInvite = null;
    startApp();
    setView('download');
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      if (authMode === 'login') await login(name.value, pass.value);
      else await register(name.value, pass.value);
      saveLocal();
      sfx('join');
      startApp();
    } catch (err) {
      error.textContent = err.message;
      sfx('error');
    } finally {
      submit.disabled = false;
    }
  };
  window.addEventListener('keydown', unlockAudio, { once: true });
  window.addEventListener('pointerdown', unlockAudio, { once: true });
}

/* ------------------------------------------------------------------ *
 * app shell
 * ------------------------------------------------------------------ */

function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const invites = consumeInviteLinks();
  pendingRoomInvite = invites.room;
  pendingPartyInvite = invites.party;
  rt.connect(state.token);
  loadCatalog()
    .then(() => {
      notify();
      renderApp();
    })
    .catch(() => {});
  renderApp();
  // /admin deep link: opens the console once the user is signed in.  A
  // non-staff account sees the panel's polite "staff only" card.
  if (/\/admin\/?$/.test(location.pathname)) setView('admin');
}

/** Views that subscribe to idea-board pings (the changelog shares them). */
const BOARD_VIEWS = new Set(['suggestions', 'changelog']);

/**
 * Which feature owns a view.  Only these views are ever gated: a player whose
 * arcade has the feature switched off sees the nav entry disappear (see
 * renderApp) and a "turned off" card if they reach the view through a deep
 * link, instead of a screen the server would refuse to fill.
 */
const VIEW_FEATURE = {
  catalog: 'catalog',
  lobby: 'lobby',
  chat: 'chat',
  friends: 'friends',
  suggestions: 'suggestions',
  changelog: 'changelog',
  download: 'downloads',
};

const VIEW_LABEL = {
  catalog: 'The game library',
  lobby: 'The lobby',
  chat: 'Chat',
  friends: 'Friends',
  suggestions: 'The idea board',
  changelog: 'The changelog',
  download: 'Desktop downloads',
};

export function setView(name) {
  // Stop the idea-board pings once we leave those views (the socket is shared).
  if (BOARD_VIEWS.has(state.view) && !BOARD_VIEWS.has(name)) rt.send({ t: 'suggestions', watching: false });
  state.view = name;
  saveLocal();
  renderApp();
}

export function renderApp() {
  const me = state.me;
  $('#me-chip').replaceChildren(avatar(me, 26), el('span', { class: 'small', text: me?.name || '' }));
  $('#logout').onclick = async () => {
    if (state.room) rt.send({ t: 'room', op: 'leave' });
    await logout();
    rt.disconnect();
    location.reload();
  };
  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.view === state.view);
    tab.onclick = () => setView(tab.dataset.view);
  });
  // Hiding is per-viewer (staff keep every tab), so it is applied here rather
  // than baked into the markup.  Anything marked data-feature in index.html -
  // nav tabs, sidebar blocks, the music button - follows its switch.
  document.querySelectorAll('[data-feature]').forEach((node) => {
    node.classList.toggle('hidden', featureHidden(node.dataset.feature));
  });
  $('.admin-only')?.classList.toggle('hidden', !isStaff());
  refreshAdminBadge();
  drawAnnouncement();

  renderStatus();
  $('#status-version').textContent = `v${CLIENT_VERSION} / api v${state.server?.apiVersion ?? '?'}`;

  const view = $('#view');
  // While a game is live we keep its DOM (and the engines' timers) intact -
  // re-rendering the shell must never restart a match in progress. The host has
  // to still belong to whatever is on screen: an online room uses onlineHost, a
  // solo/hot-seat match needs a localGame descriptor.
  const keepGame = state.view === 'play' && !!activeHost && !activeHost.disposed
    && (state.room ? activeHost === onlineHost : !!state.localGame);
  if (!keepGame) {
    if (state.view !== 'play' && activeHost) {
      activeHost.dispose();
      activeHost = null;
      onlineHost = null;
    }
    clear(view);
  }
  const target = state.view === 'play' ? 'play' : state.view;
  const owner = VIEW_FEATURE[target];
  if (!keepGame) {
    if (owner && !featureOn(owner)) view.appendChild(turnedOffCard(owner));
    else (views[target] || views.home)(view);
  }
  renderSidebar();
  $('#nav-toggle').onclick = () => $('.nav.tabs')?.classList.toggle('open');
  $('#theme-toggle').onclick = () => { const t = cycleTheme(); toast(`Theme: ${t}`, '', 1500); };
  $('#music-toggle').onclick = () => {
    const on = toggleMusic();
    $('#music-toggle').textContent = on ? '🔊' : '🔇';
    setSettings({ audio: { music: on } }, { persist: false });
  };
  $('#music-toggle').textContent = state.settings.audio.music ? '🔊' : '🔇';
}

/**
 * The announcement banner: pushed by broadcasts and site settings, and the one
 * config change that never needs the shell rebuilt.
 */
function drawAnnouncement() {
  const ann = $('#announcement');
  const text = state.serverConfig?.announcement;
  ann.classList.toggle('hidden', !text);
  if (text) ann.textContent = `📣 ${text}`;
}

/** Who a keep-floor keeps, in a player's words (the server sends the rung). */
const KEPT_FOR = { user: 'signed-in players', vip: 'VIPs', mod: 'staff', admin: 'admins', owner: 'the arcade owner' };

/** The polite door for a switched-off feature reached by deep link. */
function turnedOffCard(feature) {
  const label = VIEW_LABEL[feature] || 'This part of the arcade';
  // A scheduled close carries the reopen time, so the notice says when it comes
  // back instead of implying an owner is sitting there with a switch.  A
  // keep-floor above this account says who *does* still get it, so a player
  // does not read the arcade as broken while VIPs are using the feature.
  const raw = featureRaw(feature);
  const until = raw.scheduled && raw.until ? new Date(raw.until) : null;
  const opens = until && !Number.isNaN(until.getTime()) ? until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const kept = raw.minRole && raw.minRole !== 'mod' ? KEPT_FOR[raw.minRole] : null;
  return el('div', { class: 'card' },
    el('h1', { text: '🚪 Turned off' }),
    el('p', { class: 'muted', text: opens
      ? `${label} is closed until ${opens} - the arcade owner scheduled these hours, and it reopens on its own.`
      : kept
        ? `${label} is kept for ${kept} - it is turned off for this account.`
        : `${label} has been switched off by the arcade owner.` }),
    el('div', { class: 'row' },
      btn('Back home', () => setView('home'), { variant: 'primary' }),
      btn('Games', () => setView('catalog'), { cls: 'sm' })));
}

/** Status bar: connection dot, the room chip (a real way back into a room
 *  you navigated away from), and lobby counts. */
let statusRoomKey = null;
function renderStatus() {
  const conn = $('#status-connection');
  if (conn) conn.textContent = state.connection === 'online' ? '🟢 connected' : `🔴 ${state.connection}`;
  const roomStatus = $('#status-room');
  const key = state.room ? `${state.room.id}:${state.room.code}:${state.room.game?.name || state.room.gameId}` : '';
  if (roomStatus && statusRoomKey !== key) {
    statusRoomKey = key;
    clear(roomStatus);
    if (state.room) {
      roomStatus.appendChild(el('button', {
        class: 'status-link',
        title: 'Back to your room',
        text: `▶ room ${state.room.code} · ${state.room.game?.name || state.room.gameId}`,
        onClick: () => setView('play'),
      }));
    }
  }
  const counts = $('#status-counts');
  if (counts && state.lobbyStats) counts.textContent = `${fmtNum(state.lobbyStats.online)} online · ${state.lobby?.length || 0} open rooms`;
}

/** Pending-report count on the Admin tab, refreshed when reports arrive. */
let adminBadgeTimer = null;
function refreshAdminBadge() {
  if (!isStaff()) return;
  clearTimeout(adminBadgeTimer);
  adminBadgeTimer = setTimeout(() => {
    api.get('/api/admin/reports?status=open&limit=1').then((res) => {
      const badge = $('#admin-badge');
      if (!badge) return;
      badge.textContent = res.open ? String(res.open) : '';
      badge.classList.toggle('hidden', !res.open);
    }).catch(() => {});
  }, 400);
}

function renderSidebar() {
  const party = $('#side-party');
  clear(party);
  if (!state.party) {
    party.appendChild(el('p', { class: 'muted small', text: 'No party yet.' }));
    party.appendChild(btn('Create party', () => rt.send({ t: 'party', op: 'create' }), { variant: 'primary', cls: 'sm' }));
    party.appendChild(btn('Join by code', () => promptJoinCode(), { cls: 'sm' }));
  } else {
    party.appendChild(el('div', { class: 'row' }, pill(`code ${state.party.code}`, 'good'), pill(state.party.visibility)));
    for (const m of state.party.members) {
      party.appendChild(el('div', { class: 'row' }, el('span', { class: `presence ${m.presence === 'offline' ? 'offline' : 'online'}` }), avatar(m, 20),
        el('span', { class: 'small', text: `${m.name}${m.host ? ' 👑' : ''}` })));
    }
    party.appendChild(el('div', { class: 'row' },
      btn('Start game', () => rt.send({ t: 'party', op: 'start' }), { variant: 'primary', cls: 'sm' }),
      btn('Invite', () => inviteDialog(), { cls: 'sm' }),
      btn('🔗 Link', () => shareParty(state.party), { cls: 'sm', title: 'Copy an invite link anyone can open' }),
      btn('Leave', () => rt.send({ t: 'party', op: 'leave' }), { cls: 'sm' }),
    ));
  }

  const online = $('#side-online');
  clear(online);
  const rows = state.friends.filter((f) => f.friendStatus === 'accepted' && f.presence !== 'offline').slice(0, 8);
  if (!rows.length) online.appendChild(el('p', { class: 'muted small', text: 'No friends online.' }));
  for (const f of rows) {
    online.appendChild(el('div', { class: 'row' }, el('span', { class: `presence ${f.presence}` }), avatar(f, 20),
      el('span', { class: 'small', text: f.name }),
      btn('💬', () => openDm(f.id), { cls: 'sm' })));
  }

  const quick = $('#side-quick');
  clear(quick);
  const playable = state.catalog.filter((g) => g.playable).slice(0, 6);
  for (const g of playable) {
    quick.appendChild(el('button', { class: 'btn sm', text: `${g.icon} ${g.name}`, onClick: () => startSoloGame(g) }));
  }
}

function inviteDialog() {
  const input = el('input', { class: 'input', placeholder: 'Friend username' });
  const handle = modal('Invite to party', el('div', { class: 'col' }, input, btn('Send invite', () => {
    rt.send({ t: 'party', op: 'invite', name: input.value.trim() });
    handle.close();
    toast('Invite sent', 'good');
  }, { variant: 'primary' })));
}

export function openDm(userId) {
  if (!featureOn('dm')) return toast('Direct messages are turned off on this arcade.', 'warn');
  rt.send({ t: 'friend', op: 'history', userId });
  state.chatScope = 'dm';
  state.chatTarget = userId;
  setView('chat');
}

/* ------------------------------------------------------------------ *
 * invite links
 * ------------------------------------------------------------------ */

/** Codes from invite links (/?room=ABCD or /?party=WXYZ), captured once and
 *  stripped so a reload does not re-join. */
let pendingRoomInvite = null;
let pendingPartyInvite = null;
/** Party code we are joining right now, so the broadcast can confirm it. */
let pendingPartyJoin = null;

function consumeInviteLinks() {
  const grab = (url, key) => (url.searchParams.get(key) || '').trim().toUpperCase().slice(0, 12);
  try {
    const url = new URL(location.href);
    const room = grab(url, 'room');
    const party = grab(url, 'party');
    if (!room && !party) return { room: null, party: null };
    url.searchParams.delete('room');
    url.searchParams.delete('party');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return { room: room || null, party: party || null };
  } catch {
    return { room: null, party: null };
  }
}

function joinInvite(code) {
  state.localGame = null;
  rt.send({ t: 'room', op: 'join', code });
  setView('play');
}

function joinPartyInvite(code) {
  pendingPartyJoin = code;
  rt.send({ t: 'party', op: 'join', code });
}

/* ------------------------------------------------------------------ *
 * game mounting
 * ------------------------------------------------------------------ */

let activeHost = null;
let pendingStage = null;

export function mountGame({ mode, game, engine, humans = 2 }) {
  activeHost?.dispose();
  activeHost = null;
  pendingStage = null;
  // Leaving a room to play alone: the server should drop our seat.
  if (mode !== 'online' && state.room) leaveCurrentRoom();
  state.localGame = { mode, game, engine, humans };
  if (mode === 'online') mountOnlineStage();
  setView('play');
}

function leaveCurrentRoom() {
  if (state.room) rt.send({ t: 'room', op: 'leave' });
  state.room = null;
  state.viewData = null;
  state.roomState = null;
  onlineHost?.dispose();
  onlineHost = null;
  syncRoomAlert();
}

/**
 * One shell for everything: a live solo/hot-seat match, an online room that is
 * still filling up, or a running online game. Keeping the lobby controls and
 * the engine stage in the same view means the room never loses its buttons when
 * the server starts the match.
 */
views.play = (mount) => {
  const local = state.localGame;
  const room = state.room;
  const inLobby = !!room && room.status !== 'playing';
  const isHost = !!room && room.host === state.me?.id;
  const title = (inLobby ? room.game : local?.game || room?.game) || { name: 'Arcade' };

  mount.appendChild(el('div', { class: 'card' },
    el('div', { class: 'row spread' },
      el('div', { class: 'row' },
        el('span', { class: 'icon', text: title.icon || '🎮' }),
        el('h2', { text: title.name || title.gameId || 'Game' }),
        local?.mode === 'local' ? pill('hot-seat') : local?.mode === 'solo' ? pill('vs bots') : null,
        room ? pill(room.status, inLobby ? '' : 'good') : null,
        room ? pill(`code ${room.code}`, 'good') : null,
      ),
      el('div', { class: 'row' },
        inLobby && isHost ? btn(room.canStart ? 'Start game' : 'Waiting for players', () => startRoom(), { variant: 'primary', disabled: !room.canStart, cls: 'sm' }) : null,
        inLobby && isHost && featureOn('bots') ? btn('Add bot', () => addBot(2), { cls: 'sm' }) : null,
        inLobby ? btn('Invite', () => shareRoom(room), { cls: 'sm' }) : null,
        !inLobby ? btn('Rematch', () => {
          if (room) { if (isHost) rt.send({ t: 'room', op: 'rematch' }); }
          else if (local) mountGame({ ...local });
        }, { cls: 'sm' }) : null,
        btn('Exit', () => exitGame(), { cls: 'sm', variant: 'danger' }),
      ),
    ),
    room ? el('div', { class: 'waiting-list', id: 'room-seats' }, room.players.map(seatChip)) : null,
  ));

  // A dropped host freezes the room until hosting migrates; the countdown
  // banner (filled by syncRoomAlert) says who takes over and when.
  if (room) mount.appendChild(el('div', { class: 'card room-alert', id: 'room-alert', hidden: true }));

  const stage = el('div', { class: 'card', id: 'game-stage' });
  mount.appendChild(stage);
  pendingStage = stage;

  if (room && !inLobby) mountOnlineStage(stage);
  else if (room) {
    stage.appendChild(el('div', { class: 'col' },
      el('p', { class: 'muted', text: isHost
        ? 'Ready when you are - add bots or share the code, then hit Start game.'
        : 'Waiting for the host to start the game.' }),
      el('p', { class: 'muted small', text: 'Everyone on your wifi can join with the code above (or the LAN link the server prints at boot).' }),
    ));
  } else if (local) mountLocalStage(stage, local);
  else stage.appendChild(el('p', { class: 'muted', text: 'Pick a game to start playing.' }));

  if (room && featureOn('chat')) mount.appendChild(roomChatCard());
  syncRoomAlert();
};

function exitGame() {
  activeHost?.dispose();
  activeHost = null;
  state.localGame = null;
  leaveCurrentRoom();
  setView('home');
}

function roomChatCard() {
  const box = el('div', { class: 'chat-list', id: 'room-chat' });
  const input = el('input', { class: 'input', placeholder: 'Say something…' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    sendChat('room', text);
    input.value = '';
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });
  const card = el('div', { class: 'card' },
    el('h4', { text: 'Room chat' }),
    box,
    el('div', { class: 'input-row' }, input, btn('Send', send, { cls: 'sm' })),
  );
  drawRoomChat();
  return card;
}

let roomAlertTimer = null;

/** Fill the host-outage banner from the room's countdown (no-op off-screen). */
function drawRoomAlert() {
  const bar = document.getElementById('room-alert');
  if (!bar) return false;
  const text = roomAlertText(state.room?.hostOutage);
  bar.hidden = !text;
  bar.replaceChildren(...(text ? [el('span', { class: 'icon', text: '⏳' }), el('span', { class: 'text', text })] : []));
  return !!text;
}

/**
 * Keep the banner in step with the room: draw it now, and tick the countdown
 * locally while the outage lasts - the room message carries the deadline, not
 * one message per second.  Leaving the play view removes the element, which
 * stops the tick on its next pass.
 */
function syncRoomAlert() {
  const live = drawRoomAlert();
  if (live && !roomAlertTimer) roomAlertTimer = setInterval(drawRoomAlert, 500);
  else if (!live && roomAlertTimer) {
    clearInterval(roomAlertTimer);
    roomAlertTimer = null;
  }
}

/** One seat chip: a bot's is solid, a dropped human's greys out as a ghost. */
function seatChip(p) {
  const ghost = p.kind !== 'bot' && p.connected === false;
  return el('span', {
    class: `chip${p.kind === 'bot' ? ' done' : ''}${ghost ? ' ghost' : ''}`,
    title: ghost ? `${p.name} lost connection - reconnecting` : null,
  }, `${p.avatar || ''} ${p.name}${p.kind === 'bot' ? ' 🤖' : ''}${ghost ? ' · reconnecting…' : ''}`);
}

/** Redraw the seat chips in place, so a mid-match drop ghosts its seat too. */
function drawRoomSeats(room = state.room) {
  const box = document.getElementById('room-seats');
  if (!box) return false;
  box.replaceChildren(...(room?.players || []).map(seatChip));
  return true;
}

function drawRoomChat() {
  const box = document.getElementById('room-chat');
  if (!box || !state.room) return;
  const messages = state.messages[`room:${state.room.id}`] || [];
  box.replaceChildren(...messages.slice(-40).map((m) => el('div', { class: `chat-line ${m.kind || ''}` },
    m.kind === 'system' ? null : el('b', { class: 'chat-name', text: m.name || '???' }),
    el('span', { class: 'chat-text', text: m.text }))));
  box.scrollTop = box.scrollHeight;
}

function mountLocalStage(stage, local) {
  if (!stage || !local?.engine) return;
  const seats = seatsFor(local.game, {
    mode: local.mode,
    humans: local.humans,
    botLevel: local.botLevel ?? 2,
    myName: state.me?.name || 'You',
    myAvatar: state.me?.avatar || '🙂',
  });
  activeHost = new LocalHost({
    engine: local.engine,
    mount: stage,
    seats,
    options: local.options || {},
    role: local.mode,
    onEvent: (ev) => {
      if (ev?.text) toast(ev.text, ev.kind === 'win' ? 'good' : '', 2600);
    },
  });
  activeHost.render();
  if (local.mode === 'local' && activeHost.humanSeats.length > 1) {
    const bar = el('div', { class: 'row', style: { marginTop: '10px' } }, el('span', { class: 'muted small', text: 'Playing on one device - the active player is shown above. Pass the device when the turn changes.' }));
    stage.appendChild(bar);
  }
}

/** The online host is module-scoped so a re-render keeps the live match. */
let onlineHost = null;
/** The engine import a mount is waiting on: one per room, shared by redraws. */
let pendingOnlineMount = null;
function mountOnlineStage(stage = null) {
  if (stage) pendingStage = stage;
  const room = state.room;
  if (!room || !pendingStage) return;
  // A running realtime room keeps its host object (and the world it owns)
  // across shell redraws - only the mount element changes.
  if (onlineHost && !onlineHost.disposed && onlineHost.room?.id === room.id && onlineHost.engine) {
    if (onlineHost.mount !== pendingStage) {
      onlineHost.mount = pendingStage;
      onlineHost.liveCanvas = false;
    }
    onlineHost.applyRoom(room, state.viewData);
    return;
  }
  // The engine loads asynchronously and the shell can redraw again before it
  // arrives (boot's catalog refresh races the room:start message).  A second
  // mount joins the load in flight instead of starting its own - two resolves
  // otherwise fight, and the loser tears down the host holding the start state.
  if (pendingOnlineMount && pendingOnlineMount.roomId === room.id) return;
  const engineId = room.gameId;
  const mount = { roomId: room.id, engineId };
  pendingOnlineMount = mount;
  loadEngine(engineId).then((engine) => {
    if (pendingOnlineMount === mount) pendingOnlineMount = null;
    // The user moved on while the engine loaded: the newer mount owns the view.
    if (state.room?.id !== mount.roomId || state.view !== 'play') return;
    if (!engine) {
      pendingStage.appendChild(el('div', { class: 'card' }, el('p', { class: 'muted', text: `Engine "${engineId}" is not available in this client build.` })));
      return;
    }
    // Another mount may have created the host while this load was queued: a
    // running match keeps its world and just re-points at the newest stage.
    if (onlineHost && !onlineHost.disposed && onlineHost.room?.id === mount.roomId && onlineHost.engine) {
      if (onlineHost.mount !== pendingStage) {
        onlineHost.mount = pendingStage;
        onlineHost.liveCanvas = false;
      }
      onlineHost.applyRoom(state.room, state.viewData);
      return;
    }
    // The start-of-match snapshot is consumed once: a later redraw must never
    // rewind a match that is already running.
    const initial = state.roomState?.roomId === mount.roomId ? state.roomState.state : null;
    if (initial) state.roomState = null;
    onlineHost = new OnlineHost({
      mount: pendingStage,
      room: state.room,
      view: state.viewData,
      playerId: state.me?.id,
      onEvent: (ev) => ev?.text && toast(ev.text),
      initialState: initial,
    });
    onlineHost.setEngine(engine);
    activeHost = onlineHost;
    onlineHost.render();
  }).catch((err) => {
    if (pendingOnlineMount === mount) pendingOnlineMount = null;
    console.error('engine load failed', err);
  });
}

/* ------------------------------------------------------------------ *
 * realtime wiring
 * ------------------------------------------------------------------ */

/**
 * Adopt a config push - the welcome carries one, and the console pushes a fresh
 * one whenever the site settings, a feature switch or a game's visibility
 * change.  The shell is only rebuilt when the switches or the catalog really
 * moved, so an admin is never redrawn mid-keystroke by their own save.
 */
function applyConfigPush(msg) {
  const snapshot = () => JSON.stringify([state.features, (state.catalog || []).map((g) => g.id)]);
  const before = snapshot();
  const incoming = String(msg.config?.build || '');
  setServerConfig(msg.config);
  // The build is read before anything else can overwrite the stored config: the
  // first answer is what this page is running.  Any later answer that differs
  // is a deploy this tab missed - a reconnect is often the first to notice it.
  if (incoming) {
    if (!loadedBuild) {
      loadedBuild = incoming;
      startBuildWatch();
    } else if (incoming !== loadedBuild) {
      noticeNewBuild(incoming);
    }
  }
  if (msg.catalog?.length) {
    state.catalog = msg.catalog;
    state.categories = [...new Set(state.catalog.map((g) => g.category))];
  }
  const changed = snapshot() !== before;
  if (changed && state.me) renderApp();
  else drawAnnouncement();
  return changed;
}

rt.on('welcome', (msg) => {
  applyConfigPush(msg);
  if (msg.degraded?.length) toast(`Compatibility note: ${msg.degraded.join(', ')}`, 'warn', 6000);
  // Invite links join on the first welcome: that is the earliest moment the
  // socket is open and the server knows who we are (rt.send drops before then).
  if (pendingRoomInvite) {
    const code = pendingRoomInvite;
    pendingRoomInvite = null;
    pendingPartyInvite = null; // a room invite wins over a party one
    joinInvite(code);
  } else if (pendingPartyInvite) {
    const code = pendingPartyInvite;
    pendingPartyInvite = null;
    joinPartyInvite(code);
  }
  // A reconnect drops the server-side watch flag, so re-subscribe if we are
  // still sitting on the board or the changelog.
  if (BOARD_VIEWS.has(state.view)) rt.send({ t: 'suggestions' });
  notify();
});

rt.on('me', (msg) => {
  // Carries the account's stored settings - adopt them so a fresh device or
  // browser picks up the same theme, keybinds and audio as everywhere else.
  setMe(msg.user);
});

rt.on('settings', (msg) => {
  if (msg.settings) {
    state.settings = merge(state.settings, msg.settings);
    applyTheme();
    saveLocal();
    notify();
  }
});

rt.on('friends', (msg) => {
  state.friends = msg.list || [];
  notify();
});

rt.on('presence', (msg) => {
  const friend = state.friends.find((f) => f.id === msg.userId);
  if (friend) friend.presence = msg.status;
  notify();
});

rt.on('party', (msg) => {
  state.party = msg.party;
  if (msg.party?.chat) state.messages[`party:${msg.party.id}`] = msg.party.chat;
  // Arriving via a /?party=CODE link: confirm once the join actually landed.
  if (pendingPartyJoin && msg.party?.code === pendingPartyJoin) {
    toast(`Joined party ${msg.party.code} 🎈`, 'good');
    pendingPartyJoin = null;
  }
  notify();
});

rt.on('game', (msg) => {
  state.room = msg.room;
  state.viewData = msg.view;
  if (msg.messages) state.messages[`room:${msg.room.id}`] = msg.messages;
  const playing = msg.room?.status === 'playing';
  if (state.view !== 'play') {
    setView('play');
  } else if (playing && onlineHost && !onlineHost.disposed) {
    onlineHost.applyRoom(msg.room, msg.view);
    drawRoomChat();
    drawRoomSeats(msg.room);
    syncRoomAlert();
  } else {
    // Room opened, rematch, or the server handed us a fresh lobby view - redraw
    // the shell so host controls and the waiting list are correct.
    activeHost?.dispose();
    activeHost = null;
    onlineHost = null;
    renderApp();
  }
  notify();
});

rt.on('tick', (msg) => {
  if (onlineHost && msg.roomId === state.room?.id) onlineHost.applyTick(msg.snapshot);
});

// Realtime rooms are host-authoritative: the server forwards remote seats'
// controls to the host and hands the host the pristine start-of-match state.
rt.on('room:input', (msg) => {
  if (onlineHost && msg.roomId === state.room?.id) onlineHost.applyInput(msg.from, msg.action);
});

// A seat or spectator whose buffer ran dry asked the host for a keyframe: the
// host answers with the freshest world (coalescing requests in the same window).
rt.on('room:request', (msg) => {
  if (msg.kind === 'keyframe' && onlineHost && msg.roomId === state.room?.id) onlineHost.freshSnapshot();
});

rt.on('room:state', (msg) => {
  state.roomState = { roomId: msg.roomId, state: msg.state };
  if (onlineHost && msg.roomId === state.room?.id) onlineHost.applyStartState(msg.state);
});

rt.on('room:closed', (msg) => {
  state.room = null;
  state.viewData = null;
  state.roomState = null;
  onlineHost?.dispose();
  onlineHost = null;
  syncRoomAlert();
  if (state.view === 'play') {
    toast('The room closed.', 'warn');
    setView('home');
  }
  notify();
});

rt.on('chat', (msg) => {
  const scope = msg.scope || 'global';
  (state.messages[scope] ||= []).push(msg.message);
  if (scope.startsWith('party') && state.chatScope === 'party') window.__redrawChat?.();
  // The room chat card owns its own element: redraw it directly.  The shared
  // __redrawChat hook can point at a chat view that has since unmounted.
  if (scope.startsWith('room')) drawRoomChat();
  notify();
});

rt.on('dm', (msg) => {
  const other = msg.message.from === state.me?.id ? msg.message.to : msg.message.from;
  (state.dms[other] ||= []).push(msg.message);
  if (state.chatScope === 'dm' && state.chatTarget === other) window.__redrawChat?.();
  if (msg.from && !state.conversations.some((c) => c.userId === other)) {
    state.conversations.push({ userId: other, name: msg.from.name, avatar: msg.from.avatar, last: { text: msg.message.text, at: msg.message.at } });
  }
  if (msg.message.from !== state.me?.id) {
    sfx('message');
    toast(`${msg.from?.name || 'Someone'}: ${msg.message.text}`, '', 5000);
  }
  notify();
});

rt.on('dm:history', (msg) => {
  state.dms[msg.userId] = msg.messages;
  window.__redrawChat?.();
  notify();
});

rt.on('dm:list', (msg) => {
  state.conversations = msg.conversations || [];
  notify();
});

rt.on('lobby', (msg) => {
  state.lobby = msg.rooms || [];
  state.lobbyStats = msg.stats || null;
  state.globalStats = msg.statsGlobal || state.globalStats;
  if (state.view === 'lobby') renderApp();
  else $('#status-counts').textContent = state.lobbyStats ? `${fmtNum(state.lobbyStats.online)} online · ${state.lobby.length} open rooms` : '';
});

/** One-click actions for notifications that ask something of us: a party
 *  invite joins straight away, a friend request accepts in place. */
function notifyActions(kind, msg) {
  if (kind === 'party-invite' && msg.code && state.party?.code !== msg.code) {
    return [{ label: '🎈 Join party', onClick: () => joinPartyInvite(msg.code) }];
  }
  // Back from a drop that outlasted the grace: one click puts the seat back.
  if (kind === 'party-rejoin' && msg.code && state.party?.code !== msg.code) {
    return [{ label: '🎈 Rejoin party', onClick: () => joinPartyInvite(msg.code) }];
  }
  if (kind === 'friend-request' && msg.from?.id) {
    const existing = state.friends.find((f) => f.id === msg.from.id);
    if (existing?.friendStatus !== 'accepted') {
      return [{ label: '✅ Accept', onClick: () => rt.send({ t: 'friend', op: 'accept', userId: msg.from.id }) }];
    }
  }
  return [];
}

rt.on('notify', (msg) => {
  const kind = msg.kind || 'info';
  toast(msg.text || kind, kind === 'broadcast' ? 'warn' : 'good', 7000, notifyActions(kind, msg));
  if (state.settings.notifications?.sounds !== false) sfx('notify');
  if (kind === 'friend-request' || kind === 'friend-accept') rt.send({ t: 'friend', op: 'list' });
  if (kind === 'report') refreshAdminBadge();
  // Staff moved your idea: keep whichever board view is open in sync.
  if (kind === 'suggestion-update') {
    if (state.view === 'suggestions') window.__refetchSuggestions?.();
    if (state.view === 'changelog') window.__refetchChangelog?.();
  }
  notify();
});

rt.on('friends:refresh', () => rt.send({ t: 'friend', op: 'list' }));

// The idea board changed for someone else: refresh it if we are looking at it.
rt.on('suggestions:changed', () => {
  if (state.view === 'suggestions') window.__refetchSuggestions?.();
  if (state.view === 'changelog') window.__refetchChangelog?.();
});

/* An admin just changed the site settings, a feature switch or a game's
 * visibility: every open tab follows along without a reload. */
rt.on('config', (msg) => applyConfigPush(msg));

rt.on('error', (msg) => {
  pendingPartyJoin = null; // the join was refused; do not confirm it later
  toast(msg.message || 'Something went wrong', 'bad');
});

rt.on('banned', (msg) => {
  toast(`You were removed: ${msg.message}`, 'bad', 12000);
  setTimeout(() => location.reload(), 3000);
});

rt.on('maintenance', (msg) => toast(msg.message, 'warn', 10000));

rt.on('toast', (msg) => toast(msg.text || '', msg.kind || ''));

/* ------------------------------------------------------------------ *
 * live builds
 * ------------------------------------------------------------------ */

/** The build this page booted from - the first stamp the server ever sent us. */
let loadedBuild = '';
/** The build we have already offered to move to, so one deploy nags once. */
let offeredBuild = '';
/** A deploy that arrived while nobody was watching or a match was on. */
let pendingBuild = '';
let buildWatcher = null;

/** Is this tab mid-match?  A reload would drop it, so it is never automatic. */
function matchInProgress() {
  return state.view === 'play' && !!activeHost && !activeHost.disposed
    && (state.room ? true : !!state.localGame);
}

/** Take the build on the spot, by wandering off the old one. */
function offerBuild() {
  pendingBuild = '';
  toast('A new version of the arcade is ready.', 'good', 20000, [
    { label: 'Reload', onClick: () => location.reload() },
  ]);
}

/**
 * A newer build is being served than the one running here.
 *
 * Nobody is watching and no match depends on this tab, so reload out of sight -
 * the new build is simply there when the player comes back.  If a match *is*
 * running the reload waits: taking a rally away from someone is worse than
 * being a version behind, and only they know if now is a good moment.  A hold
 * that lands while the tab is hidden is remembered rather than toasted into the
 * void, so it is offered the moment they are looking again.
 */
function noticeNewBuild(next) {
  if (!next || next === offeredBuild) return;
  offeredBuild = next;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    if (!matchInProgress()) {
      location.reload();
      return;
    }
    pendingBuild = next;
    return;
  }
  offerBuild();
}

// Back in front of the screen: anything held while away is offered now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pendingBuild) offerBuild();
});

/**
 * Start watching once we know which build this page is running.  The stamp
 * arrives with the config (the boot handshake or the socket's welcome), so a
 * tab that reconnects after a deploy learns immediately; the poll is the
 * backstop for a tab whose socket went quiet.
 */
function startBuildWatch() {
  if (buildWatcher || !loadedBuild) return;
  buildWatcher = watchBuilds({ build: loadedBuild, onNew: ({ build }) => noticeNewBuild(build) });
}

/* ------------------------------------------------------------------ *
 * global wiring
 * ------------------------------------------------------------------ */

window.__setView = setView;
window.__render = renderApp;
window.__mountGame = mountGame;
window.__mountStage = (stage) => {
  if (state.localGame) mountLocalStage(stage, state.localGame);
  else mountOnlineStage(stage);
};
window.__openDm = openDm;
window.__redrawChat = () => drawRoomChat();
window.__refreshAdminBadge = refreshAdminBadge;

// Live data (party, friends, presence, lobby) refreshes the sidebar and status
// bar only - re-rendering the whole view would wipe whatever you are typing.
onChange(() => {
  if ($('#app') && !$('#app').classList.contains('hidden')) {
    renderStatus();
    renderSidebar();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea, select')) return;
  const chatKey = state.settings.keybinds?.chat || 'KeyT';
  if (ev.code === chatKey) {
    ev.preventDefault();
    setView('chat');
  }
  if (ev.code === 'Escape') {
    $('#modal').classList.add('hidden');
    $('.nav.tabs')?.classList.remove('open');
  }
});

api.get('/api/stats').then((s) => {
  state.globalStats = s;
  notify();
}).catch(() => {});

// A page unload must NOT send `room:leave`: a reload is indistinguishable from
// a close here, and leaving drops the seat - a host that reloads has to be able
// to re-attach to the room it is still in (the server re-sends the room and its
// world on identify).  Deliberate exits (the Exit button, logout) leave directly.

boot();

// Deep link used by the desktop launcher and the download page: ?view=download.
// Applied after boot so the arcade still loads normally when the view is stale.
if (new URLSearchParams(location.search).get('view') === 'download') {
  window.addEventListener('load', () => {
    if (state.me) setView('download');
    else $('#auth-download')?.click();
  });
}
