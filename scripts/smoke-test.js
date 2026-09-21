'use strict';

// Smoke test for the pure-Node modules (session scanner + binary detection).
// Builds a synthetic ~/.kimi-code tree and a fake `kimi` executable, then
// asserts the parsing/detection behavior. Run with: npm run smoke

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sessions = require('../src/sessions');
const detect = require('../src/kimi-detect');

let failures = 0;

function ok(cond, name, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kcd-${name}-`));
}

// ---------------------------------------------------------------------------
// 1. Session scanner
// ---------------------------------------------------------------------------
console.log('\n[sessions] scanning synthetic ~/.kimi-code');

const home = tmpRoot('sessions');
const sessionsRoot = path.join(home, 'sessions');

// v2-style state (epoch millis)
const currentDir = path.join(sessionsRoot, 'wd_myproject_aaaaaaaaaaaa', 'session-current');
fs.mkdirSync(path.join(currentDir, 'agents', 'main'), { recursive: true });
fs.writeFileSync(path.join(currentDir, 'state.json'), JSON.stringify({
  version: 2,
  cwd: 'C:\\Users\\dev\\myproject',
  createdAt: 1786000000000,
  updatedAt: Date.now() - 5 * 60 * 1000,
  title: 'Implement auth',
  lastPrompt: 'Add the refresh-token tests',
  gitBranch: 'feat/auth',
  custom: {},
}));

// legacy-style state (RFC3339 strings) + cwd from index
const legacyDir = path.join(sessionsRoot, 'wd_legacy_bbbbbbbbbbbb', 'session-legacy');
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  title: 'Legacy session',
  lastPrompt: 'Recover my cwd',
  custom: {},
}));

// archived — must be excluded
const archivedDir = path.join(sessionsRoot, 'wd_arch_cccccccccccc', 'session-archived');
fs.mkdirSync(archivedDir, { recursive: true });
fs.writeFileSync(path.join(archivedDir, 'state.json'), JSON.stringify({
  archived: true, title: 'Gone', updatedAt: Date.now(), custom: {},
}));

// child (subagent) session — flagged non-interactive
const childDir = path.join(sessionsRoot, 'wd_child_dddddddddddd', 'session-child');
fs.mkdirSync(childDir, { recursive: true });
fs.writeFileSync(path.join(childDir, 'state.json'), JSON.stringify({
  cwd: '/work/myproject', updatedAt: Date.now(), title: 'subagent',
  custom: { child_session_kind: 'child' },
}));

// no state.json — must be skipped
const noStateDir = path.join(sessionsRoot, 'wd_empty_eeeeeeeeeeee', 'session-nostate');
fs.mkdirSync(noStateDir, { recursive: true });

// session_index.jsonl (workdir fallback + deleted tombstone)
fs.writeFileSync(path.join(home, 'session_index.jsonl'), [
  JSON.stringify({ sessionId: 'session-legacy', sessionDir: legacyDir, workDir: '/work/legacy-project' }),
  JSON.stringify({ sessionId: 'session-deleted', sessionDir: '/nope', workDir: '/work/gone' }),
  JSON.stringify({ sessionId: 'session-deleted', deleted: true }),
  'not-json-at-all',
].join('\n'));

let list = sessions.listSessions({ home });

ok(list.length === 3, 'returns 3 sessions (archived + stateless + deleted excluded)', `got ${list.length}`);
const sortedDesc = list.every((s, i) => i === 0 || list[i - 1].updatedAt >= s.updatedAt);
ok(sortedDesc, 'sessions sorted by recency (descending)');
const current = list.find((s) => s.id === 'session-current');
const legacy = list.find((s) => s.id === 'session-legacy');
const child = list.find((s) => s.id === 'session-child');

ok(current && current.title === 'Implement auth', 'v2 title parsed');
ok(current && current.lastPrompt === 'Add the refresh-token tests', 'v2 lastPrompt parsed');
ok(current && current.gitBranch === 'feat/auth', 'gitBranch parsed');
ok(current && current.cwd === 'C:\\Users\\dev\\myproject', 'v2 cwd parsed from state.json');
ok(current && current.interactive === true, 'main session flagged interactive');
ok(child && child.interactive === false, 'child (subagent) session flagged non-interactive');
ok(legacy && legacy.cwd === '/work/legacy-project', 'legacy cwd recovered from session_index.jsonl');
ok(legacy && typeof legacy.updatedAt === 'number' && legacy.updatedAt > 0, 'legacy RFC3339 timestamp parsed');
ok(legacy && legacy.updatedAt < current.updatedAt, 'legacy sorted older than current');
ok(!list.find((s) => s.id === 'session-archived'), 'archived session excluded');
ok(!list.find((s) => s.id === 'session-nostate'), 'stateless session excluded');

// displayTitle helper
const sessionsLib = require('../src/sessions');
ok(sessionsLib.displayTitle(current) === 'Implement auth', 'displayTitle uses title');
ok(sessionsLib.displayTitle({ lastPrompt: '  some   prompt  ' }) === 'some prompt', 'displayTitle falls back to collapsed lastPrompt');
ok(sessionsLib.displayTitle({}) === 'Untitled session', 'displayTitle fallback');  ok(sessionsLib.projectName('C:\\Users\\dev\\myproject') === 'myproject', 'projectName (win path)');
  ok(sessionsLib.projectName('/work/legacy-project') === 'legacy-project', 'projectName (posix path)');

  // The Settings picker lets the user point the app at ANY folder — including
  // the sessions store itself (whatever it is called) or a whole data home.
  // Each shape below must surface the same sessions as the default layout.
  console.log('\n[sessions] user-picked folder shapes');

  const picked = path.join(home, 'session'); // deliberately not named "sessions"
  for (const wd of fs.readdirSync(sessionsRoot)) {
    fs.cpSync(path.join(sessionsRoot, wd), path.join(picked, wd), { recursive: true });
  }
  const fromPicked = sessions.listSessions({ home: picked });
  ok(fromPicked.length === 3, 'a folder picked by the user (any name) IS the session store',
    `got ${fromPicked.length}`);

  const flat = path.join(home, 'flat-store');
  fs.cpSync(path.join(sessionsRoot, 'wd_myproject_aaaaaaaaaaaa', 'session-current'),
    path.join(flat, 'session-current'), { recursive: true });
  const fromFlat = sessions.listSessions({ home: flat });
  ok(fromFlat.length === 1 && fromFlat[0].id === 'session-current',
    'a flat store of session folders is recognized too', `got ${fromFlat.length}`);

  const withIndex = path.join(home, 'indexed-store');
  fs.cpSync(path.join(sessionsRoot, 'wd_legacy_bbbbbbbbbbbb', 'session-legacy'),
    path.join(withIndex, 'session-legacy'), { recursive: true });
  fs.writeFileSync(path.join(withIndex, 'session_index.jsonl'),
    JSON.stringify({ sessionId: 'session-legacy', workDir: '/work/from-index' }));
  const fromIndexed = sessions.listSessions({ home: withIndex });
  ok(fromIndexed.length === 1 && fromIndexed[0].cwd === '/work/from-index',
    'an index file inside the picked folder is honored', JSON.stringify(fromIndexed[0] && fromIndexed[0].cwd));

  const fromHome = sessions.listSessions({ home });
  ok(fromHome.length === 3, 'the default <home>/sessions layout is unchanged',
    `got ${fromHome.length}`);

  const nestedHome = path.join(tmpRoot('nested'), 'somewhere');
  const nestedStore = path.join(nestedHome, '.kimi-code', 'sessions');
  fs.cpSync(sessionsRoot, nestedStore, { recursive: true });
  const fromNested = sessions.listSessions({ home: nestedHome });
  ok(fromNested.length === 3, 'a folder containing the data home finds its <entry>/sessions',
    `got ${fromNested.length}`);

  const empty = tmpRoot('empty-pick');
  fs.mkdirSync(path.join(empty, 'not-sessions'), { recursive: true });
  ok(sessions.listSessions({ home: empty }).length === 0,
    'a folder with no session data still reports zero sessions');

// ---------------------------------------------------------------------------
// 2. Binary detection
// ---------------------------------------------------------------------------
console.log('\n[kimi-detect] fake kimi binary');

const binRoot = tmpRoot('bin');
const binDir = path.join(binRoot, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const isWin = process.platform === 'win32';
const fakeBin = isWin ? path.join(binDir, 'kimi.cmd') : path.join(binDir, 'kimi');

if (isWin) {
  fs.writeFileSync(fakeBin, '@echo off\r\nnode -e "process.stdout.write(\'kimi 0.42.0\')"\r\n', 'utf8');
} else {
  fs.writeFileSync(fakeBin, '#!/bin/sh\necho "kimi 0.42.0"\n', 'utf8');
  fs.chmodSync(fakeBin, 0o755);
}

const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` };

(async () => {
  // explicit path
  const byPath = await detect.detect({ explicitPath: fakeBin, env });
  ok(byPath.found === true, 'detects via explicit path');
  ok(byPath.path === fakeBin, 'explicit path returned');
  ok(byPath.version === '0.42.0', `version parsed (${byPath.version})`);

  // PATH lookup
  const byPath2 = await detect.detect({ env });
  ok(byPath2.found === true, 'detects via PATH (which/where)');
  ok(byPath2.version === '0.42.0', 'PATH-detected version parsed');

  // buildSpawn wrapping
  const built = detect.buildSpawn(fakeBin, ['--session', 'abc']);
  if (isWin) {
    ok(built.file === 'cmd.exe' && built.wrapped === true, 'buildSpawn wraps .cmd through cmd.exe');
    ok(built.args[0] === '/d' && built.args[1] === '/c' && built.args[2] === 'call', 'cmd runs with /d /c call (bare /c and /s break paths with spaces)');
    ok(built.args[3] === fakeBin, 'cmd argv carries the raw shim path (spawner does the quoting)');
    ok(built.args[4] === '--session' && built.args[5] === 'abc', 'cmd argv includes the session args');
  } else {
    ok(built.file === fakeBin && built.wrapped === false, 'buildSpawn spawns POSIX binary directly');
  }

  // not found (Windows-only detection — WSL is handled separately below)
  // Detection also probes well-known install paths via os.homedir(), so the
  // check must sandbox HOME/PATH or it fails on any machine that legitimately
  // has kimi installed.
  const savedEnv = {};
  const sandbox = path.join(os.tmpdir(), `kcd-smoke-empty-${Date.now()}`);
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    savedEnv[k] = process.env[k];
  }
  fs.mkdirSync(sandbox, { recursive: true });
  process.env.PATH = '';
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.LOCALAPPDATA = path.join(sandbox, 'AppData', 'Local');
  process.env.APPDATA = path.join(sandbox, 'AppData', 'Roaming');
  try {
    const notFound = await detect.detect({ env: { ...process.env }, allowWsl: false });
    ok(notFound.found === false, 'no false positive with a scrubbed environment');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  // expandHome
  ok(detect.expandHome('~/x') === path.join(os.homedir(), 'x'), 'expandHome tilde');

  // -------------------------------------------------------------------------
  // 3. WSL support
  // -------------------------------------------------------------------------
  console.log('\n[wsl] command building + path mapping');

  const ptyLib = require('../src/pty');

  const wslCmd = ptyLib.buildWslCommand({
    wsl: { home: '/home/me', kimiPath: '/home/me/.kimi-code/bin/kimi' },
    kimiPath: '/home/me/.kimi-code/bin/kimi',
    cwd: '/home/me/My Project',
    args: ['--session', "abc'123", '--prompt', 'hello world'],
    kimiCodeHome: '/home/me/.kimi-code',
  });
  ok(wslCmd.includes("cd '/home/me/My Project'"), 'buildWslCommand quotes cwd with spaces', wslCmd);
  ok(wslCmd.includes("'abc'\\''123'"), 'buildWslCommand escapes single quotes in args');
  ok(wslCmd.includes('export KIMI_CODE_HOME='), 'buildWslCommand exports KIMI_CODE_HOME');
  ok(wslCmd.includes('exec '), 'buildWslCommand execs kimi');
  ok(wslCmd.includes("'hello world'"), 'buildWslCommand quotes args with spaces');

  ok(detect.linuxToWindowsUnc('Ubuntu-22.04', '/home/me/.kimi-code') ===
    '\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\.kimi-code', 'linuxToWindowsUnc maps Linux path to UNC');
  ok(detect.linuxToWindowsUnc('Ubuntu', 'relative') === null, 'linuxToWindowsUnc rejects relative paths');
  ok(detect.decodeWslOutput('U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000') === 'Ubuntu', 'decodeWslOutput decodes UTF-16LE');
  ok(detect.decodeWslOutput('plain text') === 'plain text', 'decodeWslOutput passes through ASCII');

  // Real WSL runtime checks (skip silently when WSL is unavailable)
  let hasWsl = false;
  try {
    require('child_process').execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    hasWsl = true;
  } catch { /* no WSL */ }

  if (hasWsl) {
    console.log('\n[wsl] WSL present — runtime checks');
    const wslDet = await detect.detectWsl(process.env);
    if (wslDet && wslDet.found) {
      ok(wslDet.source === 'wsl' && wslDet.wsl && wslDet.wsl.distro, 'kimi found inside WSL distro', wslDet.wsl && wslDet.wsl.distro);
      ok(/^\d+\.\d+\.\d+/.test(wslDet.version), `WSL kimi version parsed (${wslDet.version})`);
      const unc = wslDet.wsl.kimiCodeHomeWindows;
      ok(!!unc && fs.existsSync(unc), 'WSL kimi home readable from Windows (UNC)', unc);
      if (unc) {
        const wslSessions = sessionsLib.listSessions({ home: unc });
        ok(Array.isArray(wslSessions), 'session scan runs against WSL home');
      }

      // Spawn the real WSL kimi via PTY (read-only: --version), verify output.
      const spawned = await new Promise((resolve) => {
        const h = ptyLib.spawnWslSession({
          wsl: wslDet.wsl,
          kimiPath: wslDet.path,
          cwd: wslDet.wsl.home,
          args: ['--version'],
          kimiCodeHome: wslDet.wsl.kimiCodeHome,
          env: process.env,
        });
        let out = '';
        const timer = setTimeout(() => { try { h.kill(); } catch { /* noop */ } }, 30000);
        h.on('data', (d) => { out += d; });
        h.on('exit', () => { clearTimeout(timer); resolve(out); });
      });
      ok(spawned.includes(wslDet.version), 'WSL kimi runs through node-pty (--version echoed)', JSON.stringify(spawned).slice(0, 80));
    } else {
      console.log('  (WSL present but no kimi installed inside — skipping WSL runtime checks)');
    }
  } else {
    console.log('  (no WSL on this machine — skipping WSL runtime checks)');
  }

  // -------------------------------------------------------------------------
  // 6. Device-login URL extraction (the Settings → "Sign in to Kimi…" button)
  // -------------------------------------------------------------------------
  // `watchLoginUrl` picks the URL the app opens for sign-in. It lives in the
  // renderer, which has no module system, so pull the real definitions out of
  // renderer/app.js and exercise exactly the shipped code.
  console.log('\n[login] device-login URL extraction');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

  function sliceBraces(src, from) {
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(from, i + 1);
      }
    }
    throw new Error('unbalanced braces');
  }

  const appLines = appSrc.split('\n');
  const constDefs = ['const OSC8_RE', 'const ANSI_RE', 'const LOGIN_URL_RE']
    .map((p) => appLines.find((l) => l.startsWith(p)))
    .filter(Boolean);
  ok(constDefs.length === 3, 'login URL regex constants present in renderer/app.js');

  const watcherStart = appSrc.indexOf('function watchLoginUrl');
  ok(watcherStart !== -1, 'watchLoginUrl present in renderer/app.js');

  if (constDefs.length === 3 && watcherStart !== -1) {
    const opened = [];
    // The watcher opens the URL through openExternalSafe() (which reports a
    // failure instead of a silent no-op), so stand that in here.
    const watchLoginUrl = new Function(
      'api', 'toast', 'openExternalSafe',
      `${constDefs.join('\n')}\n${sliceBraces(appSrc, watcherStart)}\nreturn watchLoginUrl;`,
    )({ openExternal: () => {} }, () => {}, (u) => {
      opened.push(u);
      return Promise.resolve({ ok: true });
    });

    const extract = (chunks) => {
      opened.length = 0;
      const tab = { kind: 'login' };
      for (const chunk of chunks) watchLoginUrl(tab, chunk);
      return opened.slice();
    };

    // Exact shape emitted by `kimi login` (verified against the real CLI).
    const realOutput = extract([
      '\r\nOpening browser for Kimi device login: ',
      'https://www.kimi.com/code/authorize_device?user_code=W5JL-31YE\r\n',
      'If the browser did not open, paste the URL above and enter code: W5JL-31YE\r\n',
    ]);
    ok(realOutput.length === 1 &&
      realOutput[0] === 'https://www.kimi.com/code/authorize_device?user_code=W5JL-31YE',
      'extracts the device-login URL from real kimi login output', JSON.stringify(realOutput));

    const urlCases = [
      ['split across chunks', ['https://www.kimi.com/code/autho', 'rize_device?user_code=ABCD-1234\r\n'], 'ABCD-1234'],
      ['soft-wrapped by the pane', ['https://www.kimi.com/code/authorize_\r\ndevice?user_code=ZZ99-8888\r\n'], 'ZZ99-8888'],
      ['ANSI colourised', ['\x1b[36mhttps://www.kimi.com/code/authorize_device?user_code=QW12-3456\x1b[0m\r\n'], 'QW12-3456'],
      ['an OSC-8 hyperlink', ['\x1b]8;;https://www.kimi.com/code/authorize_device?user_code=HY77-7777\x1b\\open\x1b]8;;\x1b\\\r\n'], 'HY77-7777'],
    ];
    for (const [name, chunks, code] of urlCases) {
      const urls = extract(chunks);
      ok(urls.length === 1 && urls[0].endsWith(`user_code=${code}`),
        `resolves the device URL when ${name}`, JSON.stringify(urls));
    }

    // Must open exactly once, and must stop at the user-code boundary instead
    // of swallowing the sentence that follows it.
    const loginTab = { kind: 'login' };
    opened.length = 0;
    watchLoginUrl(loginTab, 'https://www.kimi.com/code/authorize_device?user_code=AB12-34CDAnd the next sentence follows\r\n');
    watchLoginUrl(loginTab, 'more output\r\n');
    ok(opened.length === 1 && opened[0].endsWith('user_code=AB12-34CD'),
      'opens the sign-in page once, stopping at the user-code boundary', JSON.stringify(opened));
  }

  // -------------------------------------------------------------------------
  // 7. Settings tabs, theme palette and CLI-backed session actions
  // -------------------------------------------------------------------------
  // Static assertions over the real shipped markup/CSS/main-process code, so a
  // later edit can't quietly regress the UI contract: tabs ↔ panels, the
  // self-loading config.toml tab, themed (never bright) scrollbars, and only
  // session actions the kimi CLI actually exposes.
  console.log('\n[ui] settings tabs, theming, session actions');

  const readSrc = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const htmlSrc = readSrc('renderer', 'index.html');
  const cssSrc = readSrc('renderer', 'styles.css');
  const mainSrc = readSrc('main.js');
  const preloadSrc = readSrc('preload.js');

  const uiTabs = [...htmlSrc.matchAll(/class="settings-tab"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const uiPanels = [...htmlSrc.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
  ok(uiTabs.length === 5, `settings has 5 tabs (${uiTabs.join(', ')})`);
  ok(uiTabs.every((t) => uiPanels.includes(t)) && uiPanels.every((p) => uiTabs.includes(p)),
    'every settings tab has a matching panel');
  ok(uiTabs[0] === 'config' && /aria-selected="true">config\.toml</.test(htmlSrc),
    'config.toml is the tab Settings opens on');
  ok(!/id="modal-config"/.test(htmlSrc) && !/st-open-config/.test(htmlSrc),
    'the separate config modal and its "Edit config.toml…" button are gone');
  ok(/setSettingsTab[\s\S]*?loadConfigIntoView\(\)/.test(appSrc),
    'the config.toml tab loads the file when it is shown');

  // The session folder belongs to the Sessions tab: the empty-history
  // "Change Folder" button must open exactly that tab, not Kimi CLI.
  const sessionsPanel = (htmlSrc.match(/<fieldset data-panel="sessions"[\s\S]*?<\/fieldset>/) || [''])[0];
  const cliPanel = (htmlSrc.match(/<fieldset data-panel="cli"[\s\S]*?<\/fieldset>/) || [''])[0];
  ok(/id="st-kimi-home"/.test(sessionsPanel) && !/id="st-kimi-home"/.test(cliPanel),
    'the session-folder setting lives on the Sessions tab, not Kimi CLI');
  ok(/openSettingsModal\('sessions'\)/.test(appSrc),
    'the empty-history "Change Folder" button opens the Sessions tab');

  ok(/\[data-theme="light"\]/.test(cssSrc) && /color-scheme:\s*light/.test(cssSrc),
    'light theme defined and pins color-scheme: light');
  ok(/color-scheme:\s*dark/.test(cssSrc),
    'dark theme pins color-scheme: dark (no bright native scrollbar track)');
  ok(/--scrollbar-thumb/.test(cssSrc), 'scrollbars are painted from palette tokens');

  // Terminal restyle: the framed panel is the default and the classic
  // edge-to-edge terminal stays reachable from Settings → Appearance, so the
  // look can be reverted in the UI instead of only through git.
  ok(/terminalStyle:\s*'panel'/.test(readSrc('src', 'settings.js')),
    'settings default to the framed terminal panel');
  ok(/id="st-term-style"/.test(htmlSrc), 'Appearance offers the terminal style picker');
  ok(/\$\('#st-term-style'\)\.value =/.test(appSrc) && /terminalStyle:\s*\$\('#st-term-style'\)/.test(appSrc),
    'the terminal style is loaded into and saved from the settings modal');
  ok(/function applyTerminalStyle/.test(appSrc) && /classList\.toggle\('term-classic'/.test(appSrc),
    'applyTerminalStyle() switches to the classic fallback');
  ok(/theme: terminalTheme\(\)/.test(appSrc) && !/theme: THEMES\[s\.theme\]/.test(appSrc),
    'the xterm palette is derived from the CSS tokens, not hardcoded');
  ok(/function terminalTheme/.test(appSrc) && /cssToken\('--terminal-bg'/.test(appSrc),
    'the terminal background is read back from --terminal-bg');
  ok(/body:not\(\.term-classic\) \.terminal-host/.test(cssSrc) && /body\.term-classic/.test(cssSrc),
    'the framed panel and the classic opt-out both live in CSS');
  ok(/scrollbarSliderBackground/.test(appSrc),
    "xterm's own scrollbar is painted from the app palette too");
  // The tab strip centres its children, so the "+" is already on the tabs'
  // optical row — a vertical nudge on it is a correction applied twice and
  // floats the button off the row (measured: 9px high with translateY(-9px)).
  const addTabRule = cssSrc.match(/\.add-tab\s*\{([^}]*)\}/);
  ok(addTabRule && !/transform\s*:/.test(addTabRule[1]),
    'the tab-strip "+" carries no vertical transform (bar centring already aligns it)');
  ok(/\.gear-btn:hover\s*\{\s*background:\s*transparent/.test(cssSrc),
    'settings gear keeps a transparent background on hover');

  ok(/ipcMain\.handle\('session:export'/.test(mainSrc) && /exportSession:/.test(preloadSrc),
    'session export is wired main ⇄ preload');
  // Changing the session folder must reload the window: settings:set persists,
  // app:reload-window kills live PTYs (they still carry the old env) and
  // reboots the renderer, and the settings save path triggers it on a changed
  // KIMI_CODE_HOME so the switch is visible without a manual restart.
  ok(/ipcMain\.handle\('app:reload-window'/.test(mainSrc) && /reloadWindow:/.test(preloadSrc)
    && /api\.reloadWindow\(\)/.test(appSrc)
    && /patch\.kimiCodeHome !== oldKimiHome/.test(appSrc),
    'a changed session folder kills live sessions and reloads the window (Apply)');
  ok(/id="st-save"[^>]*>Apply changes</.test(htmlSrc),
    'the settings save button is labelled "Apply changes"');
  ok(/Array\.isArray\(opts\.argv\)/.test(mainSrc) && /argv: Array\.isArray\(argv\)/.test(appSrc),
    'literal kimi argv is forwarded (fork)');
  ok(/\['fork', s\.id, '-y'\]/.test(appSrc), 'fork runs the CLI: kimi fork <id> -y');
  ok(/\['export', id, '-o', wslSafePath\(target\), '-y'\]/.test(mainSrc),
    'export runs the CLI: kimi export <id> -o <path> -y');

  const menuActions = [...appSrc.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
  ok(menuActions.includes('resume') && menuActions.includes('fork') &&
    menuActions.includes('export') && menuActions.includes('copy-id'),
    `session actions are the CLI-backed ones (${[...new Set(menuActions)].join(', ')})`);
  ok(!menuActions.includes('delete') && !menuActions.includes('archive'),
    'no delete/archive action — the kimi CLI has no such command');

  // -------------------------------------------------------------------------
  // 8. Packaging integrity and path privacy
  // -------------------------------------------------------------------------
  // A published app has to be self-consistent: everything the renderer loads
  // must be declared or shipped, every installer must point at the same repo,
  // and no user-visible path may leak the OS account name.
  console.log('\n[integrity] packaging, installers & path privacy');

  const pkg = require('../package.json');
  const repoFile = (...p) => path.join(__dirname, '..', ...p);

  // 8a. index.html pulls the terminal libraries straight out of node_modules —
  // a name that is not a declared dependency ships a broken app.
  const depNames = Object.keys(pkg.dependencies || {});
  const htmlDeps = [...htmlSrc.matchAll(/(?:src|href)="\.\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)]
    .map((m) => m[1]);
  ok(htmlDeps.length > 0, 'renderer loads its terminal libraries from node_modules');
  const undeclared = [...new Set(htmlDeps)].filter((d) => !depNames.includes(d));
  ok(undeclared.length === 0, 'every node_modules import is a declared dependency', undeclared.join(', '));

  // 8b. Assets the UI and README reference must actually exist (icons, fonts,
  // screenshots) — a missing one is a broken image for every user.
  const assetRefs = [
    ...cssSrc.matchAll(/url\("\.\.\/([^"]+)"\)/g),
    ...htmlSrc.matchAll(/src="\.\.\/(?!node_modules)([^"]+)"/g),
    ...readSrc('README.md').matchAll(/src="((?:assets|docs)\/[^"]+)"/g),
  ].map((m) => m[1]);
  ok(assetRefs.length > 0, 'UI and README reference bundled assets');
  const missingAssets = [...new Set(assetRefs)].filter((a) => !fs.existsSync(repoFile(a)));
  ok(missingAssets.length === 0, 'every referenced asset is present in the repo', missingAssets.join(', '));

  // 8c. One repo name, everywhere: the installers and README fetch from the
  // same GitHub slug package.json publishes.
  const repoSlug = (/github\.com\/([^/]+\/[^/.]+)/.exec((pkg.repository && pkg.repository.url) || '') || [])[1];
  ok(!!repoSlug, 'package.json declares a GitHub repository');
  const slugRefs = [
    ...readSrc('install.sh').matchAll(/REPO="([^"]+)"/g),
    ...readSrc('install.ps1').matchAll(/\$Repo\s*=\s*"([^"]+)"/g),
    ...readSrc('README.md').matchAll(/raw\.githubusercontent\.com\/([^/\s]+\/[^/\s]+)\/(?:master|main)\/install\.(?:sh|ps1)/g),
  ].map((m) => m[1]);
  ok(slugRefs.length >= 3 && slugRefs.every((s) => s === repoSlug),
    `installers and README all point at ${repoSlug}`, slugRefs.join(', '));

  // 8d. Path privacy: genericPath() swaps the home directory for ~ /
  // %USERPROFILE% so the account name never reaches the screen.
  const gpStart = appSrc.indexOf('function genericPath');
  ok(gpStart !== -1, 'renderer defines genericPath() for display-safe paths');
  if (gpStart !== -1) {
    const makeGenericPath = (st, wslMode) => new Function(
      'state', 'isWsl',
      `${sliceBraces(appSrc, gpStart)}\nreturn genericPath;`,
    )(st, () => wslMode);
    const win = makeGenericPath({ homeDir: 'C:\\Users\\jane', kimi: null }, false);
    const linux = makeGenericPath({ homeDir: '/home/jane', kimi: null }, false);
    const wsl = makeGenericPath(
      { homeDir: 'C:\\Users\\jane', kimi: { wsl: { home: '/home/jane' } } }, true,
    );

    ok(win('C:\\Users\\jane\\.kimi-code\\config.toml') === '%USERPROFILE%\\.kimi-code\\config.toml',
      'Windows home collapses to %USERPROFILE%');
    ok(win('c:\\users\\JANE\\.kimi-code') === '%USERPROFILE%\\.kimi-code',
      'Windows home is matched case-insensitively');
    ok(linux('/home/jane/.kimi-code/sessions') === '~/.kimi-code/sessions',
      'Linux home collapses to ~');
    ok(linux('/opt/kimi/bin/kimi') === '/opt/kimi/bin/kimi',
      'paths outside the home directory are untouched');
    ok(wsl('/home/jane/.kimi-code') === '~/.kimi-code',
      'WSL uses the distro home, not the Windows one');
    ok(linux('') === '' && linux(null) === '', 'empty paths pass through untouched');

    ok(/genericPath\(state\.kimi\.path\)/.test(appSrc) &&
      /genericPath\(state\.kimiHomeDisplay/.test(appSrc),
      'status bar and kimi status show display-safe paths');
    ok(/CANDIDATE_HINTS\s*=\s*\{/.test(appSrc) && !/cands\.map\(/.test(appSrc),
      'CLI install hints are fixed display-safe constants (no raw candidate dump)');
    ok(!/\$\{\s*res\.path\s*\}/.test(appSrc) && !/=\s*res\.path\b/.test(appSrc),
      'no read-only path is rendered raw (config path, export confirmation)');
  }

  // 8d-bis. Session grouping is pure logic, so it is exercised directly instead
  // of through the DOM: project mode must key on the full directory (two projects
  // sharing a folder name are different projects), order groups by their newest
  // session, and keep sessions with no recorded folder rather than dropping them.
  const gsStart = appSrc.indexOf('function groupSessions');
  ok(gsStart !== -1, 'renderer defines groupSessions() for the sidebar');
  if (gsStart !== -1) {
    const makeGroupSessions = new Function(
      `${sliceBraces(appSrc, appSrc.indexOf('function dateBucket'))}
       ${sliceBraces(appSrc, appSrc.indexOf('function projectName'))}
       ${sliceBraces(appSrc, gsStart)}
       return groupSessions;`,
    )();
    const nowMs = Date.now();
    const mk = (id, cwd, ageDays) => ({ id, cwd, updatedAt: nowMs - ageDays * 86400000 });

    const twoApps = [mk('a', '/work/one/app', 1), mk('b', '/work/two/app', 0)];
    const proj = makeGroupSessions(twoApps, 'project', []);
    ok(proj.length === 2 && proj.every((g) => g.label === 'app'),
      'folders that share a name stay separate projects', proj.map((g) => g.key).join(' | '));
    ok(proj[0].items[0].id === 'b', 'the most recently used project is listed first');

    const sameDir = makeGroupSessions([mk('c', '/work/one/app/', 0), mk('d', '/work/one/app', 5)], 'project', []);
    ok(sameDir.length === 1 && sameDir[0].items.length === 2,
      'a trailing slash does not split one folder into two groups', sameDir.length);
    const winCase = makeGroupSessions([mk('e', 'C:\\Work\\App', 0), mk('f', 'c:\\work\\app', 1)], 'project', []);
    ok(winCase.length === 1, 'Windows paths group case-insensitively', winCase.length);

    const noCwd = makeGroupSessions([mk('g', '', 0), mk('h', '/work/one/app', 30)], 'project', []);
    ok(noCwd.length === 2 && noCwd[noCwd.length - 1].label === 'No folder recorded',
      'sessions with no recorded folder are grouped, not dropped', noCwd.map((g) => g.label).join(','));
    ok(noCwd[noCwd.length - 1].key === 'project:none', 'the folderless group has a stable key');

    const folded = makeGroupSessions(twoApps, 'project', ['project:/work/one/app']);
    ok(folded.find((g) => g.key === 'project:/work/one/app').collapsed === true &&
      folded.find((g) => g.key === 'project:/work/two/app').collapsed === false,
      'a folded group is restored from settings');

    const byDate = makeGroupSessions([mk('i', '/work/one/app', 0), mk('j', '/work/one/app', 40)], 'date', []);
    ok(byDate.map((g) => g.label).join(',') === 'Today,Older',
      'date mode still buckets by age', byDate.map((g) => g.label).join(','));
  }

  // 8e. Boot / UX wiring added by the fast-start work: the splash cover, the
  // sessions-folder affordance, and a non-blocking bootstrap.
  ok(/id="splash"/.test(htmlSrc) && /#splash/.test(cssSrc) && /function hideSplash/.test(appSrc),
    'splash cover is defined in markup, CSS and renderer');
  ok(/detectionSettled/.test(mainSrc) && /pending: true/.test(mainSrc),
    'bootstrap answers immediately while detection finishes in the background');
  ok(/ipcMain\.handle\('shell:open-path'/.test(mainSrc) && /openPath:/.test(preloadSrc),
    'opening a local folder is wired main ⇄ preload');
  ok(!/id="btn-open-sessions-folder"/.test(htmlSrc) && !/id="btn-group-sessions"/.test(htmlSrc),
    'the sidebar header carries no grouping or open-folder buttons (refresh only)');
  ok(/const allowed = new Set\(\[/.test(mainSrc),
    'app:get-path only serves an allow-listed set of names');
  ok(!/<\/br>/.test(htmlSrc + appSrc), 'no invalid </br> tags in the renderer');

  // 8f. Resume safety: kimi refuses to resume a session from any directory other
  // than the one it was created in, so the app must never substitute another one
  // (that produced "Session ... was created under a different directory" and a
  // tab that died on open).
  const tmpResumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-resume-'));
  const existsDir = path.join(tmpResumeDir, 'project');
  fs.mkdirSync(existsDir, { recursive: true });
  const existingPlan = sessions.resumePlan(existsDir);
  ok(existingPlan.ok === true && existingPlan.reason === 'exists' && existingPlan.cwd === existsDir,
    'resumePlan accepts an existing directory as-is');
  const missingPlan = sessions.resumePlan(path.join(tmpResumeDir, 'gone'));
  ok(missingPlan.ok === false && missingPlan.reason === 'missing' && missingPlan.cwd.endsWith('gone'),
    'resumePlan flags a missing working directory instead of falling back to another');
  const unknownPlan = sessions.resumePlan('   ');
  ok(unknownPlan.ok === false && unknownPlan.reason === 'unknown',
    'resumePlan flags a session with no recorded directory');
  const filePath = path.join(tmpResumeDir, 'file.txt');
  fs.writeFileSync(filePath, 'x');
  ok(sessions.resumePlan(filePath).reason === 'missing',
    'resumePlan rejects a path that is a file, not a directory');
  fs.rmSync(tmpResumeDir, { recursive: true, force: true });

  ok(/prepareResume/.test(mainSrc) && /resumePlan\(/.test(mainSrc),
    'session:start routes resume through the recorded-directory guard');
  ok(/'resume-cwd-unknown'/.test(mainSrc) && /'resume-cwd-missing'/.test(mainSrc),
    'resume failures reach the renderer as errors, not as a silent directory swap');
  ok(!/^\s*if \(!fs\.existsSync\(cwd\)\) cwd = os\.homedir\(\);/m.test(mainSrc),
    'the home-directory fallback can no longer swallow a resume cwd');
  ok(/resume-cwd-unknown/.test(appSrc) && /resume-cwd-missing/.test(appSrc),
    'the renderer explains why a resume could not start');

  // 8g. OS opener honesty: on Linux Electron reports success even when xdg-open
  // is missing or broken, which is how "open folder" / docs / sign-in buttons
  // became silent no-ops.
  ok(/async function openWithOs/.test(mainSrc) && /LINUX_OPENERS/.test(mainSrc),
    'links and folders go through an opener that reports real failures');
  ok(!/shell\.openPath\(/.test(mainSrc) && /await openWithOs\(target\)/.test(mainSrc),
    'shell:open-path waits for the result instead of assuming success');
  ok(/openExternalSafe/.test(appSrc),
    'the renderer reports a link that could not be opened');
  // (The old sessions-folder button and its opener check are gone — the
  // sidebar header now carries only the refresh control.)
  ok(/'\/usr\/bin\/xdg-open'/.test(mainSrc),
    'the absolute xdg-open is tried before PATH (a broken shim can shadow it)');
  ok(/reported an error/.test(mainSrc),
    'the opener treats a chatty exit-0 (gio on broken WSL) as failure, not success');

  // 8h. Preview workflow: run the live source instead of building and installing.
  ok(typeof pkg.scripts.dev === 'string' && /--dev/.test(pkg.scripts.dev),
    'npm run dev launches the app straight from source');
  ok(/DEV_MODE/.test(mainSrc) && /openDevTools/.test(mainSrc) && /\[renderer\]/.test(mainSrc),
    'dev mode opens DevTools and forwards renderer console output');

  // 8i. Portable Windows builds run from a copy the NSIS stub extracts into
  // %TEMP% and deletes the moment this process exits, so relaunching
  // process.execPath pointed the child at a file that was about to vanish — the
  // self-heal died on exactly the machines that need it (RDP, network shares).
  ok(/function relaunchExecutable/.test(mainSrc) && /PORTABLE_EXECUTABLE_FILE/.test(mainSrc),
    'the relaunch targets the real launcher of a portable build, not the %TEMP% copy');
  ok(/spawn\(\s*relaunchExecutable\(\)/.test(mainSrc),
    'relaunchWithFlags spawns relaunchExecutable()');
  ok(!/spawn\(\s*process\.execPath/.test(mainSrc),
    'no code spawns process.execPath directly');

  // 8j. Terminal styling. xterm ships its layout CSS as a separate file from
  // its JS: drop it and .xterm-helpers stays in normal flow while
  // .xterm-char-measure-element is never hidden, so xterm's glyph-measurement
  // scratch text paints as a bar of stray characters above the first row.
  const xtermCssHref = '../node_modules/@xterm/xterm/css/xterm.css';
  ok(htmlSrc.includes(xtermCssHref), 'index.html loads xterm’s own stylesheet');
  if (fs.existsSync(repoFile('node_modules', '@xterm', 'xterm'))) {
    ok(fs.existsSync(repoFile('node_modules', '@xterm', 'xterm', 'css', 'xterm.css')),
      'xterm.css is present in node_modules (shipped with the app)');
  }

  // 8k. Session start is covered by a branded loader until the CLI paints. Any
  // path that can leave the pane without output has to lift it again, or the
  // cover hides the session it was meant to decorate.
  ok(/function createPaneLoader/.test(appSrc) && /function clearPaneLoader/.test(appSrc),
    'the renderer has a per-session loading cover');
  ok(/clearPaneLoader\(tab\); \/\/ first output/.test(appSrc),
    'the cover lifts on the first PTY output');
  const loaderLifts = (appSrc.match(/clearPaneLoader\(tab\)/g) || []).length;
  ok(loaderLifts >= 4,
    `output, replay, exit and the failsafe all lift the cover (${loaderLifts} sites)`);
  ok(/if \(tab\.loaderTimer\) \{ clearTimeout\(tab\.loaderTimer\)/.test(appSrc),
    'closing a tab cancels its loader failsafe timer');
  ok(/\.pane-loader\s*\{[\s\S]*?pointer-events:\s*none/.test(cssSrc),
    'the loading cover never swallows a click aimed at the terminal');

  // 8l. Notifications belong in the bottom-left, consistent with the chrome.
  const toastHostCss = (/\.toast-host\s*\{([\s\S]*?)\}/.exec(cssSrc) || [])[1] || '';
  ok(/left:\s*16px/.test(toastHostCss) && /bottom:\s*46px/.test(toastHostCss) &&
    /right:\s*auto/.test(toastHostCss),
    'toasts are anchored to the bottom-left corner');
  ok(/toast-in\s*\{[^}]*translateX\(-10px\)/.test(cssSrc),
    'toasts slide in from the edge they are anchored to');
  ok(/toast-msg/.test(appSrc) && /\.toast-icon/.test(cssSrc),
    'toasts render an icon beside the message');
  ok(/text\.textContent = msg/.test(appSrc),
    'toast messages are set as text, never as markup');

  // 8m. Icons are inline SVG, never text glyphs. A glyph only draws if a font
  // installed on the machine covers its codepoint — with none, the OS paints an
  // empty tofu box in the middle of the button. That is machine-dependent (a
  // bare Linux box covers none of these; Windows covers some), so the same
  // build looked broken on one machine and fine on another. Guard the whole set.
  const glyphIcons = [
    '\uFF0B', '\u2442', '\u29C9', '\uD83D\uDD11', '\u2387', '\u26A1', '\u25C6',
    '\u2715', '\u2713', '\u21BB', '\u21A9', '\u21E9', '\u2191', '\u2193', '\u2197',
  ];
  const glyphHits = [['renderer/app.js', appSrc], ['renderer/index.html', htmlSrc]]
    .flatMap(([file, src]) => glyphIcons.filter((g) => src.includes(g))
      .map((g) => `${file} U+${g.codePointAt(0).toString(16).toUpperCase()}`));
  ok(glyphHits.length === 0,
    'no font-dependent glyph icons left in the UI markup', glyphHits.join(', '));
  ok(/const ICONS = \{/.test(appSrc) && /function ico\(name, cls\)/.test(appSrc),
    'the renderer ships an inline-SVG icon set');
  const icoUses = (appSrc.match(/ico\(/g) || []).length;
  ok(icoUses >= 8, `every former glyph icon now renders SVG (${icoUses} call sites)`);
  ok(/\.ico\s*\{[\s\S]*?width:\s*1em/.test(cssSrc),
    '.ico icons size themselves from the surrounding text');
  ok(/\.toast-icon \.ico/.test(cssSrc) && /\.ctx-icon \.ico/.test(cssSrc) &&
    /\.btn \.ico/.test(cssSrc),
    'icons are sized for the button, toast and menu slots');
  ok(/\.mode-card input\s*\{[\s\S]*?opacity:\s*0/.test(cssSrc),
    'permission-mode radios stay hidden behind the custom card state');

  // -------------------------------------------------------------------------
  // 9. Terminal plumbing — the app's whole reason to exist
  // -------------------------------------------------------------------------
  // Drives the real src/pty.js against the fake kimi CLI in an actual
  // pseudo-terminal and checks what the CLI receives plus a keystroke
  // round-trip. Needs node-pty, so a bare checkout skips it — `npm run smoke`
  // stays runnable without `npm install`.
  console.log('\n[pty] fake kimi CLI in a real pseudo-terminal');

  let hasPty = true;
  try { require('@lydell/node-pty'); } catch { hasPty = false; }

  if (!hasPty) {
    console.log('  (node-pty not installed — run `npm install` to include this section)');
  } else {
    const ptyLib = require('../src/pty');
    const fakeBinDir = path.join(__dirname, '..', 'test-fixtures', 'bin');
    const ptyEnv = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`,
      KIMI_CODE_HOME: path.join(__dirname, '..', 'test-fixtures', 'kimi-home'),
      // Only a test harness may use the fake CLI (the app refuses it otherwise).
      KCD_TEST_HARNESS: '1',
    };

    const det = await detect.detect({ env: ptyEnv, allowWsl: false });
    ok(det.found && det.version === '9.9.9-test',
      'the fake CLI fixture is found on PATH (kimi.cmd on Windows, shim elsewhere)',
      `${det.path} — ${det.version}`);

    // Resolve when every expectation token has shown up in the PTY output, or
    // when the process exits, or on timeout (so a hang can never wedge CI).
    const drive = (args, expects, send) => new Promise((resolve) => {
      const seen = (b) => expects.every((t) => b.includes(t));
      let buf = '';
      let settled = false;
      let timer = null;
      const session = ptyLib.spawnKimiSession({
        binary: det.path,
        cwd: path.join(__dirname, '..'),
        args,
        env: ptyEnv,
        cols: 100,
        rows: 30,
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { session.kill(); } catch { /* already gone */ }
        resolve({ ok: seen(buf), buf });
      };
      timer = setTimeout(finish, 15000);
      session.on('data', (d) => {
        buf += d;
        if (seen(buf)) return finish();
        if (send && buf.includes('INPUT:')) setTimeout(() => session.write(`${send}\r`), 200);
      });
      session.on('exit', finish);
    });

    // Token-based expectations so the per-OS quoting of argv never matters.
    const cases = [
      ['resume sends --session <id>',
        ptyLib.buildArgs({ mode: 'default', resumeId: 'abc123' }), ['--session', 'abc123'], null],
      ['quick task sends --yolo --prompt',
        ptyLib.buildArgs({ mode: 'yolo', quickPrompt: 'Explain this repo' }), ['--yolo', '--prompt', 'Explain'], null],
      ['sign-in prints the device code', ['login'], ['ENTER CODE: ABCD-EFGH'], null],
      ['keystrokes reach the CLI',
        ptyLib.buildArgs({ mode: 'default' }), ['YOU-TYPED:hello kimi'], 'hello kimi'],
    ];

    for (const [name, args, expects, send] of cases) {
      const result = await drive(args, expects, send);
      ok(result.ok, name, JSON.stringify(String(result.buf).replace(/\r?\n/g, ' | ').slice(0, 140)));
    }

    // Electron runs a DIFFERENT ABI from plain Node, so an addon that passes
    // the checks above can still be unloadable inside the app — that is exactly
    // how a prebuilt PTY once shipped broken (every session failed to start).
    // Load the real module through the real Electron binary to prove it works.
    const electronBin = path.join(
      __dirname, '..', 'node_modules', 'electron', 'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );
    if (!det.found || !fs.existsSync(electronBin)) {
      console.log('  (electron not installed — skipping the Electron-runtime check)');
    } else {
      const probe = `
        const path = require('path');
        const root = process.env.KCD_ROOT;
        const ptyLib = require(path.join(root, 'src', 'pty'));
        const session = ptyLib.spawnKimiSession({
          binary: process.env.KCD_FAKE,
          cwd: root,
          args: ptyLib.buildArgs({ mode: 'default', resumeId: 'probe' }),
          env: process.env,
          cols: 80,
          rows: 24,
        });
        let buf = '';
        const bail = () => { console.log('ELECTRON_PTY_FAIL ' + JSON.stringify(buf.slice(0, 120))); process.exit(1); };
        const timer = setTimeout(bail, 20000);
        session.on('data', (d) => {
          buf += d;
          if (buf.includes('--session probe')) { clearTimeout(timer); session.kill(); console.log('ELECTRON_PTY_OK'); process.exit(0); }
        });
        session.on('exit', () => {
          clearTimeout(timer);
          if (buf.includes('--session probe')) { console.log('ELECTRON_PTY_OK'); process.exit(0); }
          bail();
        });
      `;
      let probeOut = '';
      try {
        probeOut = execFileSync(electronBin, ['-e', probe], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            KCD_ROOT: path.join(__dirname, '..'),
            KCD_FAKE: det.path,
          },
          encoding: 'utf8',
          timeout: 60000,
        });
      } catch (err) {
        probeOut = `${(err && err.stdout) || ''}${(err && err.stderr) || ''}${(err && err.message) || ''}`;
      }
      ok(probeOut.includes('ELECTRON_PTY_OK'),
        'the PTY addon loads and spawns a session under the Electron runtime',
        String(probeOut).trim().split('\n').pop().slice(0, 160));
    }
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED ✔' : `\n${failures} CHECK(S) FAILED ✘`);
  process.exit(failures === 0 ? 0 : 1);
})();