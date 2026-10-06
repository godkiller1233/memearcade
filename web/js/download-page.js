/**
 * Logic for the standalone /download.html page.
 *
 * Kept separate from the arcade bundle: the download page must work with no
 * account, no session and no WebSocket - a plain link you can share.
 */
import { $, el, btn, pill, toast } from './dom.js';
import { api } from './api.js';

const insideDesktop = typeof window !== 'undefined' && !!window.arcade;

const here = () => {
  try {
    return location.origin;
  } catch {
    return '';
  }
};

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function os() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|Android/i.test(ua)) return 'linux';
  return 'windows';
}

const OS = os();

function fillSteps(node, steps) {
  if (!node) return;
  node.replaceChildren(...steps.map((text) => el('li', { text })));
}

function packageCard(d) {
  const url = d.url || `/api/downloads/${d.id}`;
  return el('div', { class: 'card pkg' },
    el('div', { class: 'row spread' },
      el('span', { class: 'icon', text: d.icon || '⬇️' }),
      pill(fmtSize(d.size), d.size ? 'good' : 'warn'),
    ),
    el('h2', { text: d.name }),
    el('div', { class: 'muted small', text: d.tagline || '' }),
    el('div', { class: 'meta-line' }, ...(d.includes || []).slice(0, 5).map((i) => pill(i))),
    el('div', { class: 'muted small' }, el('b', { text: 'Needs: ' }), (d.requires || []).join(' · ')),
    el('div', { class: 'row' },
      el('a', { class: 'btn primary', href: url, download: d.filename || '' }, `⬇ Download (${fmtSize(d.size)})`),
      btn('Copy link', () => {
        const full = `${here()}${url}`;
        navigator.clipboard?.writeText(full).then(
          () => toast('Download link copied', 'good'),
          () => toast(full),
        );
      }, { cls: 'sm' }),
    ),
    d.note ? el('div', { class: 'muted small mono', text: d.note }) : null,
    d.sha256 ? el('div', { class: 'muted small mono', title: d.sha256, text: `sha256 ${d.sha256.slice(0, 32)}…` }) : null,
  );
}

async function loadPackages() {
  const list = $('#packages');
  if (!list) return;
  try {
    const res = await api.get(`/api/downloads?server=${encodeURIComponent(here())}`);
    const packages = res.downloads || [];
    list.replaceChildren(...packages.map(packageCard));
    const foot = $('#foot');
    foot?.appendChild(el('span', { text: ` · packages v${res.version}, built live by this server so they always match.` }));
  } catch (err) {
    list.replaceChildren(el('div', { class: 'card' },
      el('h3', { text: 'Could not reach the download service' }),
      el('p', { class: 'muted', text: err.message }),
      el('p', { class: 'muted small', text: 'If you are running the server yourself, check that it is on the latest build and reload this page.' })));
  }
}

function wirePage() {
  const badges = $('#hero-badges');
  badges?.replaceChildren(
    pill('free', 'good'),
    pill('no account needed'),
    pill(insideDesktop ? 'you are already in the app' : 'Host build plays offline'),
  );

  fillSteps($('#steps-lite'), [
    'Install Node.js 18 or newer from nodejs.org (one time).',
    'Unzip the folder, then run the included start script:',
    OS === 'windows' ? 'run-windows.bat (double-click it)' : 'bash run-mac-linux.sh',
    'The first launch downloads Electron once (~90 MB). After that it opens instantly.',
    'Pick "Connect to a website", confirm this address, and sign in - same account as here.',
  ]);

  fillSteps($('#steps-host'), [
    'Install Node.js 18 or newer from nodejs.org (one time).',
    'Unzip the folder anywhere - for example your Desktop.',
    OS === 'windows' ? 'Shift + right-click the folder, choose "Open PowerShell here", then run: npm start' : 'Open a terminal in the folder and run: npm start',
    'Open http://localhost:8787 - you are the host now. Friends on your wifi use the "Same wifi" address the server prints.',
    'Prefer a window to a browser tab? Run: cd desktop && npm install && npm start',
  ]);

  const note = $('#desktop-note');
  if (note && insideDesktop) note.hidden = false;
  $('#open-folder')?.addEventListener('click', () => window.arcade?.openFolder?.());
  $('#copy-page')?.addEventListener('click', () => {
    const link = `${here()}/download.html`;
    navigator.clipboard?.writeText(link).then(
      () => toast('Page link copied', 'good'),
      () => toast(link),
    );
  });
}

wirePage();
loadPackages();
