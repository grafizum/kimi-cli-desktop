'use strict';

// Tiny JSON-file settings store for app preferences. Pure Node module.
// Data lives at <userData>/settings.json (userData comes from Electron).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  kimiPath: '', // explicit path to the kimi binary (empty = auto-detect)
  kimiCodeHome: '', // KIMI_CODE_HOME override (empty = ~/.kimi-code)
  defaultCwd: '', // working directory for new sessions (empty = home)
  defaultMode: 'default', // default | plan | yolo | auto
  fontSize: 13,
  fontFamily: '', // empty = app default stack
  theme: 'dark', // dark | light
  scrollback: 10000,
  shellPath: '', // KIMI_SHELL_PATH (Windows Git Bash override)
  sidebarWidth: 292, // px width of the session-history sidebar
  sidebarCollapsed: false, // true = sidebar hidden entirely
  sessionGroupBy: 'project', // 'project' (folder) | 'date'
  terminalStyle: 'panel', // 'panel' (framed card) | 'classic' (edge-to-edge)
  sessionView: 'chat', // 'chat' (embedded Kimi Web) | 'terminal' (the PTY TUI)
  collapsedGroups: [], // group keys the user folded shut, restored on next launch
};

function load(dir) {
  const settings = { ...DEFAULTS };
  if (!dir) return settings;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULTS) settings[k] = v;
    }
  } catch {
    /* first run or corrupt file — use defaults */
  }
  return settings;
}

function save(dir, settings) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] failed to save:', err.message);
  }
}

function sanitizePatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof v === 'string' && k !== 'defaultMode' && k !== 'theme' && k !== 'fontFamily'
      && k !== 'sessionView' && k !== 'terminalStyle') {
      out[k] = v.trim();
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { load, save, sanitizePatch, DEFAULTS };