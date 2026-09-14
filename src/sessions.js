'use strict';

// Read Kimi Code CLI's on-disk session history so the app can list and resume
// previous sessions. Pure Node module (no Electron APIs).
//
// Storage layout (default home: ~/.kimi-code):
//   sessions/<workDirKey>/<sessionId>/state.json   (+ session-meta/state.json legacy)
//   session_index.jsonl                            one JSON record per line
// Records: { sessionId, sessionDir, workDir } — supplies cwd fallback for
// migrated/legacy sessions and a `deleted: true` tombstone.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_LINE_BYTES = 64 * 1024;

function kimiHome(env = process.env) {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

function collapseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseTimestamp(value) {
  if (typeof value === 'number') {
    // Treat sub-10-digit values as epoch seconds.
    return Math.abs(value) < 10000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Read session_index.jsonl → Map<sessionId, workDir> (ignores deleted entries).
function readIndexWorkdirs(indexPath) {
  const map = new Map();
  if (!indexPath || !fs.existsSync(indexPath)) return map;
  let content;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return map;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.length > MAX_INDEX_LINE_BYTES) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec || typeof rec.sessionId !== 'string' || !rec.sessionId) continue;
      if (rec.deleted === true) {
        map.delete(rec.sessionId);
        continue;
      }
      if (typeof rec.workDir === 'string' && rec.workDir.trim()) {
        map.set(rec.sessionId, rec.workDir.trim());
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return map;
}

function readStateFile(statePath) {
  try {
    const stat = fs.statSync(statePath);
    if (stat.size > MAX_STATE_BYTES) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

// The WSL 9P filesystem (\\wsl.localhost\...) can hiccup transiently — retry
// the initial directory listing a few times before giving up.
function readSessionsRoot(sessionsRoot) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!fs.existsSync(sessionsRoot)) throw new Error('missing');
      return fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const until = Date.now() + 250;
        while (Date.now() < until) { /* busy-wait */ }
      }
    }
  }
  if (lastErr && lastErr.message === 'missing') return []; // truly absent → no sessions
  return [];
}

// A directory "is" a session when it carries the CLI's state file (v2 keeps
// it at the top, older layouts under session-meta/).
function dirHasState(dir) {
  return fs.existsSync(path.join(dir, 'state.json')) ||
    fs.existsSync(path.join(dir, 'session-meta', 'state.json'));
}

// True when `dir` holds session data at one or two levels of nesting (a
// sessions root, a single work-dir key, or a flat set of session folders).
function looksLikeSessionsRoot(dir) {
  for (const entry of readSessionsRoot(dir)) {
    if (!entry.isDirectory()) continue;
    const entryDir = path.join(dir, entry.name);
    if (dirHasState(entryDir)) return true;
    let children;
    try {
      children = fs.readdirSync(entryDir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (children.some((c) => c.isDirectory() && dirHasState(path.join(entryDir, c.name)))) {
      return true;
    }
  }
  return false;
}

// Resolve where session data actually lives for a chosen home folder.
// Normally that is <home>/sessions — but the user picks this folder in
// Settings, and they may well select the sessions folder itself (whatever it
// is called, e.g. "session"). Accept that shape instead of scanning a
// nonexistent <picked>/sessions and reporting zero history.
function sessionRoots(root) {
  const standard = path.join(root, 'sessions');
  if (fs.existsSync(standard)) {
    return [{ dir: standard, indexes: [path.join(root, 'session_index.jsonl')] }];
  }
  if (looksLikeSessionsRoot(root)) {
    // The picked folder IS the session store; its index (if any) sits either
    // inside it or beside it, in what would normally be the home directory.
    return [{
      dir: root,
      indexes: [
        path.join(root, 'session_index.jsonl'),
        path.join(path.dirname(root), 'session_index.jsonl'),
      ],
    }];
  }
  // The picked folder is (or contains) a data home whose sessions live one
  // level down — e.g. the user selected their home directory.
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, 'sessions');
      if (fs.existsSync(nested) && looksLikeSessionsRoot(nested)) {
        return [{ dir: nested, indexes: [path.join(root, entry.name, 'session_index.jsonl')] }];
      }
    }
  } catch { /* unreadable root → no sessions */ }
  return [];
}

// Walk one sessions root. Handles both layouts of the CLI store: session
// folders grouped under a work-dir key, or session folders directly inside.
function collectSessions(sessionsRoot, indexWorkdirs) {
  const sessions = [];
  const seenDirs = new Set();

  const addSession = (sessionDir, fallbackId) => {
    if (seenDirs.has(sessionDir)) return;
    seenDirs.add(sessionDir);
    const statePath = fs.existsSync(path.join(sessionDir, 'state.json'))
      ? path.join(sessionDir, 'state.json')
      : path.join(sessionDir, 'session-meta', 'state.json');
    // Only directory-based sessions with a state file are resumable.
    const state = readStateFile(statePath);
    if (!state) return;

    if (state.archived === true) return;
    const sessionId =
      (typeof state.id === 'string' && state.id.trim() ? state.id.trim() : fallbackId);
    if (!sessionId || sessionId.startsWith('.')) return;

    const cwd =
      (state &&
        [state.cwd, state.workDir, state.custom && state.custom.cwd]
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .find(Boolean)) ||
      indexWorkdirs.get(sessionId) ||
      '';

    const updatedAt =
      (state && parseTimestamp(state.updatedAt)) ||
      (state && parseTimestamp(state.createdAt)) ||
      safeMtimeMs(sessionDir);
    const createdAt = (state && parseTimestamp(state.createdAt)) || updatedAt;

    const isChild =
      state && state.custom && state.custom.child_session_kind === 'child';

    sessions.push({
      id: sessionId,
      dir: sessionDir,
      title: state && typeof state.title === 'string' ? state.title.trim() : '',
      lastPrompt:
        state && typeof state.lastPrompt === 'string'
          ? collapseWhitespace(state.lastPrompt)
          : '',
      cwd,
      createdAt,
      updatedAt,
      gitBranch:
        state && (typeof state.gitBranch === 'string' ? state.gitBranch : '') || '',
      worktreeLabel:
        state && typeof state.worktreeLabel === 'string' ? state.worktreeLabel : '',
      interactive: !isChild,
    });
  };

  for (const workDirEntry of readSessionsRoot(sessionsRoot)) {
    if (!workDirEntry.isDirectory()) continue;
    const workDirDir = path.join(sessionsRoot, workDirEntry.name);
    // Flat layout: session folders sit directly inside the root.
    if (dirHasState(workDirDir)) {
      addSession(workDirDir, workDirEntry.name);
      continue;
    }
    let sessionEntries;
    try {
      sessionEntries = fs.readdirSync(workDirDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(workDirDir, sessionEntry.name);
      if (dirHasState(sessionDir)) addSession(sessionDir, sessionEntry.name);
    }
  }
  return sessions;
}

// Scan the session history for `home` (the folder chosen in Settings, or the
// CLI's default). Returns an array sorted by updatedAt (most recent first).
function listSessions({ home } = {}) {
  const root = home || kimiHome();
  const sessions = [];
  for (const { dir, indexes } of sessionRoots(root)) {
    const indexWorkdirs = new Map();
    for (const index of indexes) {
      // First source wins: an index inside the picked folder describes its
      // sessions better than one that merely sits beside the store.
      for (const [id, workDir] of readIndexWorkdirs(index)) {
        if (!indexWorkdirs.has(id)) indexWorkdirs.set(id, workDir);
      }
    }
    sessions.push(...collectSessions(dir, indexWorkdirs));
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

// kimi refuses to resume a session from any directory other than the one the
// session was created in ("Session ... was created under a different
// directory"), so the recorded cwd is NOT interchangeable with the home
// directory or any other fallback. Classify it once, here, so callers can fail
// loudly instead of silently swapping in a directory kimi will reject.
// Returns { ok, reason: 'exists' | 'missing' | 'unknown', cwd, detail }.
function resumePlan(recordedCwd) {
  const cwd = typeof recordedCwd === 'string' ? recordedCwd.trim() : '';
  if (!cwd) return { ok: false, reason: 'unknown', cwd: '', detail: 'no working directory recorded' };
  let exists = false;
  let detail = '';
  try {
    exists = fs.statSync(cwd).isDirectory();
  } catch (err) {
    detail = err.message;
  }
  if (exists) return { ok: true, reason: 'exists', cwd, detail: '' };
  return { ok: false, reason: 'missing', cwd, detail: detail || 'not a directory' };
}

function safeMtimeMs(dir) {
  try {
    const t = fs.statSync(dir).mtimeMs;
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

// Human-readable label for a session: title, else last prompt, else "Untitled".
function displayTitle(session) {
  if (session.title) return session.title;
  if (session.lastPrompt) {
    const t = collapseWhitespace(session.lastPrompt);
    return t.length > 120 ? `${t.slice(0, 117)}…` : t;
  }
  return 'Untitled session';
}

function projectName(cwd) {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

module.exports = { listSessions, kimiHome, displayTitle, projectName, parseTimestamp, resumePlan };