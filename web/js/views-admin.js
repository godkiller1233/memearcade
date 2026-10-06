/**
 * Admin console - the control room for the arcade.
 *
 * Everything here is server-gated (staff for the panel, admin for site
 * settings / broadcast / bot secret); the UI only hides what the server would
 * refuse anyway.  One tab is in charge at a time and each tab re-fetches on
 * its own, so the panel never shows stale players, rooms or reports.
 */
import { el, btn, pill, avatar, toast, modal, confirmDialog, timeAgo, fmtNum, clear } from './dom.js';
import { state, isStaff, isAdmin } from './store.js';
import { api } from './api.js';
import { rt } from './realtime.js';

/* `admin: true` tabs are owner/admin-only. Moderators get a smaller panel on
 * purpose (Players, Rooms, Reports) - the owner-only tabs are never shown to
 * them, so the server never has to refuse a button they can see. */
const TABS = [
  { id: 'overview', label: '📊 Overview', admin: true },
  { id: 'players', label: '👥 Players' },
  { id: 'site', label: '🎛️ Site', admin: true },
  { id: 'rooms', label: '🎮 Rooms' },
  { id: 'reports', label: '📨 Reports' },
  { id: 'ideas', label: '💡 Ideas', admin: true },
  { id: 'audit', label: '📜 Audit', admin: true },
  { id: 'bot', label: '🤖 Discord bot', admin: true },
];

let adminTab = 'overview';
let roomTimer = null;
/** Every async draw takes a ticket; only the newest ticket may paint. */
let drawTicket = 0;

export function adminView(mount) {
  if (!isStaff()) {
    mount.appendChild(el('div', { class: 'card' },
      el('h1', { text: '🛡️ Admin console' }),
      el('p', { class: 'muted', text: 'This area is for staff accounts only. If you believe you should have access, ask the arcade owner to set your role.' })));
    return;
  }

  const tabs = TABS.filter((t) => !t.admin || isAdmin());
  // A moderator's tab list has no Overview, so land on their first tab
  // instead of drawing one they are not allowed to see.
  if (!tabs.some((t) => t.id === adminTab)) adminTab = tabs[0]?.id || 'overview';

  const head = el('div', { class: 'card' },
    el('div', { class: 'row spread' },
      el('div', { class: 'row' },
        el('span', { class: 'icon', text: '🛡️' }),
        el('h1', { text: 'Admin console' }),
        pill(isAdmin() ? 'owner/admin' : 'moderator', 'good'),
      ),
      el('div', { class: 'row admin-toolbar' },
        btn('↻ Refresh', () => drawTab(adminTab), { cls: 'sm' }),
        // Broadcasting is admin-only; moderators should not see a button the server refuses.
        isAdmin() ? btn('📣 Broadcast', () => broadcastDialog(), { variant: 'primary', cls: 'sm' }) : null,
      ),
    ),
    el('p', { class: 'muted small', text: `Signed in as ${state.me?.name || 'staff'}. Everything here is live for every player on this server.` }),
    el('div', { class: 'tabs-list admin-tabs' }, tabs.map((t) => btn(t.label, () => { adminTab = t.id; paintTabs(); drawTab(t.id, mount); }, { cls: `sm tab-${t.id}${adminTab === t.id ? ' primary' : ''}` }))),
  );
  const body = el('div', { class: 'col', id: 'admin-body' });
  mount.appendChild(head);
  mount.appendChild(body);

  const paintTabs = () => {
    for (const t of tabs) {
      const node = head.querySelector(`.tab-${t.id}`);
      if (node) node.classList.toggle('primary', t.id === adminTab);
    }
  };

  function drawTab(id, mnt = mount) {
    if (!tabs.some((t) => t.id === id)) id = tabs[0]?.id || id; // never draw a hidden tab
    clearTimeout(roomTimer);
    roomTimer = null;
    const ticket = ++drawTicket;
    const still = () => ticket === drawTicket && mnt.isConnected;
    clear(body);
    body.appendChild(el('div', { class: 'card muted', text: 'Loading…' }));
    const draw = (nodes) => {
      if (!still()) return;
      clear(body);
      for (const n of nodes) body.appendChild(n);
    };
    const fail = (err) => draw([el('div', { class: 'card' }, el('p', { class: 'error', text: err.message || 'Something went wrong.' }))]);
    ({ overview: drawOverview, players: drawPlayers, site: drawSite, rooms: drawRooms, reports: drawReports, ideas: drawIdeas, audit: drawAudit, bot: drawBot })[id](draw, fail, mnt);
  }

  paintTabs();
  drawTab(adminTab);
}

/* ------------------------------------------------------------------ *
 * overview *
 * ------------------------------------------------------------------ */

function drawOverview(draw, fail) {
  api.get('/api/admin/overview').then((res) => {
    const s = res.stats;
    const cards = [
      stat('Accounts', fmtNum(s.users)),
      stat('Online now', fmtNum(s.online)),
      stat('Rooms', `${s.rooms?.rooms ?? 0}`),
      stat('Players in rooms', fmtNum(s.rooms?.players ?? 0)),
      stat('Games played', fmtNum(s.gamesPlayed)),
      stat('Peak online', fmtNum(s.peakOnline)),
      stat('Open reports', fmtNum(res.reports?.open ?? 0)),
      stat('Open ideas', fmtNum(res.suggestions?.open ?? 0)),
      stat('Memory', `${s.memoryMb} MB`),
      stat('Uptime', uptimeText(s.uptime)),
      stat('Node', s.node),
    ];
    const nodes = [
      el('div', { class: 'card' }, el('h3', { text: 'At a glance' }), el('div', { class: 'stat-grid' }, cards)),
    ];
    if (res.engineErrors?.length) {
      nodes.push(el('div', { class: 'card' },
        el('h3', { text: '⚠️ Engine load failures' }),
        el('div', { class: 'col' }, res.engineErrors.map((e) => el('div', { class: 'muted small mono', text: `${e.file}: ${e.error}` })))));
    }
    nodes.push(el('div', { class: 'card' },
      el('h3', { text: 'Most played' }),
      (res.topGames || []).length
        ? el('div', { class: 'row' }, res.topGames.map((g) => {
            const game = state.catalog.find((x) => x.id === g.id);
            return pill(`${game?.icon || '🎮'} ${game?.name || g.id} ×${g.plays}`);
          }))
        : el('p', { class: 'muted', text: 'No games played yet.' })));
    draw(nodes);
  }).catch(fail);
}

function stat(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-num', text: String(value) }), el('div', { class: 'muted small', text: label }));
}

function uptimeText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/* ------------------------------------------------------------------ *
 * players *
 * ------------------------------------------------------------------ */

function drawPlayers(draw, fail) {
  let query = '';
  const search = el('input', { class: 'input', placeholder: 'Search users…', style: { maxWidth: '280px' } });
  const table = el('div', { class: 'admin-scroll' });
  let loadTimer = null;
  const load = () => api.get(`/api/admin/users?q=${encodeURIComponent(query)}&limit=80`).then((res) => {
    if (!table.isConnected) return;
    table.replaceChildren(playersTable(res.users || [], load));
  }).catch((err) => {
    if (!table.isConnected) return;
    table.replaceChildren(el('p', { class: 'error', text: err.message }));
  });
  search.addEventListener('input', () => {
    query = search.value.trim();
    clearTimeout(loadTimer);
    loadTimer = setTimeout(load, 250);
  });
  draw([
    el('div', { class: 'card' },
      el('div', { class: 'row spread admin-toolbar' },
        el('div', { class: 'row' }, search, btn('↻', () => load(), { cls: 'sm', title: 'Refresh' })),
        el('span', { class: 'muted small', text: 'Ban, promote, grant coins, reset passwords, kick or delete an account.' }),
      ),
      table,
    ),
  ]);
  load();

  function playersTable(users, reload) {
    const rerun = (promise) => promise.then(() => reload());
    return el('table', { class: 'admin-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'User' }), el('th', { text: 'Role' }), el('th', { text: 'Level' }),
        el('th', { text: 'Games' }), el('th', { text: 'Wins' }), el('th', { text: 'Created' }),
        el('th', { text: 'Last seen' }), el('th', { text: 'State' }), el('th', { text: 'Actions' }))),
      el('tbody', {}, users.map((u) => el('tr', { class: u.banned ? 'banned-row' : '' },
        el('td', {}, el('div', { class: 'row' }, avatar(u, 22), el('span', { text: u.name }))),
        el('td', { text: u.role }),
        el('td', { text: u.level ?? 1 }),
        el('td', { text: u.stats?.games ?? 0 }),
        el('td', { text: u.stats?.wins ?? 0 }),
        el('td', { text: timeAgo(u.createdAt) }),
        el('td', { text: timeAgo(u.lastSeen) }),
        el('td', {}, u.banned
          ? pill(u.banned.until ? `banned until ${new Date(u.banned.until).toLocaleDateString()}` : 'banned forever', 'danger')
          : pill(u.presence || 'offline', u.presence === 'online' ? 'good' : '')),
        el('td', {}, el('div', { class: 'row actions' },
          u.banned
            ? btn('Unban', () => rerun(adminPost(`/api/admin/users/${u.id}`, { op: 'unban' })), { cls: 'sm' })
            : btn('Ban', () => banDialog(u), { cls: 'sm danger' }),
          btn('Role', () => roleDialog(u, rerun), { cls: 'sm' }),
          btn('Grant', () => grantDialog(u, rerun), { cls: 'sm' }),
          btn('Reset PW', () => rerun(resetDialog(u)), { cls: 'sm' }),
          btn('Kick', () => confirmDialog('Kick player', `Disconnect ${u.name} from the arcade?`, () => rerun(adminPost(`/api/admin/users/${u.id}`, { op: 'kick', reason: 'Removed by an admin' })), { yes: 'Kick' }), { cls: 'sm' }),
          btn('Delete', () => confirmDialog('Delete account', `Permanently delete ${u.name}? This cannot be undone.`, () => rerun(adminPost(`/api/admin/users/${u.id}`, { op: 'delete', reason: 'admin action' })), { yes: 'Delete', danger: true }), { cls: 'sm danger' }),
        )),
      ))),
    );
  }

  function banDialog(user) {
    const reason = el('input', { class: 'input', placeholder: 'Reason shown to them', value: 'Breaking the arcade rules' });
    const days = el('select', { class: 'input' },
      [[1, '1 day'], [3, '3 days'], [7, '7 days'], [30, '30 days'], [0, 'Permanent']].map(([v, label]) => el('option', { value: String(v), text: label, selected: v === 7 })));
    const handle = modal(`Ban ${user.name}`, el('div', { class: 'col' },
      el('label', {}, 'Reason', reason),
      el('label', {}, 'Duration', days),
      el('div', { class: 'row' },
        btn('Ban account', () => {
          handle.close();
          adminPost(`/api/admin/users/${user.id}`, { op: 'ban', reason: reason.value, days: Number(days.value) || 0 });
        }, { variant: 'danger' }),
        btn('Cancel', () => handle.close()))));
  }

  function roleDialog(user, rerun) {
    const handle = modal(`Role for ${user.name}`, el('div', { class: 'row' },
      ...['user', 'vip', 'mod', 'admin', 'owner'].map((r) => btn(r, () => {
        handle.close();
        rerun(adminPost(`/api/admin/users/${user.id}`, { op: 'role', role: r }));
      }, { cls: 'sm' }))));
  }

  function grantDialog(user, rerun) {
    const coins = el('input', { class: 'input', type: 'number', value: '500', style: { width: '110px' } });
    const xp = el('input', { class: 'input', type: 'number', value: '100', style: { width: '110px' } });
    const handle = modal(`Grant to ${user.name}`, el('div', { class: 'col' },
      el('div', { class: 'row' }, el('label', { class: 'row' }, 'Coins', coins), el('label', { class: 'row' }, 'XP', xp)),
      el('div', { class: 'row' },
        btn('Grant', () => {
          handle.close();
          rerun(adminPost(`/api/admin/users/${user.id}`, { op: 'grant', coins: Number(coins.value) || 0, xp: Number(xp.value) || 0 }));
        }, { variant: 'primary' }),
        btn('Cancel', () => handle.close()))));
  }

  function resetDialog(user) {
    return adminPost(`/api/admin/users/${user.id}`, { op: 'reset-password' }).then((res) => {
      if (!res?.password) return res;
      const code = el('code', { class: 'mono', text: res.password });
      const handle = modal(`New password for ${user.name}`, el('div', { class: 'col' },
        el('p', { class: 'muted', text: 'Share it privately; they can change it in Settings → Account.' }),
        el('div', { class: 'row' }, code, btn('Copy', () => navigator.clipboard?.writeText(res.password).then(() => toast('Copied', 'good')), { cls: 'sm' })),
        btn('Done', () => handle.close(), { variant: 'primary' })));
      return res;
    });
  }
}

/* ------------------------------------------------------------------ *
 * site settings *
 * ------------------------------------------------------------------ */

function drawSite(draw, fail) {
  api.get('/api/admin/overview').then((res) => {
    const config = res.config || {};
    const motd = el('input', { class: 'input', value: config.motd || '' });
    const announcement = el('input', { class: 'input', value: config.announcement || '' });
    const registrations = el('input', { type: 'checkbox', checked: config.registrationsOpen !== false });
    const maintenance = el('input', { type: 'checkbox', checked: !!config.maintenance });
    const maxRooms = el('input', { class: 'input', type: 'number', min: 1, max: 1000, value: String(config.maxRooms ?? 200), style: { width: '110px' } });
    const maxParty = el('input', { class: 'input', type: 'number', min: 2, max: 64, value: String(config.maxPartySize ?? 16), style: { width: '110px' } });
    const featured = new Set(config.featured || []);
    const picker = el('div', { class: 'feature-pick' });
    const playable = state.catalog.filter((g) => g.playable);
    const paintPicker = () => {
      picker.replaceChildren(...playable.map((g) => btn(`${g.icon} ${g.name}`, () => {
        if (featured.has(g.id)) featured.delete(g.id);
        else featured.add(g.id);
        paintPicker();
      }, { cls: `sm${featured.has(g.id) ? ' primary' : ''}` })));
    };
    paintPicker();

    const save = async () => {
      const saved = await adminPost('/api/admin/config', {
        motd: motd.value,
        announcement: announcement.value,
        registrationsOpen: registrations.checked,
        maintenance: maintenance.checked,
        maxRooms: Number(maxRooms.value) || 200,
        maxPartySize: Number(maxParty.value) || 16,
        featured: playable.filter((g) => featured.has(g.id)).map((g) => g.id),
      });
      if (!saved) return;
      state.serverConfig = { ...(state.serverConfig || {}), ...(saved.config || {}) };
      toast('Site settings saved', 'good');
      window.__render?.();
    };

    draw([
      el('div', { class: 'card' },
        el('h3', { text: '🏠 Front page' }),
        el('label', {}, 'Message of the day (home header)', motd),
        el('label', {}, 'Announcement banner (top of every page)', announcement),
        el('p', { class: 'muted small', text: 'Leave the banner empty to hide it. Broadcasts also set it.' }),
        el('h3', { text: '⭐ Featured games' }),
        el('p', { class: 'muted small', text: 'Shown in the Featured row on the home page.' }),
        picker,
      ),
      el('div', { class: 'card' },
        el('h3', { text: '🚦 Access' }),
        toggle('Registrations open', registrations.checked, (v) => { registrations.checked = v; }),
        toggle('Maintenance mode (staff only can connect)', maintenance.checked, (v) => {
          if (!v) return;
          maintenance.checked = false; // only arm it once the admin confirms
          const handle = modal('Enable maintenance mode?', el('div', { class: 'col' },
            el('p', { text: 'Everyone except staff will be signed out until you turn it off. Continue?' }),
            el('div', { class: 'row' },
              btn('Enable', () => { handle.close(); maintenance.checked = true; }, { variant: 'danger' }),
              btn('Cancel', () => handle.close()))));
        }),
        el('div', { class: 'row' },
          el('label', { class: 'row' }, 'Max rooms', maxRooms),
          el('label', { class: 'row' }, 'Max party size', maxParty)),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          btn('Save site settings', () => save(), { variant: 'primary' }),
          btn('Send broadcast now', () => broadcastDialog(), { cls: 'sm' }),
        ),
      ),
    ]);
  }).catch(fail);
}

function toggle(label, checked, onChange) {
  return el('label', { class: 'row' },
    el('input', { type: 'checkbox', checked: !!checked, onChange: (ev) => onChange(ev.target.checked) }),
    label);
}

function broadcastDialog() {
  const input = el('input', { class: 'input', placeholder: 'Message for everyone online' });
  const handle = modal('Broadcast', el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'Pops a toast for everyone online right now, and sets it as the site announcement banner.' }),
    input,
    btn('Send to everyone', async () => {
      const res = await adminPost('/api/admin/broadcast', { text: input.value });
      if (res) {
        handle.close();
        // The server persists it as the banner: show it without waiting for a reload.
        state.serverConfig = { ...(state.serverConfig || {}), announcement: input.value };
        window.__render?.();
        toast('Broadcast sent', 'good');
      }
    }, { variant: 'primary' })));
}

/* ------------------------------------------------------------------ *
 * live rooms *
 * ------------------------------------------------------------------ */

function drawRooms(draw, fail, mount) {
  const box = el('div', { class: 'admin-scroll' });
  const summary = el('span', { class: 'muted small' });
  const load = async () => {
    try {
      const res = await api.get('/api/admin/rooms');
      if (!box.isConnected) return;
      summary.textContent = `${res.stats?.rooms ?? 0} room(s) · ${res.stats?.players ?? 0} seated player(s) · auto-refresh every 5s`;
      box.replaceChildren(roomsTable(res.rooms || [], load));
    } catch (err) {
      if (!box.isConnected) return;
      box.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  };
  draw([
    el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' }, el('h3', { text: 'Live rooms' }), btn('↻', () => load(), { cls: 'sm', title: 'Refresh' })),
        summary,
      ),
      box,
    ),
  ]);
  load();
  roomTimer = setInterval(() => {
    if (!mount.isConnected) {
      clearTimeout(roomTimer);
      roomTimer = null;
      return;
    }
    load();
  }, 5000);

  function roomsTable(list, reload) {
    if (!list.length) return el('p', { class: 'muted', text: 'No open rooms right now.' });
    return el('table', { class: 'admin-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Game' }), el('th', { text: 'Code' }), el('th', { text: 'Host' }),
        el('th', { text: 'Status' }), el('th', { text: 'Players' }), el('th', { text: 'Watchers' }),
        el('th', { text: 'Idle' }), el('th', { text: 'Actions' }))),
      el('tbody', {}, list.map((room) => el('tr', {},
        el('td', {}, el('div', { class: 'row' }, el('span', { text: room.game?.icon || '🎮' }), room.game?.name || room.gameId)),
        el('td', { text: room.code }),
        el('td', { text: room.hostName || '—' }),
        el('td', {}, pill(room.status, room.status === 'playing' ? 'good' : '')),
        el('td', { text: room.players?.length ?? 0 }),
        el('td', { text: room.spectators ?? 0 }),
        el('td', { text: timeAgo(Date.now() - (room.idleMs || 0)) }),
        el('td', {}, el('div', { class: 'row' },
          btn(room.status === 'playing' ? 'Watch' : 'Join', () => {
            rt.send({ t: 'room', op: room.status === 'playing' ? 'spectate' : 'join', roomId: room.id });
            window.__setView('play');
          }, { cls: 'sm' }),
          btn('Close', () => confirmDialog('Close room', `Close room ${room.code}? Everyone is dropped back to the lobby.`, () => adminPost(`/api/admin/rooms/${room.id}`, { op: 'close' }).then(reload), { yes: 'Close', danger: true }), { cls: 'sm danger' }),
        )),
      ))),
    );
  }
}

/* ------------------------------------------------------------------ *
 * report inbox *
 * ------------------------------------------------------------------ */

function drawReports(draw, fail) {
  let filter = 'open';
  const list = el('div', { class: 'col' });
  const head = el('div', { class: 'row admin-toolbar' });
  const load = async () => {
    try {
      const res = await api.get(`/api/admin/reports?status=${filter}&limit=120`);
      if (!list.isConnected) return;
      head.replaceChildren(
        ...['open', 'resolved', 'all'].map((f) => btn(f[0].toUpperCase() + f.slice(1), () => { filter = f; load(); }, { cls: `sm${filter === f ? ' primary' : ''}` })),
        el('span', { class: 'muted small', text: `${res.open} open · ${res.total} total` }),
      );
      if (!res.reports?.length) {
        list.replaceChildren(el('div', { class: 'card muted', text: filter === 'open' ? 'Inbox zero - no open reports. 🎉' : 'Nothing here.' }));
        return;
      }
      list.replaceChildren(...res.reports.map(reportCard));
    } catch (err) {
      if (list.isConnected) list.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  };

  function reportCard(r) {
    return el('div', { class: 'report-card' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' }, pill(r.kind, r.kind === 'bug' ? 'warn' : ''), el('strong', { text: r.fromName }), el('span', { class: 'muted small', text: timeAgo(r.at) })),
        r.status === 'resolved' ? pill(`resolved by ${r.resolvedBy || 'staff'}`, 'good') : pill('open', 'danger'),
      ),
      el('div', { class: 'report-text', text: r.text }),
      r.target ? el('div', { class: 'muted small mono', text: `target: ${r.target}` }) : null,
      el('div', { class: 'row' },
        r.status === 'open'
          ? btn('Resolve', () => reportOp(r.id, 'resolve'), { cls: 'sm primary' })
          : btn('Reopen', () => reportOp(r.id, 'reopen'), { cls: 'sm' }),
        btn('Delete', () => confirmDialog('Delete report', 'Remove this report from the inbox?', () => reportOp(r.id, 'delete'), { yes: 'Delete', danger: true }), { cls: 'sm danger' }),
      ),
    );
  }

  /** Resolve/reopen/delete, then refresh the inbox and the nav badge. */
  function reportOp(id, op) {
    return adminPost(`/api/admin/reports/${id}`, { op }).then(() => {
      load();
      window.__refreshAdminBadge?.();
    });
  }

  draw([
    el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h3', { text: 'Reports' }), head),
      el('p', { class: 'muted small', text: 'Sent from Settings → Report a bug, in the player\u2019s own words.' }),
    ),
    list,
  ]);
  load();
}

/* ------------------------------------------------------------------ *
 * idea board triage *
 * ------------------------------------------------------------------ */

const IDEA_STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined'];
const IDEA_STATUS_KIND = { open: '', planned: 'warn', 'in-progress': 'good', done: 'good', declined: 'danger' };
const IDEA_CATEGORY_LABEL = { game: '🎮 game', feature: '✨ feature', update: '🛠️ update', other: '💬 other' };

function drawIdeas(draw, fail) {
  let filter = 'open';
  const list = el('div', { class: 'col' });
  const head = el('div', { class: 'row admin-toolbar' });
  const load = async () => {
    try {
      const res = await api.get(`/api/suggestions?sort=top&status=${filter}&category=all`);
      if (!list.isConnected) return;
      head.replaceChildren(
        ...['open', ...IDEA_STATUSES.filter((s) => s !== 'open'), 'all'].map((f) =>
          btn(f === 'all' ? 'All' : f === 'in-progress' ? 'In progress' : f[0].toUpperCase() + f.slice(1), () => { filter = f; load(); }, { cls: `sm${filter === f ? ' primary' : ''}` })),
        el('span', { class: 'muted small', text: `${res.counts?.open || 0} open · ${res.total} total` }),
      );
      if (!res.suggestions?.length) {
        list.replaceChildren(el('div', { class: 'card muted', text: filter === 'open' ? 'No open ideas waiting for triage. 🎉' : 'Nothing here.' }));
        return;
      }
      list.replaceChildren(...res.suggestions.map(ideaCard));
    } catch (err) {
      if (list.isConnected) list.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  };

  function ideaCard(s) {
    const statusRow = el('div', { class: 'row' },
      ...IDEA_STATUSES.map((st) => btn(st === 'in-progress' ? 'In progress' : st[0].toUpperCase() + st.slice(1), () => ideaOp(s.id, { op: 'update', status: st }), { cls: `sm${s.status === st ? ' primary' : ''}` })),
    );
    return el('div', { class: 'report-card' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' }, pill(IDEA_CATEGORY_LABEL[s.category] || s.category), el('strong', { text: s.title }),
        el('span', { class: 'muted small', text: `▲ ${s.votes}` })),
        pill(s.status, IDEA_STATUS_KIND[s.status] || ''),
      ),
      el('div', { class: 'report-text', text: s.text }),
      s.adminNote ? el('div', { class: 'suggestion-note', text: `${s.adminName || 'staff'}: ${s.adminNote}` }) : null,
      el('div', { class: 'muted small', text: `by ${s.fromName} · ${timeAgo(s.at)}` }),
      statusRow,
      el('div', { class: 'row' },
        btn('📝 Staff note', () => noteDialog(s), { cls: 'sm' }),
        btn('Delete', () => confirmDialog('Delete idea', 'Remove this idea from the board?', () => ideaOp(s.id, { op: 'delete' }), { yes: 'Delete', danger: true }), { cls: 'sm danger' }),
      ),
    );
  }

  function noteDialog(s) {
    const note = el('input', { class: 'input', value: s.adminNote || '', placeholder: 'Public status note (empty to clear)' });
    const handle = modal('Staff note', el('div', { class: 'col' },
      el('p', { class: 'muted', text: 'Shown on the idea so players know why it is planned, declined or shipped.' }),
      note,
      el('div', { class: 'row' },
        btn('Save note', () => { handle.close(); ideaOp(s.id, { op: 'update', note: note.value }); }, { variant: 'primary' }),
        btn('Cancel', () => handle.close()))));
  }

  /** Triage op, then refresh the list and the nav badge. */
  function ideaOp(id, body) {
    return adminPost(`/api/admin/suggestions/${id}`, body).then(() => {
      load();
      window.__refreshAdminBadge?.();
    });
  }

  draw([
    el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h3', { text: 'Idea board' }), head),
      el('p', { class: 'muted small', text: 'Ideas posted from the public board. Set a status, leave a note, or remove off-topic ones.' }),
    ),
    list,
  ]);
  load();
}

/* ------------------------------------------------------------------ *
 * audit log *
 * ------------------------------------------------------------------ */

function drawAudit(draw, fail) {
  const filter = el('input', { class: 'input', placeholder: 'Filter by action, actor or target…', style: { maxWidth: '320px' } });
  const box = el('div', { class: 'admin-scroll' });
  let entries = [];
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = entries.filter((e) => !q || `${e.action} ${e.actorName || ''} ${e.target || ''}`.toLowerCase().includes(q));
    box.replaceChildren(rows.length
      ? el('div', { class: 'col' }, rows.map((e) => el('div', { class: 'audit-row' },
          el('span', { class: 'muted small mono', text: new Date(e.at).toLocaleString() }),
          el('span', { text: ` · ${e.actorName || 'system'} · ${e.action}` }),
          e.target ? el('span', { class: 'muted', text: ` → ${e.target}` }) : null)))
      : el('p', { class: 'muted', text: 'No matching entries.' }));
  };
  filter.addEventListener('input', paint);
  api.get('/api/admin/audit?limit=200').then((res) => {
    entries = res.entries || [];
    paint();
  }).catch((err) => box.replaceChildren(el('p', { class: 'error', text: err.message })));
  draw([
    el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h3', { text: 'Audit log' }), filter),
      el('p', { class: 'muted small', text: 'Moderation, config changes, broadcasts, reports and room closes. Newest first.' }),
      box,
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * discord bot *
 * ------------------------------------------------------------------ */

function drawBot(draw, fail) {
  api.get('/api/bot/secret').then((res) => {
    draw([
      el('div', { class: 'card' },
        el('h3', { text: '🤖 Discord bot bridge' }),
        el('p', { class: 'muted small', text: 'Put this in bot/.env as ARCADE_BOT_SECRET. The bot sends it as the X-Bot-Token header to link accounts and post results.' }),
        el('div', { class: 'row' },
          el('code', { class: 'mono', text: res.secret }),
          btn('Copy', () => navigator.clipboard?.writeText(res.secret).then(() => toast('Copied', 'good'), () => toast(res.secret)), { cls: 'sm' })),
        el('p', { class: 'muted small', text: 'On a hosted server set MEMES_BOT_SECRET instead so redeploys keep the same token.' }),
      ),
    ]);
  }).catch(fail);
}

/* ------------------------------------------------------------------ *
 * shared helpers *
 * ------------------------------------------------------------------ */

/** POST to an admin endpoint; failures toast and resolve to null. */
async function adminPost(path, body) {
  try {
    return await api.post(path, body);
  } catch (err) {
    toast(err.message || 'That did not work.', 'bad');
    return null;
  }
}
