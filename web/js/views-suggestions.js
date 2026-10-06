/**
 * The idea board: suggest new games, features and updates, then vote on what
 * the arcade builds next.
 *
 * Reads come over REST; the WebSocket only pings when someone else changes
 * the board (the 'suggestions:changed' handler in main.js calls back here).
 */
import { el, btn, pill, toast, modal, timeAgo, fmtNum } from './dom.js';
import { api } from './api.js';
import { rt } from './realtime.js';

const CATEGORIES = [
  { id: 'game', label: '🎮 New game' },
  { id: 'feature', label: '✨ Feature' },
  { id: 'update', label: '🛠️ Update' },
  { id: 'other', label: '💬 Other' },
];
const STATUSES = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'planned', label: 'Planned' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
  { id: 'declined', label: 'Declined' },
];
const STATUS_KIND = { open: '', planned: 'warn', 'in-progress': 'good', done: 'good', declined: 'danger' };
const CATEGORY_LABEL = { game: '🎮 game', feature: '✨ feature', update: '🛠️ update', other: '💬 other' };
const STATUS_LABEL = { open: 'open', planned: 'planned', 'in-progress': 'in progress', done: 'done', declined: 'declined' };

/** Filters survive shell redraws, like the rest of the views' local state. */
let sort = 'top';
let statusFilter = 'all';
let categoryFilter = 'all';
/** Only the newest fetch may paint (filters can change while one is in flight). */
let ticket = 0;

export function suggestionsView(mount) {
  const head = el('div', { class: 'card' });
  const counts = el('span', { class: 'muted small' });
  const toolbar = el('div', { class: 'row admin-toolbar' });
  const list = el('div', { class: 'col' });
  mount.appendChild(head);
  mount.appendChild(toolbar);
  mount.appendChild(list);

  // Ask the server to ping us when someone else posts or votes. The board
  // itself is read over REST; the socket only carries the change notice.
  rt.send({ t: 'suggestions' });

  paintHead();
  paintToolbar();

  async function load({ quiet = false } = {}) {
    const mine = ++ticket;
    if (!list.isConnected) return;
    if (!quiet) list.replaceChildren(el('div', { class: 'card muted', text: 'Loading ideas…' }));
    try {
      const res = await api.get(`/api/suggestions?sort=${sort}&status=${statusFilter}&category=${categoryFilter}`);
      if (mine !== ticket || !list.isConnected) return;
      paintCounts(res);
      const items = res.suggestions || [];
      list.replaceChildren(...(items.length
        ? items.map(suggestionCard)
        : [el('div', { class: 'card muted', text: 'No ideas match those filters yet - be the first to suggest one.' })]));
    } catch (err) {
      if (mine !== ticket || !list.isConnected) return;
      list.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error', text: err.message })));
    }
  }

  /** The websocket hook: another player changed the board, so refresh quietly. */
  window.__refetchSuggestions = () => load({ quiet: true });

  function paintCounts(res) {
    const open = res.counts?.open || 0;
    const planned = res.counts?.planned || 0;
    const progress = res.counts?.['in-progress'] || 0;
    const done = res.counts?.done || 0;
    counts.textContent = `${fmtNum(res.total)} idea${res.total === 1 ? '' : 's'} · ${open} open · ${planned} planned · ${progress} in progress · ${done} shipped`;
  }

  function paintHead() {
    head.replaceChildren(
      el('div', { class: 'row spread' },
        el('div', { class: 'row' }, el('span', { class: 'icon', text: '💡' }), el('h1', { text: 'Ideas & suggestions' })),
        el('div', { class: 'row' },
          btn('📦 Changelog', () => window.__setView('changelog'), { cls: 'sm' }),
          btn('＋ Suggest something', () => suggestDialog(() => load({ quiet: true })), { variant: 'primary' })),
      ),
      el('p', { class: 'muted', text: 'What should we build next? Pitch new games, features and quality-of-life updates - then vote for the ones you want the most. Staff mark statuses as ideas get triaged.' }),
      counts,
    );
  }

  function paintToolbar() {
    toolbar.replaceChildren(
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Sort:' }),
        btn('🔥 Top voted', () => { sort = 'top'; paintToolbar(); load(); }, { cls: `sm${sort === 'top' ? ' primary' : ''}` }),
        btn('🕒 Newest', () => { sort = 'new'; paintToolbar(); load(); }, { cls: `sm${sort === 'new' ? ' primary' : ''}` })),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Status:' }),
        ...STATUSES.map((s) => btn(s.label, () => { statusFilter = s.id; paintToolbar(); load(); }, { cls: `sm${statusFilter === s.id ? ' primary' : ''}` }))),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Type:' }),
        btn('All', () => { categoryFilter = 'all'; paintToolbar(); load(); }, { cls: `sm${categoryFilter === 'all' ? ' primary' : ''}` }),
        ...CATEGORIES.map((c) => btn(c.label, () => { categoryFilter = c.id; paintToolbar(); load(); }, { cls: `sm${categoryFilter === c.id ? ' primary' : ''}` }))),
    );
  }

  function suggestionCard(s) {
    const vote = el('button', {
      class: `vote-btn${s.voted ? ' voted' : ''}`,
      title: s.voted ? 'Remove your vote' : 'Vote for this idea',
    }, el('span', { class: 'vote-arrow', text: '▲' }), el('span', { class: 'vote-count', text: String(s.votes) }));
    vote.onclick = async () => {
      try {
        const res = await api.post(`/api/suggestions/${s.id}/vote`, {});
        vote.querySelector('.vote-count').textContent = String(res.votes);
        vote.classList.toggle('voted', res.voted);
        vote.title = res.voted ? 'Remove your vote' : 'Vote for this idea';
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    return el('div', { class: 'suggestion-card' },
      vote,
      el('div', { class: 'suggestion-body' },
        el('div', { class: 'row spread' },
          el('strong', { text: s.title }),
          el('div', { class: 'row' }, pill(CATEGORY_LABEL[s.category] || s.category), pill(STATUS_LABEL[s.status] || s.status, STATUS_KIND[s.status] || ''))),
        el('div', { class: 'suggestion-text', text: s.text }),
        s.adminNote ? el('div', { class: 'suggestion-note', text: `🛡️ ${s.adminName || 'Staff'}: ${s.adminNote}` }) : null,
        el('div', { class: 'muted small', text: `by ${s.fromName} · ${timeAgo(s.at)}${s.updatedAt !== s.at ? ` · updated ${timeAgo(s.updatedAt)}` : ''}` })),
    );
  }

  load();
}

/* ------------------------------------------------------------------ *
 * the "suggest something" dialog *
 * ------------------------------------------------------------------ */

function suggestDialog(onDone) {
  let category = 'feature';
  const title = el('input', { class: 'input', placeholder: 'One line: what should we add?', maxlength: 120 });
  const text = el('textarea', { class: 'input area', placeholder: 'Describe it - what would it do, and why is it fun?', maxlength: 2000 });
  const cats = el('div', { class: 'row' });
  const paintCats = () => cats.replaceChildren(...CATEGORIES.map((c) => btn(c.label, () => {
    category = c.id;
    paintCats();
  }, { cls: `sm${category === c.id ? ' primary' : ''}` })));
  paintCats();

  const submit = async () => {
    try {
      const res = await api.post('/api/suggestions', { title: title.value, text: text.value, category });
      handle.close();
      toast('Idea posted - your vote counts. Thanks!', 'good');
      onDone?.(res.suggestion);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const handle = modal('Suggest something', el('div', { class: 'col' },
    el('p', { class: 'muted', text: 'Posted publicly with your name so others can vote on it. Staff triage ideas and note their status.' }),
    el('label', {}, 'What kind of idea?'),
    cats,
    el('label', {}, 'Title', title),
    el('label', {}, 'Details', text),
    el('div', { class: 'row' },
      btn('Post idea', submit, { variant: 'primary' }),
      btn('Cancel', () => handle.close())),
  ));
  setTimeout(() => title.focus(), 30);
}
