/**
 * All app views.  Each view exports `render(mount, ctx)` and may register
 * cleanups in ctx.onCleanup so switching views tears down timers/hosts.
 */
import { el, btn, pill, avatar, toast, modal, fmtNum, timeAgo, confirmDialog } from './dom.js';
import {
  state, setSettings, isStaff, isAdmin, featureOn, onChange, THEMES, KEYBIND_ACTIONS,
  setSettings as saveSettings, gameLoadout, gameMemory, gameProgress, clearGameProgress,
} from './store.js';
import { api } from './api.js';
import { rt, partyOp, joinRoom, sendChat } from './realtime.js';
import { LocalHost, OnlineHost, seatsFor, botSeat, clockText } from './host.js';
import * as UI from '../games/engines/ui.js';

export const views = {};

/* ------------------------------------------------------------------ *
 * shared bits
 * ------------------------------------------------------------------ */

export function gameCard(game, { onPlay }) {
  // A half-played run is worth flagging on the shelf: the Play button then opens
  // on "continue or start fresh" instead of quietly starting over.
  const saved = gameProgress(game.engine || game.id);
  const card = el('div', { class: `game-card ${game.playable ? '' : 'planned'}` },
    el('div', { class: 'row spread' },
      el('span', { class: 'icon', text: game.icon || '🎮' }),
      saved ? pill('▶ continue', 'good') : null,
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
  // Rules and option defaults live in the engine module, not in the catalog
  // summary, so the details sheet fills them in once that file arrives.
  const extra = el('div', { class: 'col' });
  const body = el('div', { class: 'col' },
    el('div', { class: 'muted', text: game.blurb }),
    el('div', { class: 'meta-line' }, pill(game.category), pill(`${game.players.min}-${game.players.max} players`), pill(`${game.minutes} min`), game.status !== 'playable' ? pill(game.status, 'warn') : null),
    game.engineMeta?.rules?.length ? el('div', {}, el('h4', { text: 'How to play' }), el('ul', {}, game.engineMeta.rules.map((r) => el('li', { text: r })))) : null,
    (game.variants || []).length ? el('div', {}, el('h4', { text: 'Variants' }),
      el('div', { class: 'option-grid' }, game.variants.map((v) => el('div', { class: 'option' }, el('strong', { text: v.name }), el('span', { class: 'option-desc', text: v.desc }))))) : null,
    (game.engineMeta?.options || []).length ? el('div', {}, el('h4', { text: 'Settings' }),
      el('div', { class: 'row' }, game.engineMeta.options.map((o) => pill(`${o.label}: ${o.default ?? 'default'}`)))) : null,
    extra,
    el('div', { class: 'row' },
      btn('Play with people', () => { handle.close(); playWithPeople(game); }, { variant: 'primary', disabled: !game.playable }),
      btn('Local (pass device)', () => { handle.close(); startLocalGame(game); }, { disabled: !game.playable }),
      btn('Solo vs bots', () => { handle.close(); startSoloGame(game); }, { disabled: !game.playable }),
      btn('Options', () => { handle.close(); showPlayOptions(game); }, { cls: 'sm', disabled: !game.playable }),
    ),
  );
  const handle = modal(game.name, body);
  loadEngine(game.engine || game.id).then((engine) => {
    if (!engine?.meta) return;
    const bits = [];
    if (engine.meta.rules?.length) {
      bits.push(el('div', {}, el('h4', { text: 'How to play' }), el('ul', {}, engine.meta.rules.map((r) => el('li', { text: r })))));
    }
    const defaults = ruleSummary(engine.meta.options, {}, engine);
    if (defaults) {
      bits.push(el('div', {}, el('h4', { text: 'Default rules' }),
        el('div', { class: 'row' }, pill(defaults))));
    }
    extra.replaceChildren(...bits);
  });
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
      featureOn('parties') ? btn('🎈 Start a party', () => partyOp('create')) : null,
      featureOn('catalog') ? btn('🔎 Browse all games', () => window.__setView('catalog')) : null,
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
    mount.appendChild(el('div', { class: 'grid cards' }, featured.map((g) => gameCard(g, { onPlay: (game) => playFromCard(game) }))));
  }

  mount.appendChild(el('h3', { text: 'Quick plays' }));
  mount.appendChild(el('div', { class: 'grid cards' },
    playable.filter((g) => g.minutes <= 12).slice(0, 8).map((g) => gameCard(g, { onPlay: (game) => playFromCard(game) }))));

  // Each card follows its own switch, so a home page never advertises a door
  // the server would refuse to open.
  if (featureOn('parties')) {
    mount.appendChild(el('div', { class: 'card' },
      el('h3', { text: 'Play with friends' }),
      el('p', { class: 'muted', text: 'Everyone on this wifi can join with the LAN link printed by the server. Create a party, share the 4-letter code, then hit start.' }),
      el('div', { class: 'row' },
        btn('Create party', () => partyOp('create'), { variant: 'primary' }),
        btn('Join by code', () => promptJoinCode()),
        featureOn('lobby') ? btn('🌐 Browse servers', () => window.__setView('lobby')) : null,
      ),
      window.__lanHint ? el('p', { class: 'mono small', text: window.__lanHint }) : null,
    ));
  }

  if (featureOn('suggestions')) {
    mount.appendChild(el('div', { class: 'card' },
      el('h3', { text: '💡 Got an idea?' }),
      el('p', { class: 'muted', text: 'Suggest a new game, a feature or an update - and vote on what everyone else wants next.' }),
      el('div', { class: 'row' },
        btn('Open the idea board', () => window.__setView('suggestions'), { variant: 'primary' }),
      ),
    ));
  }

  if (featureOn('downloads')) {
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
  }
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
        playFromCard(game);
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

/**
 * Games that can be played alone right now start on one click; anything that
 * wants a table asks how you want to play first, so nobody lands on bots by
 * accident when there are people to play with.
 */
function playFromCard(game) {
  if (game.modes.includes('solo') && game.players.min <= 1) return startSoloGame(game);
  return showPlayOptions(game);
}

/** Open rooms for one game - or, with no game, every open room there is. */
async function fetchRooms(gameId = null) {
  try {
    const res = await api.get(gameId ? `/api/rooms?game=${encodeURIComponent(gameId)}` : '/api/rooms');
    return res?.rooms || [];
  } catch {
    return [];
  }
}

/**
 * Is the player already in a group?  A party of one is just you, so it does
 * not count - only a real group changes where a game should start.
 */
function inParty() {
  return !!(featureOn('parties') && state.party && (state.party.members?.length || 0) > 1);
}

/**
 * Start the game for everyone in the party.
 *
 * The party is the group players already picked, so the leader opening a game
 * seats the whole group in one room instead of leaving everyone to find it.
 * With no game chosen yet this opens the picker first: the sidebar's "Start
 * game" used to answer "No game selected yet." with no way to select one.
 */
export function startPartyGame() {
  if (!state.party) {
    toast('Create a party first.', 'warn');
    return;
  }
  if (state.party.leader !== state.me?.id) {
    toast('Only the party leader starts the game.', 'warn');
    return;
  }
  if (state.party.gameId) {
    partyOp('start', { gameId: state.party.gameId, options: gameLoadout(state.party.gameId) });
    return;
  }
  pickPartyGame();
}

/** The leader's game picker: choosing one drops the whole party into it. */
function pickPartyGame() {
  const list = el('div', { class: 'col', style: { maxHeight: '46vh', overflowY: 'auto' } });
  const search = el('input', { class: 'input', placeholder: 'Search games…' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const games = state.catalog.filter((g) => g.playable && (!q || g.name.toLowerCase().includes(q)));
    list.replaceChildren(...games.map((g) => el('button', {
      class: 'option',
      onClick: () => {
        handle.close();
        const id = g.engine || g.id;
        // The leader's remembered rules ride along, so the room advertises
        // them before the rest of the party is dropped in.
        const options = gameLoadout(id);
        partyOp('game', { gameId: id, options });
        partyOp('start', { gameId: id, options });
        toast(`${g.name} - dropping the party in…`, 'good');
      },
    },
    el('strong', { text: `${g.icon || '🎮'} ${g.name}` }),
    el('span', { class: 'option-desc', text: `${g.players.min}-${g.players.max} players · ${g.minutes} min · ${g.category}` }),
    el('span', { class: 'pill', text: 'Play →' }))));
    if (!games.length) list.appendChild(el('div', { class: 'muted', text: 'Nothing matches that.' }));
  };
  search.addEventListener('input', draw);
  const handle = modal('Party game', el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'Everyone in the party lands in the same room. Bots only fill the seats that stay empty.' }),
    search, list));
  draw();
}

/**
 * One tap to a table full of people: join the fullest open room for this game,
 * and only open a fresh one when there is nothing to join.  A room that is
 * already open keeps its own rules - yours only ride along into a new one.
 */
async function quickMatch(game, options = {}) {
  const rooms = await fetchRooms(game.engine || game.id);
  const max = game.players?.max ?? 99;
  const joinable = rooms
    .filter((r) => r.status !== 'playing' && r.players.length < max)
    .sort((a, b) => b.players.length - a.players.length);
  state.localGame = null;
  if (joinable.length) {
    rt.send({ t: 'room', op: 'join', roomId: joinable[0].id });
    window.__setView('play');
    return;
  }
  await createRoom(game, options);
}

/**
 * "Play with people" from the sheet: your party first, then any open room, and
 * only then a room of your own.
 */
async function playWithPeople(game, options = {}) {
  if (inParty()) {
    if (state.party.leader === state.me?.id) {
      const id = game.engine || game.id;
      partyOp('game', { gameId: id, options });
      partyOp('start', { gameId: id, options });
      toast(`Party game: ${game.name}`, 'good');
      return;
    }
    toast('Your party leader picks the game - you will be pulled in.', 'warn');
    return;
  }
  return quickMatch(game, options);
}

/* ------------------------------ rule presets ------------------------------ */

/** Human label for one option value (stage ids and 0/1 switches read badly raw). */
function ruleValueLabel(def, value, engine) {
  if (def?.id === 'stage') {
    const stage = (engine?.meta?.stages || []).find((s) => s.id === value);
    return stage?.name || String(value);
  }
  if (value === 0) return 'off';
  if (value === 1 && (def?.values || []).includes(0)) return 'on';
  return String(value).replace(/-/g, ' ');
}

/**
 * One line describing the rules a room will play by.
 *
 * A room only stores what its host chose, so untouched options fall back to
 * the engine's default: a joiner reads the rules they will actually get, not an
 * empty list, and that is what makes a room worth joining or skipping.
 */
/**
 * The rules a room plays by, as an element the room lobby can drop in.
 *
 * The play sheet advertises a room's rules before anyone joins; the room itself
 * has to say the same thing once they are in it, or the promise and the match
 * can drift apart.  Labels come from the engine module, so this fills in once
 * that file has loaded.
 */
export function roomRulesLine(room) {
  const line = el('span', { class: 'muted small', text: 'Loading rules…' });
  loadEngine(room?.gameId).then((engine) => {
    line.textContent = ruleSummary(engine?.meta?.options, room?.options, engine) || 'Engine default rules';
  });
  return line;
}

function ruleSummary(defs, options, engine) {
  const parts = [];
  for (const def of defs || []) {
    const value = options?.[def.id] !== undefined ? options[def.id] : def.default;
    if (value === undefined) continue;
    parts.push(`${def.label} ${ruleValueLabel(def, value, engine)}`);
  }
  return parts.join(' · ');
}

/**
 * What this account has already done at a game, in one line: best score, best
 * time, runs played.  Labels come from the engine's own `meta.record`, so the
 * line says "strokes" for mini golf and "chips" for blackjack; a game that keeps
 * no record returns an empty string and nothing is shown.
 */
export function recordText(memory, meta) {
  const spec = meta?.record;
  if (!spec || !memory) return '';
  const parts = [];
  if (spec.best && memory.bestScore != null) {
    parts.push(`best ${Math.round(Number(memory.bestScore) || 0).toLocaleString()}${spec.label ? ` ${spec.label}` : ''}`);
  }
  if (memory.bestTime != null) {
    parts.push(`${spec.timeLabel || 'best time'} ${clockText(memory.bestTime)}`);
  }
  const played = Math.round(Number(memory.played) || 0);
  const wins = Math.round(Number(memory.wins) || 0);
  if (played > 0) parts.push(`${played} played${wins > 0 ? ` · ${wins} won` : ''}`);
  return parts.join(' · ');
}

/** The saved run for a game, when the engine asked for one and there is one. */
function resumableRun(gameId, engine) {
  if (!engine?.meta?.record?.resume) return null;
  return gameProgress(gameId);
}

/**
 * Straight back into a saved run, with no questions asked - the player already
 * said continue (from the prompt, or the continue card on an empty stage).
 */
export async function resumeSoloRun(game, progress) {
  const gameId = game.engine || game.id;
  const engine = await loadEngine(gameId);
  if (!engine) return toast(`${game.name} is still in development.`, 'warn');
  window.__mountGame({ mode: 'solo', game, engine, options: gameLoadout(gameId), resume: progress });
}

/**
 * The play sheet: live rooms for this game first, then the offline ways in.
 * The list is fetched over REST rather than the lobby socket so a player who
 * never visited the lobby still sees who is playing right now.
 */
export function showPlayOptions(game) {
  const gameId = game.engine || game.id;
  const list = el('div', { class: 'col' });
  const note = el('p', { class: 'muted small', text: 'Looking for open rooms…' });
  const rulesBox = el('div', { class: 'col' });
  // The rules picked here ride into the room you open, so the next player reads
  // them on the room row before deciding to sit down.  Seeded from the rules
  // this player last used; anything left alone is the engine's own default.
  const chosen = { ...gameLoadout(gameId) };
  let engine = null;
  const optionDefs = () => engine?.meta?.options || [];

  const joinRoomById = (room) => {
    handle.close();
    state.localGame = null;
    rt.send({ t: 'room', op: 'join', roomId: room.id });
    window.__setView('play');
  };
  const watchRoom = (room) => {
    handle.close();
    state.localGame = null;
    rt.send({ t: 'room', op: 'spectate', roomId: room.id });
    window.__setView('play');
  };

  const drawRooms = (rooms) => {
    const open = rooms.filter((r) => r.status !== 'closed');
    list.replaceChildren();
    if (!open.length) {
      note.textContent = 'No open rooms for this game yet - open one and it shows up here for everyone.';
      return;
    }
    note.textContent = `${open.length} open room${open.length === 1 ? '' : 's'} right now`;
    for (const room of open.slice(0, 6)) {
      const host = room.players.find((p) => p.id === room.host)?.name || 'someone';
      const humans = room.players.filter((p) => p.kind !== 'bot').length;
      list.appendChild(el('div', { class: 'room-row' },
        el('span', { text: room.game?.icon || game.icon || '🎮' }),
        el('div', { class: 'name' },
          el('strong', { text: room.game?.name || game.name }),
          el('div', { class: 'muted small', text: `host ${host} · ${room.status === 'playing' ? 'in progress' : 'filling up'} · ${humans} player${humans === 1 ? '' : 's'}${room.spectators ? ` · ${room.spectators} watching` : ''}` }),
          el('div', { class: 'muted small', text: ruleSummary(optionDefs(), room.options, engine) || 'engine default rules' }),
        ),
        pill(room.code),
        room.status === 'playing'
          ? (featureOn('spectate') ? btn('Watch', () => watchRoom(room), { cls: 'sm' }) : pill('in progress'))
          : btn('Join', () => joinRoomById(room), { variant: 'primary', cls: 'sm' }),
      ));
    }
  };

  const refresh = () => fetchRooms(gameId).then(drawRooms);

  /** The rule presets - one row per engine option, active value highlighted. */
  const drawRules = () => {
    const defs = optionDefs();
    if (!defs.length) {
      rulesBox.replaceChildren();
      return;
    }
    rulesBox.replaceChildren(
      el('div', { class: 'row spread' },
        el('h4', { text: 'Rules for the room you open' }),
        el('span', { class: 'muted small', text: ruleSummary(defs, chosen, engine) }),
      ),
      el('div', { class: 'col' }, defs.map((def) => {
        // Highlight what the room will actually play with, so an untouched
        // engine default reads the same as one the player picked on purpose.
        const active = chosen[def.id] !== undefined ? chosen[def.id] : def.default;
        return el('div', { class: 'row rules-row' },
          el('span', { class: 'muted small rules-label', text: def.label }),
          ...(def.values || []).map((value) => btn(ruleValueLabel(def, value, engine), () => {
            chosen[def.id] = value;
            drawRules();
          }, { variant: active === value ? 'primary' : '', cls: 'sm' })),
        );
      })),
    );
  };

  // What this account already has at this game, filled once the engine (and so
  // the record's labels) has loaded.
  const recordLine = el('p', { class: 'muted small record-line', text: '' });
  const body = el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'Play with people in an open room, open one friends can join with a code - or take the bots on. Set the rules first and the room advertises them.' }),
    recordLine,
    el('div', { class: 'option-grid' },
      optionCard('Play with people', 'Jump into a room that is already filling up, or open one on these rules.', () => { handle.close(); playWithPeople(game, chosen); }),
      optionCard('Local hot-seat', 'Several players sharing this device.', () => { handle.close(); startLocalGame(game); }),
      optionCard('Solo vs bots', 'You against the house AI. Jump straight in.', () => { handle.close(); startSoloGame(game); }),
    ),
    rulesBox,
    el('div', { class: 'row spread' },
      el('h4', { text: 'Open rooms' }),
      btn('Refresh', () => refresh(), { cls: 'sm' }),
    ),
    note,
    list,
    el('div', { class: 'row' },
      btn('Join by code', () => { handle.close(); promptJoinCode(); }, { cls: 'sm' }),
    ),
  );
  const timer = setInterval(() => { if (!note.isConnected) { clearInterval(timer); return; } refresh(); }, 5000);
  const handle = modal(`Play ${game.name}`, body, { onClose: () => clearInterval(timer) });
  refresh();
  // Options live in the engine module, which the browser only loads on demand:
  // the sheet opens instantly and fills the rule rows (and the room summaries)
  // as soon as the family file arrives.
  loadEngine(gameId).then((mod) => {
    engine = mod;
    drawRules();
    const text = recordText(gameMemory(gameId), mod?.meta);
    if (text) recordLine.textContent = `🏆 Your record: ${text}`;
    else recordLine.remove();
    refresh();
  });
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
  const gameId = game.engine || game.id;
  const engine = await loadEngine(gameId);
  if (!engine) return toast(`${game.name} is still in development.`, 'warn');
  // Open on the rules this player last played with, where the engine keeps them.
  const options = gameLoadout(gameId);
  // A long solo game can leave a run half-played (see meta.record.resume): offer
  // to pick it up rather than starting over on top of it.
  const saved = resumableRun(gameId, engine);
  if (saved) {
    const body = el('div', { class: 'col' },
      el('p', { class: 'muted', text: `You have a run in progress: ${saved.label || 'where you left off'}${saved.savedAt ? ` - saved ${timeAgo(saved.savedAt)}` : ''}.` }),
      el('div', { class: 'row' },
        btn('Continue', () => {
          handle.close();
          resumeSoloRun(game, saved);
        }, { variant: 'primary' }),
        btn('Start fresh', () => {
          handle.close();
          // Mount first, then forget: a live host checkpoints the run it is
          // playing on the way out, which would write the old run straight back
          // over the discard.
          window.__mountGame({ mode: 'solo', game, engine, options });
          clearGameProgress(gameId);
        }),
      ),
    );
    const handle = modal(`Resume ${game.name}?`, body);
    return;
  }
  window.__mountGame({ mode: 'solo', game, engine, options });
}

export async function startLocalGame(game) {
  const engine = await loadEngine(game.engine || game.id);
  if (!engine) return toast(`${game.name} is still in development.`, 'warn');
  const body = el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'How many humans are sharing this device? Bots fill the remaining seats.' }),
    el('div', { class: 'row' },
      ...[2, 3, 4].map((n) => btn(`${n} players`, () => {
        handle.close();
        window.__mountGame({ mode: 'local', game, engine, humans: n, options: gameLoadout(game.engine || game.id) });
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
  const id = game.engine || game.id;
  // The lobby presets the host's remembered rules; an explicit choice wins.
  joinRoom({ gameId: id, options: { ...gameLoadout(id), ...options }, fillBots: !!options.fillBots, botLevel: 2 });
  window.__setView('play');
}

export async function startBotRoom(game) {
  state.localGame = null;
  const id = game.engine || game.id;
  joinRoom({ gameId: id, fillBots: true, options: gameLoadout(id) });
  window.__setView('play');
}

/* ------------------------------------------------------------------ *
 * servers - every open table, across every game
 * ------------------------------------------------------------------ */

/**
 * The arcade's table list.
 *
 * The play sheet answers "who is playing *this* game"; this answers "who is
 * playing anything" - every open room across every game, each with the rules
 * it will play by, so joining a table (rather than opening one) is the normal
 * way in.  The socket keeps it live while it is on screen (the 'lobby' handler
 * in main.js calls the redraw hook this view installs, which is why a table
 * appearing does not wipe the filters or a half-typed search), and a REST read
 * fills it immediately for a player who arrives before the socket's first push.
 */
views.lobby = (mount) => {
  const filters = { game: '', state: '', seats: false, q: '' };
  const rows = el('div', { class: 'col' });
  const summary = el('p', { class: 'muted small', text: 'Looking for open tables…' });

  const maxSeats = (room) => Number(room.game?.players?.max || 0) + Number(room.game?.maxBots || 0);
  const hasSeat = (room) => room.status !== 'playing' && room.players.length < (maxSeats(room) || Infinity);

  /** The game picker only lists games that actually have a table right now. */
  const openGames = () => {
    const ids = [...new Set((state.lobby || []).map((r) => r.gameId))];
    return ids
      .map((id) => state.catalog.find((g) => (g.engine || g.id) === id) || { id, name: id })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };

  const gameSel = el('select', { class: 'input', title: 'Only tables playing this game' });
  const stateSel = el('select', { class: 'input', title: 'Only tables in this state' },
    el('option', { value: '', text: 'Any table' }),
    el('option', { value: 'open', text: 'Filling up' }),
    el('option', { value: 'playing', text: 'In progress' }));
  const seatBox = el('input', { type: 'checkbox', id: 'servers-seats' });
  const search = el('input', { class: 'input', placeholder: 'Host, game or code…' });

  const matches = (room) => {
    if (filters.game && room.gameId !== filters.game) return false;
    if (filters.state === 'open' && room.status === 'playing') return false;
    if (filters.state === 'playing' && room.status !== 'playing') return false;
    if (filters.seats && !hasSeat(room)) return false;
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    const host = room.players.find((p) => p.id === room.host)?.name || '';
    return `${host} ${room.game?.name || room.gameId} ${room.code}`.toLowerCase().includes(q);
  };

  /** One table: who is at it, the rules it will play by, and the way in. */
  const tableRow = (room) => {
    const max = maxSeats(room) || room.players.length;
    const humans = room.players.filter((p) => p.kind !== 'bot').length;
    const host = room.players.find((p) => p.id === room.host)?.name || 'someone';
    const join = hasSeat(room);
    return el('div', { class: 'room-row' },
      el('span', { class: 'icon', text: room.game?.icon || '🎮' }),
      el('div', { class: 'name' },
        el('strong', { text: room.game?.name || room.gameId }),
        el('div', { class: 'muted small', text: `host ${host} · ${room.status === 'playing' ? 'in progress' : 'filling up'} · ${humans} player${humans === 1 ? '' : 's'} · ${room.players.length}/${max} seats${room.spectators ? ` · ${room.spectators} watching` : ''}` }),
        el('div', { class: 'row' }, el('span', { class: 'muted small', text: 'rules:' }), roomRulesLine(room)),
      ),
      pill(room.code),
      room.autoStartAt > Date.now() ? pill('starting soon', 'good') : null,
      join
        ? btn('Join', () => openTable(room), { variant: 'primary', cls: 'sm' })
        : room.status === 'playing'
          ? (featureOn('spectate') ? btn('Watch', () => openTable(room, true), { cls: 'sm' }) : pill('in progress'))
          : pill('full'),
    );
  };

  const draw = () => {
    // Called again after the view is gone (a lobby push racing a view switch):
    // a detached list must not try to redraw itself.
    if (!rows.isConnected) {
      if (window.__redrawServers === draw) window.__redrawServers = null;
      return;
    }
    const games = openGames();
    if (filters.game && !games.some((g) => g.id === filters.game)) filters.game = '';
    gameSel.replaceChildren(
      el('option', { value: '', text: 'All games' }),
      ...games.map((g) => el('option', { value: g.id, text: `${g.icon || '🎮'} ${g.name}` })));
    gameSel.value = filters.game;

    const all = state.lobby || [];
    const list = all.filter(matches).sort((a, b) =>
      (hasSeat(b) ? 1 : 0) - (hasSeat(a) ? 1 : 0)
      || b.players.length - a.players.length
      || (b.updatedAt || 0) - (a.updatedAt || 0));
    const seats = all.filter(hasSeat).length;
    const seated = all.reduce((n, r) => n + r.players.length, 0);
    summary.textContent = !all.length
      ? 'No public tables are open right now.'
      : list.length === all.length
        ? `${all.length} open table${all.length === 1 ? '' : 's'} · ${seats} with a free seat · ${seated} seated`
        : `${list.length} of ${all.length} tables shown · ${seats} with a free seat · ${seated} seated`;

    if (!all.length) {
      rows.replaceChildren(el('div', { class: 'card muted' },
        el('p', { text: 'Nobody has a table open. Be the host - pick a game and open one, and it shows up here for everyone.' }),
        el('div', { class: 'row' },
          btn('Browse games', () => window.__setView('catalog'), { variant: 'primary' }),
          btn('Join by code', () => promptJoinCode(), { cls: 'sm' }))));
      return;
    }
    rows.replaceChildren(...list.map(tableRow));
    if (!list.length) rows.appendChild(el('div', { class: 'card muted', text: 'No table matches those filters.' }));
  };

  /** Join (or watch) the fullest table the filters allow. */
  const quickJoin = () => {
    const list = (state.lobby || []).filter(matches).filter(hasSeat)
      .sort((a, b) => b.players.length - a.players.length || (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!list.length) {
      toast('No open table has a free seat - open one, or join by code.', 'warn');
      return;
    }
    toast(`Sitting down at ${list[0].game?.name || list[0].gameId} · ${list[0].code}`, 'good');
    openTable(list[0]);
  };

  /** Subscribe to the live list and read the current one over REST. */
  const refresh = () => {
    rt.send({ t: 'lobby' });
    fetchRooms().then((list) => {
      if (list.length || !(state.lobby || []).length) state.lobby = list;
      draw();
    });
  };

  gameSel.addEventListener('change', () => { filters.game = gameSel.value; draw(); });
  stateSel.addEventListener('change', () => { filters.state = stateSel.value; draw(); });
  seatBox.addEventListener('change', () => { filters.seats = seatBox.checked; draw(); });
  search.addEventListener('input', () => { filters.q = search.value; draw(); });

  mount.appendChild(el('div', { class: 'card' },
    el('h1', { text: 'Servers' }),
    el('p', { class: 'muted', text: 'Every open table across every game, with the rules it will play by. A table that fills up starts on its own.' }),
    el('div', { class: 'row' },
      btn('⚡ Quick join', quickJoin, { variant: 'primary' }),
      btn('Refresh', () => refresh(), { cls: 'sm' }),
      btn('Join by code', () => promptJoinCode(), { cls: 'sm' }),
      inParty() ? btn('Start party game', () => startPartyGame(), { cls: 'sm' }) : null,
    ),
    el('div', { class: 'row filter-bar' },
      el('span', { class: 'muted small', text: 'Filter' }),
      gameSel,
      stateSel,
      el('label', { class: 'keep-picker', for: 'servers-seats' }, seatBox, el('span', { text: 'Free seat only' })),
      search),
    summary,
    rows,
  ));
  window.__redrawServers = draw;
  draw();
  refresh();
};

/** Sit at a table - or watch one that is already playing - from anywhere. */
function openTable(room, spectate = false) {
  state.localGame = null;
  rt.send({ t: 'room', op: spectate ? 'spectate' : 'join', roomId: room.id });
  window.__setView('play');
}

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
  const live = el('div', { class: 'col' }, accepted.map((f) => friendRow(f, [
    featureOn('dm') ? btn('DM', () => { window.__openDm(f.id); }, { cls: 'sm' }) : null,
    featureOn('parties') ? btn('Invite', () => inviteToParty(f), { cls: 'sm' }) : null,
    btn('Remove', () => confirmDialog('Remove friend', `Remove ${f.name} from your friends?`, () => rt.send({ t: 'friend', op: 'remove', userId: f.id })), { cls: 'sm' }),
  ])));
  mount.appendChild(live);

  // An accepted request or a presence flip has to appear on this screen by
  // itself - the sidebar already updates, so a stale Friends tab just looks
  // broken.  The redraw only fires when the ids/statuses really changed, so
  // typing a username into the box is not interrupted by idle traffic.
  const signature = () => state.friends.map((f) => `${f.id}:${f.friendStatus}:${f.presence}`).join('|');
  let seen = signature();
  const stop = onChange(() => {
    if (!live.isConnected) {
      stop();
      return;
    }
    const next = signature();
    if (next === seen) return;
    seen = next;
    window.__render();
  });
};

/**
 * Most parties start with an invite, so an invite with no party opens one on
 * the spot: the socket applies both ops in order, and the alternative - a
 * cheerful "Invited pixelpal" followed by "You are not in a party." - is a
 * dead end for the one flow this button exists for.
 */
export function inviteToParty(friend) {
  if (!state.party) partyOp('create');
  partyOp('invite', { userId: friend.id });
  toast(`Invited ${friend.name} to your party`, 'good');
}

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
    ...(featureOn('dm') ? state.conversations.slice(0, 8).map((c) => chatTab('dm', c.name, scope, target, c.userId)) : []),
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
