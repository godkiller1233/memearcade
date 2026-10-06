/**
 * The only bridge between the launcher page and Electron.  Keeps the renderer
 * sandboxed: it can ask for a list of actions, never for Node itself.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcade', {
  info: () => ipcRenderer.invoke('arcade:info'),
  connect: (url) => ipcRenderer.invoke('arcade:connect', url),
  startHost: () => ipcRenderer.invoke('arcade:start-host'),
  stopHost: () => ipcRenderer.invoke('arcade:stop-host'),
  saveSettings: (patch) => ipcRenderer.invoke('arcade:save-settings', patch),
  openExternal: (url) => ipcRenderer.invoke('arcade:open-external', url),
  openFolder: () => ipcRenderer.invoke('arcade:open-folder'),
  onStatus: (fn) => ipcRenderer.on('arcade:status', (_ev, text) => fn(text)),
  onServerStopped: (fn) => ipcRenderer.on('arcade:server-stopped', (_ev, code) => fn(code)),
});
