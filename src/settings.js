'use strict';

// Tiny JSON-file settings store for app preferences. Pure Node module.
// Data lives at <userData>/settings.json (userData comes from Electron).
//
// WEB EDITION: the embedded Kimi web UI carries its own settings; the shell
// only needs to know where the CLI is and which appearance to hand it.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  kimiPath: '', // explicit path to the kimi binary (empty = auto-detect)
  kimiCodeHome: '', // KIMI_CODE_HOME override (empty = ~/.kimi-code)
  defaultMode: 'default', // default | plan | yolo | auto — server start mode
  theme: 'dark', // dark | light — seeded into the chat UI's color scheme
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
    if (typeof v === 'string' && k !== 'defaultMode' && k !== 'theme') {
      out[k] = v.trim();
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { load, save, sanitizePatch, DEFAULTS };
