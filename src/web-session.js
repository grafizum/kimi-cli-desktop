'use strict';

// Embedded Kimi Web — the genuine chat interface the kimi CLI itself ships
// (`kimi web`). The desktop app starts one `kimi web` server per session tab,
// extracts the loopback URL + bearer token the CLI prints at startup, and hands
// that URL to the renderer's <webview>, which embeds Moonshot's own UI: the
// exact thinking blocks, tool cards, diffs and attachments the browser UI
// shows. Nothing here re-implements kimi's interface — it only launches it.
//
// Pure Node module (no Electron), so the arg building and URL parsing are
// unit-testable in scripts/smoke-test.js.

const crypto = require('crypto');
const { spawn } = require('child_process');

// The CLI picks its default port (58627); the app assigns one per tab so
// several sessions can chat at the same time.
const PORT_RANGE_START = 58700;
const PORT_RANGE_SIZE = 200;
const SERVER_READY_TIMEOUT_MS = 30000;

// How many chars of server output to keep while hunting for the ready line.
const LOG_SCAN_LIMIT = 20000;

/**
 * Build the argv for a `kimi web` server. `--session` and the permission-mode
 * flags are ROOT options of the CLI, so they go before the `web` subcommand
 * (`kimi --session <id> --yolo web --no-open`) — verified against the real CLI.
 * Mirrors pty.buildArgs' mode flags so a chat session starts with the same
 * permission mode the terminal would.
 * opts: { mode, resumeId }
 */
function buildWebArgs(opts = {}) {
  const args = [];
  if (opts.resumeId) args.push('--session', opts.resumeId);
  if (opts.mode === 'plan') args.push('--plan');
  if (opts.mode === 'yolo') args.push('--yolo');
  if (opts.mode === 'auto') args.push('--auto');
  args.push('web', '--no-open');
  return args;
}

/**
 * Pull the loopback URL and token out of the server's own startup banner:
 *   Local:    http://127.0.0.1:58627/#token=…
 * Returns { url, token, port } or null while the banner has not appeared.
 */
function parseServerUrl(text) {
  const s = String(text || '');
  const m = s.match(/Local:\s*(https?:\/\/\S*#token=\S+)/);
  if (!m) return null;
  const url = m[1].trim();
  const token = (url.match(/#token=([A-Za-z0-9._-]+)/) || [])[1] || '';
  const port = (url.match(/:(\d+)\//) || [])[1] || '';
  return { url, token, port };
}

/** True when the server printed its "ready" banner (exit paths stop polling). */
function isServerReadyLine(text) {
  return /server ready/i.test(String(text || ''));
}

/**
 * The renderer may only ever load the CLI's own loopback web server. Anything
 * else (remote hosts, plain http without a token fragment, non-loopback
 * addresses) is refused here so the webview can never be pointed elsewhere.
 */
function isAllowedWebUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    if (!loopback) return false;
    return u.hash.includes('token=');
  } catch {
    return false;
  }
}

/**
 * Add the Kimi web UI's official onboarding skip to a served URL: loading with
 * ?kimi_onboarded=1 makes the UI persist kimi-web.onboarded=1 and skip its
 * first-run introduction. Inside the desktop app that intro is noise — the host
 * drives appearance/settings itself. The URL fragment (#token=…) must stay
 * last, so the query goes before it.
 */
function withOnboardingSkip(url) {
  return String(url || '').replace('/#', '/?kimi_onboarded=1#');
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function pickPort() {
  return PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
}

/**
 * Spawn one `kimi web` server. Returns a handle:
 *   { id, promise, url, token, port, kill(), on(event, cb) }
 * `promise` resolves { ok, url, token, port, code, log } once the server is
 * either ready (url extracted) or dead/exited (ok:false, reason in log).
 */
function startWebServer(opts = {}) {
  const id = opts.id || newId();
  const port = opts.port || pickPort();
  const args = [...(opts.args || buildWebArgs(opts)), '--port', String(port)];
  const env = { ...(opts.env || process.env) };
  if (opts.kimiCodeHome && !(opts.wsl && opts.wsl.distro)) env.KIMI_CODE_HOME = opts.kimiCodeHome;

  let child;
  try {
    let file = opts.binary;
    let fileArgs = args;
    if (opts.wsl && opts.wsl.distro) {
      // WSL mode: the same argv runs inside the distro wrapped in `bash -lc`
      // (same shell-quoting rules as pty.buildWslCommand). The server then
      // binds 127.0.0.1 inside WSL, which on WSL2 is the same loopback the
      // Windows side reaches — so the webview URL needs no translation.
      const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
      const cmd = [
        opts.cwd ? `cd ${q(opts.cwd)}` : '',
        opts.kimiCodeHome ? `export KIMI_CODE_HOME=${q(opts.kimiCodeHome)}` : '',
        'export TERM=xterm-256color',
        `exec ${q(opts.binary)} ${args.map(q).join(' ')}`,
      ].filter(Boolean).join(' && ');
      file = 'wsl.exe';
      fileArgs = ['-d', opts.wsl.distro, '-e', 'bash', '-lc', cmd];
    } else {
      const built = opts.buildSpawn ? opts.buildSpawn(opts.binary, args) : { file, args };
      file = built.file;
      fileArgs = built.args;
    }
    child = spawn(file, fileArgs, {
      env,
      cwd: opts.cwd && !/^\\\\/.test(opts.cwd) ? opts.cwd : undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      id, port, url: null, token: null, promise: Promise.resolve({ ok: false, log: String(err) }),
      kill() {}, on() {}, once() {},
    };
  }

  let log = '';
  let settled = false;
  let url = null;
  let token = null;
  const listeners = { ready: [], exit: [] };

  const emit = (ev, payload) => {
    for (const cb of (listeners[ev] || [])) {
      try { cb(payload); } catch { /* listener error must not kill the watch */ }
    }
  };

  const collect = (d) => {
    if (settled && !url) return;
    log = (log + d.toString()).slice(-LOG_SCAN_LIMIT);
    if (!url) {
      const parsed = parseServerUrl(log);
      if (parsed) {
        // See withOnboardingSkip: the webview must never land on the web
        // UI's own first-run introduction.
        url = withOnboardingSkip(parsed.url);
        token = parsed.token;
        emit('ready', { url, token, port: parsed.port || port });
      }
    }
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exitInfo = { code: null, signal: null };
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    emit('exit', exitInfo);
  });
  child.on('error', (err) => {
    log = (log + `\n[spawn error] ${err.message}`).slice(-LOG_SCAN_LIMIT);
    emit('exit', { code: -1, signal: null, error: err.message });
  });

  const promise = new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (url) { settled = true; return resolve({ ok: true, url, token, port, log }); }
      if (exitInfo.code !== null || exitInfo.signal !== null || child.exitCode !== null) {
        settled = true;
        return resolve({ ok: false, code: exitInfo.code, log });
      }
      if (Date.now() - started > SERVER_READY_TIMEOUT_MS) {
        settled = true;
        try { child.kill(); } catch { /* already gone */ }
        return resolve({ ok: false, code: -1, log: log + '\n[timeout] server did not print its URL in time' });
      }
      setTimeout(tick, 150);
    };
    tick();
  });

  const handle = {
    id,
    port,
    pid: child.pid,
    get url() { return url; },
    get token() { return token; },
    promise,
    kill() {
      try { child.kill(); } catch { /* already dead */ }
    },
    on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); return handle; },
    once(event, cb) {
      const once = (payload) => {
        const arr = listeners[event] || [];
        const i = arr.indexOf(once);
        if (i >= 0) arr.splice(i, 1);
        cb(payload);
      };
      (listeners[event] || (listeners[event] = [])).push(once);
      return handle;
    },
  };
  return handle;
}

module.exports = {
  buildWebArgs, parseServerUrl, isServerReadyLine, isAllowedWebUrl, withOnboardingSkip,
  startWebServer, pickPort, newId,
  PORT_RANGE_START, PORT_RANGE_SIZE, SERVER_READY_TIMEOUT_MS,
};
