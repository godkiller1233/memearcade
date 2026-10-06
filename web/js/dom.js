/** App-level DOM helpers (the game engines have their own, in ui.js). */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') applyStyle(node, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value') node.value = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['disabled', 'checked', 'selected', 'hidden'].includes(k)) node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  add(node, children);
  return node;
}

/** CSS custom properties need setProperty - Object.assign(el.style, x) drops them. */
export function applyStyle(node, style) {
  for (const [k, v] of Object.entries(style || {})) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('--')) node.style.setProperty(k, String(v));
    else node.style[k] = v;
  }
  return node;
}

function add(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  add(f, children);
  return f;
};

export function btn(label, onClick, { variant = '', cls = '', title = '', disabled = false } = {}) {
  return el('button', { class: `btn ${variant} ${cls}`.trim(), title, disabled, onClick }, label);
}

export function pill(text, kind = '') {
  return el('span', { class: `pill ${kind}`, text });
}

export function avatar(user, size = 30) {
  return el('span', {
    class: 'avatar', title: user?.name || '', text: user?.avatar || '👾',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` },
  });
}

export function toast(text, kind = '', ms = 4200, actions = []) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}` }, el('span', { text }));
  if (actions.length) {
    // Clicking an action both runs it and dismisses the toast: one click, done.
    node.appendChild(el('div', { class: 'toast-actions' },
      ...actions.map((action) => btn(action.label, () => {
        node.remove();
        action.onClick?.();
      }, { variant: action.variant || 'primary', cls: 'sm' }))));
  }
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

export function modal(title, children, { onClose = null } = {}) {
  const root = $('#modal');
  const card = clear($('#modal-card'));
  card.appendChild(el('div', { class: 'row spread' }, el('h3', { text: title }), btn('✕', close, { cls: 'icon-btn' })));
  card.appendChild(children);
  root.classList.remove('hidden');
  function close() {
    root.classList.add('hidden');
    onClose?.();
  }
  root.onclick = (ev) => {
    if (ev.target === root) close();
  };
  return { close, card };
}

export function confirmDialog(title, body, onYes, { yes = 'Confirm', danger = false } = {}) {
  const wrap = el('div', { class: 'col' },
    el('p', { text: body }),
    el('div', { class: 'row' },
      btn(yes, () => { handle.close(); onYes(); }, { variant: danger ? 'danger' : 'primary' }),
      btn('Cancel', () => handle.close())));
  const handle = modal(title, wrap);
  return handle;
}

export function timeAgo(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

export function keyLabel(code) {
  if (!code) return '—';
  return String(code)
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace('ShiftLeft', 'L-Shift')
    .replace('ShiftRight', 'R-Shift')
    .replace('ControlLeft', 'L-Ctrl')
    .replace('ControlRight', 'R-Ctrl')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→')
    .replace('MouseLeft', 'Left click')
    .replace('MouseRight', 'Right click');
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
