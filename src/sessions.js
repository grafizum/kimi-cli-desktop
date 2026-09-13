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

// Scan all sessions under $KIMI_CODE_HOME. Returns an array sorted by
// updatedAt (most recent first).
function listSessions({ home } = {}) {
  const root = home || kimiHome();
  const sessionsRoot = path.join(root, 'sessions');
  const indexWorkdirs = readIndexWorkdirs(path.join(root, 'session_index.jsonl'));

  const entries = readSessionsRoot(sessionsRoot);
  if (!entries.length) return [];

  const sessions = [];
  for (const workDirEntry of entries) {
    if (!workDirEntry.isDirectory()) continue;
    const workDirDir = path.join(sessionsRoot, workDirEntry.name);
    let sessionEntries;
    try {
      sessionEntries = fs.readdirSync(workDirDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(workDirDir, sessionEntry.name);
      const statePath = fs.existsSync(path.join(sessionDir, 'state.json'))
        ? path.join(sessionDir, 'state.json')
        : path.join(sessionDir, 'session-meta', 'state.json');
      // Only directory-based sessions with a state file are resumable.
      if (!fs.existsSync(statePath)) continue;
      const state = readStateFile(statePath);
      if (!state) continue;

      if (state.archived === true) continue;
      const sessionId =
        (typeof state.id === 'string' && state.id.trim() ? state.id.trim() : sessionEntry.name);
      if (!sessionId || sessionId.startsWith('.')) continue;

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
    }
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