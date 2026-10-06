/**
 * The changelog: ideas from the board that actually shipped, newest first.
 *
 * Reads /api/changelog over REST; reuses the idea board's WebSocket
 * subscription, so a status change made by staff refreshes this page too.
 */
import { el, btn, pill, timeAgo, fmtNum } from './dom.js';
import { api } from './api.js';
import { rt } from './realtime.js';

const CATEGORY_LABEL = { game: '🎮 game', feature: '✨ feature', update: '🛠️ update', other: '💬 other' };
/** Only the newest fetch may paint (the view can be refreshed mid-flight). */
let ticket = 0;

export function changelogView(mount) {
  const head = el('div', { class: 'card' });
  const list = el('div', { class: 'col' });
  mount.appendChild(head);
  mount.appendChild(list);

  // Same watch as the board: pings when anyone posts or staff triages.
  rt.send({ t: 'suggestions' });

  paintHead();
  load();
  window.__refetchChangelog = () => load({ quiet: true });

  function paintHead() {
    head.replaceChildren(
      el('div', { class: 'row spread' },
        el('div', { class: 'row' }, el('span', { class: 'icon', text: '📦' }), el('h1', { text: 'Changelog' })),
        el('div', { class: 'row' },
          btn('💡 Idea board', () => window.__setView('suggestions'), { cls: 'sm' }),
          btn('＋ Suggest something', () => window.__setView('suggestions'), { variant: 'primary' }))),
      el('p', { class: 'muted', text: 'Everything the arcade has shipped from the idea board, newest first. Vote on open ideas to decide what lands here next.' }),
      el('span', { class: 'muted small', id: 'changelog-count', text: 'Loading…' }),
    );
  }

  async function load({ quiet = false } = {}) {
    const mine = ++ticket;
    if (!list.isConnected) return;
    if (!quiet) list.replaceChildren(el('div', { class: 'card muted', text: 'Loading shipped ideas…' }));
    try {
      const res = await api.get('/api/changelog');
      if (mine !== ticket || !list.isConnected) return;
      const count = head.querySelector('#changelog-count');
      if (count) {
        count.textContent = res.total
          ? `${fmtNum(res.total)} idea${res.total === 1 ? '' : 's'} shipped`
          : 'Nothing shipped yet';
      }
      list.replaceChildren(...(res.entries?.length
        ? res.entries.map(entry)
        : [el('div', { class: 'card muted', text: 'Nothing has shipped yet - vote on the idea board and the winners land here.' })]));
    } catch (err) {
      if (mine !== ticket || !list.isConnected) return;
      list.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error', text: err.message })));
    }
  }

  function entry(e) {
    return el('div', { class: 'changelog-entry' },
      el('div', { class: 'row spread' },
        el('div', { class: 'row' },
          pill(`📦 shipped ${timeAgo(e.shippedAt)}`, 'good'),
          pill(CATEGORY_LABEL[e.category] || e.category)),
        el('span', { class: 'muted small', text: `▲ ${e.votes} · by ${e.fromName}` })),
      el('strong', { text: e.title }),
      el('div', { class: 'suggestion-text', text: e.text }),
      e.note ? el('div', { class: 'suggestion-note', text: `🛡️ ${e.by || 'staff'}: ${e.note}` }) : null,
    );
  }
}
