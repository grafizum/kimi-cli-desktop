'use strict';

// PTY session manager: spawns `kimi` processes inside pseudo-terminals so the
// renderer can drive the real interactive Kimi Code TUI (including its
// reasoning/thinking panels) over xterm.js.
//
// Uses @lydell/node-pty — a slim node-pty build shipped as N-API prebuilt
// binaries per platform, so the SAME binary loads in Electron and in plain Node
// with no rebuild step (electron-builder runs with npmRebuild: false).
// Do not swap this for an ABI-tagged build: those ship `node.abi<NNN>.node`
// files, which Electron cannot load — the PTY (and therefore every session)
// silently stops working. See the electron-runtime check in scripts/smoke-test.js.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { buildSpawn } = require('./kimi-detect');

let ptyModule = null;
function pty() {
  if (!ptyModule) {
    ptyModule = require('@lydell/node-pty');
  }
  return ptyModule;
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// Permission modes map to kimi CLI flags.
const MODE_FLAGS = {
  default: [],
  plan: ['--plan'],
  yolo: ['--yolo'],
  auto: ['--auto'],
};

/**
 * Build the argv for a kimi session.
 * opts: { binary, mode, resumeId, quickPrompt, kimiCodeHome }
 */
function buildArgs(opts) {
  const args = [];
  if (opts.resumeId) {
    args.push('--session', opts.resumeId);
  }
  args.push(...(MODE_FLAGS[opts.mode] || []));
  if (opts.quickPrompt) {
    args.push('--prompt', opts.quickPrompt);
  }
  return args;
}

/**
 * Spawn a kimi session in a PTY.
 * opts: { binary, cwd, args, env, cols, rows }
 * Returns a Session handle: { id, write, resize, kill, on, once }.
 */
function spawnKimiSession(opts) {
  const id = newId();
  const { binary, cwd, args = [], cols = 80, rows = 24 } = opts;

  const env = { ...(opts.env || process.env) };
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';
  if (opts.kimiCodeHome) env.KIMI_CODE_HOME = opts.kimiCodeHome;

  const { file, args: fileArgs } = buildSpawn(binary, args);

  const term = pty().spawn(file, fileArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || os.homedir(),
    env,
    useConpty: process.platform === 'win32',
  });

  const handle = {
    id,
    pid: term.pid,
    write(data) {
      try { term.write(data); } catch { /* session gone */ }
    },
    resize(cols, rows) {
      try { term.resize(cols, rows); } catch { /* session gone */ }
    },
    kill() {
      try { term.kill(); } catch { /* already dead */ }
    },
    on(event, cb) { term.on(event, cb); return handle; },
    once(event, cb) { term.once(event, cb); return handle; },
    get process() { return term; },
  };
  return handle;
}

// --------------------------------------------------------------------------
// WSL sessions — kimi runs inside a Linux distro, driven through `wsl.exe`.
// The working directory, KIMI_CODE_HOME and binary path are all Linux paths;
// the whole thing is wrapped in a `bash -lc` command string.
// --------------------------------------------------------------------------

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the `bash -lc` command that runs kimi inside WSL.
 * opts: { wsl, kimiPath, cwd, args, kimiCodeHome }
 */
function buildWslCommand(opts) {
  const wsl = opts.wsl;
  const cwd = opts.cwd || wsl.home;
  const kimiPath = opts.kimiPath || wsl.kimiPath;
  const parts = [`cd ${shellQuote(cwd)}`];
  if (opts.kimiCodeHome) parts.push(`export KIMI_CODE_HOME=${shellQuote(opts.kimiCodeHome)}`);
  parts.push('export TERM=xterm-256color', 'export COLORTERM=truecolor');
  parts.push(`exec ${shellQuote(kimiPath)} ${(opts.args || []).map(shellQuote).join(' ')}`);
  return parts.join(' && ');
}

/**
 * Spawn a kimi session inside a WSL distro.
 * opts: { wsl, kimiPath, cwd, args, kimiCodeHome, env, cols, rows }
 */
function spawnWslSession(opts) {
  const id = newId();
  const { wsl, cols = 80, rows = 24 } = opts;
  const cmd = buildWslCommand(opts);

  const term = pty().spawn('wsl.exe', ['-d', wsl.distro, '-e', 'bash', '-lc', cmd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.USERPROFILE || process.env.HOME || undefined,
    env: { ...(opts.env || process.env) },
    useConpty: true,
  });

  const handle = {
    id,
    pid: term.pid,
    write(data) {
      try { term.write(data); } catch { /* session gone */ }
    },
    resize(cols, rows) {
      try { term.resize(cols, rows); } catch { /* session gone */ }
    },
    kill() {
      try { term.kill(); } catch { /* already dead */ }
    },
    on(event, cb) { term.on(event, cb); return handle; },
    once(event, cb) { term.once(event, cb); return handle; },
    get process() { return term; },
  };
  return handle;
}

module.exports = { spawnKimiSession, spawnWslSession, buildArgs, buildWslCommand, newId };