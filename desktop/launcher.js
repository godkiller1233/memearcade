/**
 * Launcher UI.  Runs inside the sandboxed Electron window and only talks to
 * the main process through `window.arcade` (see preload.js).
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

// Not a module: the bridge calls are wrapped so the file stays a plain script.
main().catch((err) => {
  document.querySelector('#status').textContent = `⚠ Could not start: ${err.message}`;
});

async function main() {
  const info = await window.arcade.info();
  const serverInput = $('#server');
  const status = $('#status');
  const hostBtn = $('#mode-host');
  const connectBtn = $('#connect');
  const stopBtn = $('#stop');

  serverInput.value = info.defaultServer || '';
  $('#edition').textContent = info.lite ? 'Desktop Lite - connects to a website' : 'Desktop Host - plays offline or online';
  hostBtn.disabled = !!info.lite;
  hostBtn.title = info.lite ? 'The Lite download has no bundled server - grab "Desktop Host" for offline play.' : '';
  $('#foot').innerHTML = info.lite
    ? `Lite build v${info.version}. Want offline play, LAN parties and your own hosted matches? Download <b>Desktop Host</b> from the arcade's Download page.`
    : `Host build v${info.version}. Saves and accounts live in your user folder - updating the app never wipes them.`;

  if (info.serverRunning) {
    stopBtn.hidden = false;
    status.textContent = `Local server is already running at ${info.localUrl}`;
  }

  wire(info, { status, hostBtn, connectBtn, stopBtn });
}

function wire(info, ui) {
  const { status, hostBtn, connectBtn, stopBtn } = ui;
  const setStatus = (text) => { status.textContent = text; };
  const busy = (on, label = 'Connect') => {
    connectBtn.disabled = on;
    hostBtn.disabled = on || !!info.lite;
    connectBtn.textContent = on ? 'Working…' : label;
  };

  hostBtn.addEventListener('click', async () => {
    busy(true, 'Connect');
    setStatus('Starting the bundled arcade server…');
    const res = await window.arcade.startHost();
    busy(false);
    if (!res.ok) {
      setStatus(`⚠ ${res.error}`);
      return;
    }
    stopBtn.hidden = false;
    setStatus(`Playing offline at ${res.url}`);
  });

  connectBtn.addEventListener('click', async () => {
    const url = serverInput.value.trim();
    if (!url) {
      setStatus('Paste the arcade address first (for example https://your-arcade.onrender.com).');
      serverInput.focus();
      return;
    }
    busy(true);
    setStatus(`Connecting to ${url}…`);
    const res = await window.arcade.connect(url);
    busy(false);
    if (!res.ok) setStatus(`⚠ ${res.error}`);
  });

  stopBtn.addEventListener('click', async () => {
    await window.arcade.stopHost();
    stopBtn.hidden = true;
    setStatus('Local server stopped.');
  });

  $('#folder').addEventListener('click', () => window.arcade.openFolder());
  serverInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connectBtn.click();
  });

  window.arcade.onStatus((text) => setStatus(text));
  window.arcade.onServerStopped(() => {
    stopBtn.hidden = true;
    setStatus('The local server stopped.');
  });

  serverInput.focus();
}
