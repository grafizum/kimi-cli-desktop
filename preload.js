'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kimiDesktop', {
  // bootstrap / detection / settings
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  detectKimi: (force) => ipcRenderer.invoke('kimi:detect', force),
  setKimiPath: (p) => ipcRenderer.invoke('kimi:set-path', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // session history
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  // `kimi export <id>` with a save dialog in the main process
  exportSession: (opts) => ipcRenderer.invoke('session:export', opts),

  // PTY sessions
  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  writeInput: (tabId, data) => ipcRenderer.send('session:write', { tabId, data }),
  resizeTerminal: (tabId, cols, rows) => ipcRenderer.send('session:resize', { tabId, cols, rows }),
  killSession: (tabId) => ipcRenderer.invoke('session:kill', tabId),

  // Kimi CLI config.toml
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (content) => ipcRenderer.invoke('config:write', content),

  // custom title bar window controls
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChanged: (cb) => ipcRenderer.on('window:maximized-changed', (_e, v) => cb(v)),
  },

  // dialogs / shell
  pickFolder: (current) => ipcRenderer.invoke('dialog:pick-folder', current),
  pickFile: (current) => ipcRenderer.invoke('dialog:pick-file', current),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  // Open a local folder in the OS file manager (e.g. the sessions directory).
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  getPath: (name) => ipcRenderer.invoke('app:get-path', name),

  // clipboard (renderer clipboard API is unavailable on file:// pages)
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  readText: () => ipcRenderer.invoke('clipboard:read-text'),

  // events
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m)),
  onKimiDetected: (cb) => ipcRenderer.on('kimi:detected', (_e, det) => cb(det)),
  onAppFocus: (cb) => ipcRenderer.on('app:window-focused', () => cb()),
  onMenu: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
});