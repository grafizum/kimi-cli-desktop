'use strict';

// Kimi Code Desktop — WEB EDITION preload.
// A small, explicit bridge for the shell chrome. The chat itself runs in a
// sandboxed <webview> with its own restricted preload (src/web-guest-preload).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kimiDesktop', {
  // bootstrap / detection / settings
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  detectKimi: (force) => ipcRenderer.invoke('kimi:detect', force),
  setKimiPath: (p) => ipcRenderer.invoke('kimi:set-path', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // The chat server lifecycle — the shell's whole reason to exist.
  ensureWeb: () => ipcRenderer.invoke('web:ensure'),
  webStatus: () => ipcRenderer.invoke('web:status'),
  restartWeb: () => ipcRenderer.invoke('web:restart'),
  onWebStatus: (cb) => ipcRenderer.on('web:status', (_e, st) => cb(st)),

  // custom title bar window controls
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChanged: (cb) => ipcRenderer.on('window:maximized-changed', (_e, v) => cb(v)),
  },

  // misc
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  onKimiDetected: (cb) => ipcRenderer.on('kimi:detected', (_e, det) => cb(det)),
});
