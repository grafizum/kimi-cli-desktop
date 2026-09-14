'use strict';

// End-to-end test: launches the real Electron app with a fake `kimi` binary and
// a fake KIMI_CODE_HOME, then drives the UI over the Chrome DevTools Protocol.
// Requires Node >= 22 (built-in fetch + WebSocket).
// Run with: npm run e2e

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// KCD_APP_BIN points the same suite at a packaged build (dist/…-unpacked), so the
// shipped artifact can be tested rather than only the source tree.
const PACKAGED = process.env.KCD_APP_BIN || '';
const ELECTRON = PACKAGED || path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const APP_ARGV = PACKAGED ? [] : ['.'];
// The app serves CDP on whatever port it is handed. A fixed port would collide
// with an instance from a previous run that is still shutting down (the app
// looks connected but the target list is stale or empty), so pick one per run.
// Override with KCD_E2E_PORT when something needs a fixed value.
const PORT = Number(process.env.KCD_E2E_PORT) || 9300 + Math.floor(Math.random() * 600);
const FAKE_BIN = path.join(ROOT, 'test-fixtures', 'bin');
// The committed fixture points its sessions at Windows-style placeholder paths
// that exist on no machine. kimi — and now the app — only resumes a session from
// the directory it was created in, so copy the fixture home into a temp dir and
// point every session at a real workspace directory. Without this the app's
// missing-directory guard (correctly) refuses the resume and the suite would be
// asserting the wrong behaviour. The temp name keeps "kimi-home" in the path so
// the status-bar assertion still sees it.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-ws-'));
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
fs.cpSync(path.join(ROOT, 'test-fixtures', 'kimi-home'), FAKE_HOME, { recursive: true });
// A second, empty home for the settings → session-folder round trip: saving a
// new KIMI_CODE_HOME reloads the window, and this one must show up afterwards.
const FAKE_HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home2-'));
fs.mkdirSync(path.join(FAKE_HOME2, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME2, 'session_index.jsonl'), '');
fs.writeFileSync(path.join(FAKE_HOME2, 'config.toml'), '# empty test home\n');

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walkFiles(path.join(dir, e.name))
    : [path.join(dir, e.name)]));
}

(function pointFixtureSessionsAtRealDirs() {
  const cwds = new Map();
  for (const file of walkFiles(FAKE_HOME)) {
    if (path.basename(file) !== 'state.json') continue;
    const id = path.basename(path.dirname(file));
    const cwd = path.join(WORKSPACE, id);
    fs.mkdirSync(cwd, { recursive: true });
    cwds.set(id, cwd);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.cwd = cwd;
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  }
  // session_index.jsonl supplies the cwd for sessions whose state.json has none.
  const indexPath = path.join(FAKE_HOME, 'session_index.jsonl');
  const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => {
      const rec = JSON.parse(line);
      if (cwds.has(rec.sessionId)) rec.workDir = cwds.get(rec.sessionId);
      return JSON.stringify(rec);
    });
  fs.writeFileSync(indexPath, `${lines.join('\n')}\n`);
})();

// Throwaway profile: keeps the single-instance lock (and settings.json) away
// from the developer's real profile, and stops two runs from sharing state.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kcd-e2e-'));

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Launch app with CDP
// ---------------------------------------------------------------------------
const env = {
  ...process.env,
  PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH || ''}`,
  KIMI_CODE_HOME: FAKE_HOME,
  // The app refuses the fake kimi everywhere else: this flag is the only way a
  // test double is accepted, and it also makes the window label itself as a
  // test run so a leftover suite window can never be mistaken for the real app.
  KCD_TEST_HARNESS: '1',
};
// The app takes a single-instance lock and serves CDP on a fixed port, so any
// instance left over from an earlier run would answer instead of the fresh one
// (carrying that run's leftover UI state, e.g. an active session filter).
// Clear the field before launching.
function killStrayApps(settleMs = 0) {
  // Sweep the binary *this run* launched — the source electron by default, the
  // packaged build under KCD_APP_BIN. Never a broader pattern: the user's own
  // installed app must survive a test run.
  const target = PACKAGED || path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/IM', path.basename(target)], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', target], { stdio: 'ignore' });
    }
  } catch { /* nothing was running */ }
  // Give the port and the lock a moment to be released (a busy-wait, the same
  // trick src/sessions.js uses for slow filesystems).
  const until = Date.now() + settleMs;
  while (Date.now() < until) { /* wait */ }
}

killStrayApps(1200);

// Headless CI machines run as root without a setuid sandbox helper, so
// Chromium refuses to start without this flag (locally unnecessary).
const SANDBOX_FLAG = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
const app = spawn(ELECTRON, [...APP_ARGV, ...SANDBOX_FLAG, `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
});
let appStderrTail = '';
app.stdout.on('data', () => {});
app.stderr.on('data', (d) => {
  // Kept (last lines only) so a boot failure is diagnosable from the log:
  // the suite otherwise discards the app's stderr, and a Chromium that
  // refuses to start would fail as a bare "timeout waiting for app target".
  appStderrTail = (appStderrTail + d.toString()).split(/\r?\n/).slice(-15).join('\n');
});

// A suite killed mid-run (Ctrl+C, crash, CI timeout) must still take its app
// window down — a survivor looks exactly like the real app and once left a
// stray window driving the fake CLI. Sweep on every exit path; the 1s window
// deduplicates the SIGINT/SIGTERM pair.
let killed = false;
function reap() {
  if (killed) return;
  killed = true;
  try { app.kill('SIGKILL'); } catch { /* already gone */ }
  killStrayApps();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(FAKE_HOME2, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { reap(); process.exit(130); });
process.on('SIGTERM', () => { reap(); process.exit(143); });

// ---------------------------------------------------------------------------
// Minimal CDP client (Node built-in WebSocket)
// ---------------------------------------------------------------------------
let ws = null;
let msgId = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(fn, what, timeoutMs = 30000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await delay(300);
  }
  throw new Error(`timeout waiting for ${what}${lastErr ? ` (${lastErr.message})` : ''}`);
}

async function main() {
  // Wait for the CDP endpoint + page target
  let target = null;
  await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    return target;
  }, 'app page target', 60000);

  await connect(target.webSocketDebuggerUrl);

  // Slow disks (and WSL/network mounts) can keep the page loading for a while —
  // wait for a fully parsed DOM before evaluating anything.
  await waitFor(async () => (await evalJS('document.readyState')) === 'complete',
    'page load complete', 60000);

  console.log('\n[e2e] app booted — driving UI over CDP\n');

  // 1. Detection picked up the fake kimi (detection itself can take a while on
  // slow machines — PATH lookup + npm prefix + version probes)
  await waitFor(async () =>
    (await evalJS(`document.querySelector('#kimi-status-text').textContent`)).includes('9.9.9'),
    'kimi detected (9.9.9)', 60000);
  const version = await evalJS(`document.querySelector('#kimi-status-text').textContent`);
  ok(/kimi\s+v?9\.9\.9/.test(version), 'kimi binary detected + version shown', version);

  const homeShown = await evalJS(`document.querySelector('#status-home').textContent`);
  ok(homeShown.includes('kimi-home'), 'KIMI_CODE_HOME shown in status bar', homeShown);

  // 1b. A test window must be unmistakable: the banner is visible and the
  // window title carries the [TEST RUN] suffix.
  ok((await evalJS(`!document.querySelector('#test-banner').classList.contains('hidden')`)),
    'the TEST RUN banner is visible in a test-harness window');
  ok((await evalJS(`document.title`)).includes('[TEST RUN]'),
    'the window title carries the [TEST RUN] suffix', await evalJS(`document.title`));

  // 1a. Icons are inline SVG, never text glyphs. A glyph icon only draws when a
  // font installed on the machine covers its codepoint — when none does, the OS
  // paints an empty box in the middle of the button. Same build, different
  // machine, different result — so nothing in the UI may depend on a font.
  const iconScan = await evalJS(`(() => {
    const glyphs = ['\\uFF0B','\\u2442','\\u29C9','\\uD83D\\uDD11','\\u2387','\\u26A1','\\u25C6','\\u2715','\\u2713','\\u21BB','\\u21A9','\\u21E9','\\u2191','\\u2193','\\u2197'];
    const bad = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      for (const g of glyphs) if (n.nodeValue.includes(g)) bad.push('U+' + g.codePointAt(0).toString(16).toUpperCase() + ' in "' + n.nodeValue.trim().slice(0, 24) + '"');
    }
    const visible = [...document.querySelectorAll('.ico')].filter((s) => (s.checkVisibility ? s.checkVisibility() : s.offsetParent !== null));
    const tiny = visible.filter((s) => { const r = s.getBoundingClientRect(); return r.width < 5 || r.height < 5; }).length;
    return { bad, visible: visible.length, tiny };
  })()`);
  ok(iconScan.bad.length === 0, 'no font-dependent glyph icon is rendered', iconScan.bad.join(', '));
  ok(iconScan.visible >= 4, `the chrome draws SVG icons (${iconScan.visible} visible)`, iconScan);
  ok(iconScan.tiny === 0, 'every visible icon has a real size', iconScan.tiny);

  // 2. Session history rendered from the fake home
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.session-item').length`)) === 2,
    '2 sessions listed');
  const items = await evalJS(`[...document.querySelectorAll('.session-item .si-title')].map(e => e.textContent)`);
  ok(items[0] === 'Add payment webhook' || items[1] === 'Add payment webhook', 'titled session listed', items.join(' | '));
  // Grouping defaults to project folders: each fixture session lives in its own
  // temp workspace directory, so the headers carry those folder names.
  const labels = () => evalJS(`[...document.querySelectorAll('.session-group-label .sgl-text')].map(e => e.textContent)`);
  const projGroups = await labels();
  ok(projGroups.includes('session-alpha') && projGroups.includes('session-beta'),
    'sessions are grouped by project folder by default', projGroups.join(','));
  const counts = await evalJS(`[...document.querySelectorAll('.sgl-count')].map(e => e.textContent)`);
  ok(counts.every((c) => Number(c) >= 1), 'each group header shows how many sessions it holds', counts.join(','));

  // Folding a group hides its rows; unfolding brings them back.
  const rowsBeforeFold = await evalJS(`document.querySelectorAll('.session-item').length`);
  await evalJS(`document.querySelector('.session-group-label').click()`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.session-item').length`)) < rowsBeforeFold,
    'a group folds and hides its rows');
  ok(true, 'a group folds and hides its sessions');
  await evalJS(`document.querySelector('.session-group-label').click()`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.session-item').length`)) === rowsBeforeFold,
    'the group unfolds again');
  ok(true, 'unfolding the group restores its sessions');

  // (The header group toggle was removed — date grouping stays covered by the
  // smoke suite's groupSessions unit checks.)

  // 3. New interactive session → PTY spawns → TUI output streams
  await evalJS(`document.querySelector('#btn-new-session').click()`);
  await waitFor(async () => await evalJS(`!document.querySelector('#modal-new-session').classList.contains('hidden')`),
    'new-session modal open');
  await evalJS(`document.querySelector('#ns-start').click()`);

  await waitFor(async () => (await evalJS(`document.querySelectorAll('.tab').length`)) === 1, 'tab created');
  await waitFor(async () => {
    const line = await evalJS(`__kcd.state.activeTabId ? (__kcd.state.tabs.get(__kcd.state.activeTabId).term.buffer.active.getLine(0) || {}).translateToString(true) : ''`);
    return String(line).includes('KIMI-TUI-STARTED');
  }, 'TUI start line in terminal buffer');
  ok(true, 'interactive session streams PTY output into xterm');

  // The loading cover must be gone now that the CLI has painted, and xterm's
  // stylesheet must be applied: without it the glyph-measuring element is
  // visible and paints a bar of stray characters above the first row.
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.pane-loader').length`)) === 0,
    'session loading cover to lift (it fades out after the first output)', 5000);
  ok(true, 'the session loading cover lifts once the CLI paints');
  ok((await evalJS(`getComputedStyle(document.querySelector('.xterm-char-measure-element')).visibility`)) === 'hidden',
    'xterm measures glyphs in a hidden element (no stray bar above row 0)');

  // The tab-strip "+" must sit on the tabs' optical row. Measured geometrically
  // rather than asserted from CSS: #tabbar centres its children, so any vertical
  // nudge on .add-tab floats it above the tab label it belongs beside.
  const stripDelta = await evalJS(`(() => {
    const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
    const add = document.querySelector('#btn-add-tab');
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab');
    return add && tab ? +(mid(add) - mid(tab)).toFixed(2) : null;
  })()`);
  ok(stripDelta !== null && Math.abs(stripDelta) <= 1,
    `the tab-strip "+" aligns with the tabs (centre delta ${stripDelta}px)`, stripDelta);

  // 4. Type into the terminal → reaches the pty
  await evalJS(`window.kimiDesktop.writeInput(__kcd.state.activeTabId, 'hello kimi\\r')`);
  await waitFor(async () => {
    const buf = await evalJS(`(() => { const t = __kcd.state.tabs.get(__kcd.state.activeTabId).term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += (t.getLine(i) || {}).translateToString(true) + '\\n'; return s; })()`);
    return buf.includes('YOU-TYPED:hello kimi');
  }, 'typed input echoed back through PTY');
  ok(true, 'keyboard input reaches the kimi process (echo verified)');

  // 5. Kill the session → exit chip + tab marked ended
  await evalJS(`window.kimiDesktop.killSession(__kcd.state.activeTabId)`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.tab.exited').length`)) === 1, 'tab marked exited');
  ok(true, 'session kill marks tab as ended');

  // 6. Resume a previous session from history
  await evalJS(`document.querySelectorAll('.session-item')[0].click()`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.tab').length`)) >= 2, 'resume created new tab');
  await waitFor(async () => {
    const buf = await evalJS(`(() => { const ids = [...__kcd.state.tabs.keys()]; const t = __kcd.state.tabs.get(ids[ids.length-1]).term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += (t.getLine(i) || {}).translateToString(true) + '\\n'; return s; })()`);
    return buf.includes('--session');
  }, 'resume launches kimi --session <id>');
  ok(true, 'resuming a session runs kimi --session <id>');

  // 6b. A session with no recorded working directory must not open a dead tab:
  // kimi only resumes from the directory a session was created in, so the app
  // reports the problem instead of launching a process that errors out at once.
  const tabsBeforeUnresumable = await evalJS(`document.querySelectorAll('.tab').length`);
  await evalJS(`(async () => { await __kcd.startSession({ cwd: '', mode: 'default', resumeId: 'session-no-cwd', kind: 'resume', label: 'unresumable' }); return 1; })()`);
  await delay(600);
  ok((await evalJS(`document.querySelectorAll('.tab').length`)) === tabsBeforeUnresumable,
    'an unresumable session reports an error instead of opening a dead tab');

  // 7. Quick task (kimi -p)
  await evalJS(`document.querySelector('#btn-quick-task').click()`);
  await waitFor(async () => await evalJS(`!document.querySelector('#modal-quick-task').classList.contains('hidden')`),
    'quick-task modal open');
  await evalJS(`document.querySelector('#qt-prompt').value = 'Explain this repo'`);
  await evalJS(`document.querySelector('#qt-run').click()`);
  await waitFor(async () => {
    const buf = await evalJS(`(() => { const ids = [...__kcd.state.tabs.keys()]; const t = __kcd.state.tabs.get(ids[ids.length-1]).term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += (t.getLine(i) || {}).translateToString(true) + '\\n'; return s; })()`);
    return buf.includes('--prompt');
  }, 'quick task runs kimi --prompt');
  ok(true, 'quick task launches kimi -p "<prompt>"');

  // 8. Sign-in flow (kimi login) — now reached via Settings → Account tab
  await evalJS(`document.querySelector('#btn-settings').click()`);
  await waitFor(async () => await evalJS(`!document.querySelector('#modal-settings').classList.contains('hidden')`),
    'settings modal open (sign-in entry point)');

  // The settings tab strip: config.toml is the default tab and loads the file
  // on its own, without the removed "Edit config.toml…" button.
  ok(await evalJS(`document.querySelector('.settings-tab[data-tab="config"]').getAttribute('aria-selected') === 'true'`),
    'settings opens on the config.toml tab');
  await waitFor(async () => await evalJS(`document.querySelector('#cfg-content').value.length > 0`),
    'config.toml already loaded when the tab is shown');
  ok(true, 'config.toml editor is populated by default (no button needed)');
  ok(await evalJS(`!document.querySelector('#modal-config')`), 'standalone config modal is gone');

  await evalJS(`document.querySelector('.settings-tab[data-tab="account"]').click()`);
  ok(await evalJS(`!document.querySelector('.settings-panel[data-panel="account"]').classList.contains('hidden')`),
    'settings tabs switch panels');
  await evalJS(`document.querySelector('#st-signin').click()`);
  await waitFor(async () => await evalJS(`document.querySelector('#modal-settings').classList.contains('hidden')`),
    'settings modal closes before opening the sign-in tab');
  await waitFor(async () => {
    const buf = await evalJS(`(() => { const ids = [...__kcd.state.tabs.keys()]; const t = __kcd.state.tabs.get(ids[ids.length-1]).term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += (t.getLine(i) || {}).translateToString(true) + '\\n'; return s; })()`);
    return buf.includes('ABCD-EFGH');
  }, 'login tab shows device code');
  ok(true, 'in-app sign-in launches kimi login (device code visible)');

  // 9. Settings: theme picker (live preview + revert on close) and session filter
  await evalJS(`document.querySelector('#btn-settings').click()`);
  ok(await evalJS(`!document.querySelector('#modal-settings').classList.contains('hidden')`), 'settings modal opens');
  await evalJS(`document.querySelector('.settings-tab[data-tab="appearance"]').click()`);
  await evalJS(`(() => { const r = document.querySelector('input[name="st-theme"][value="light"]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  ok(await evalJS(`document.documentElement.dataset.theme === 'light'`), 'light theme previews live');
  await evalJS(`document.querySelector('#st-cancel').click()`);
  ok(await evalJS(`document.documentElement.dataset.theme === 'dark'`),
    'closing without saving reverts the theme preview');

  // 9b. The framed session panel, and the way back to the classic terminal.
  // Kimi's TUI paints no background of its own, so the pane's background *is*
  // the terminal's — asserted against the resolved CSS token, not a copy of it.
  const frameGeom = () => evalJS(`(() => {
    const host = document.querySelector('.terminal-host');
    const stage = document.querySelector('#terminal-stage');
    const cs = getComputedStyle(host);
    const h = host.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.style.color = 'var(--terminal-bg)';
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    const tab = __kcd.state.tabs.get(__kcd.state.activeTabId);
    return {
      radius: parseFloat(cs.borderTopLeftRadius),
      border: parseFloat(cs.borderTopWidth),
      insetLeft: Math.round(h.left - s.left),
      insetBottom: Math.round(s.bottom - h.bottom),
      paneBg: cs.backgroundColor,
      token,
      themeBg: tab ? tab.term.options.theme.background : null,
      themeToken: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim(),
    };
  })()`);
  const framed = await frameGeom();
  ok(framed.radius > 0 && framed.border > 0, 'the session is framed as a rounded panel', JSON.stringify(framed));
  ok(framed.insetLeft > 0 && framed.insetBottom > 0, 'the panel is inset from the window chrome', JSON.stringify(framed));
  ok(framed.insetLeft === 12, 'the panel lines up with the tab strip padding', `${framed.insetLeft}px`);
  ok(framed.paneBg === framed.token,
    'the pane paints with the --terminal-bg token (no seam around the CLI)', `${framed.paneBg} vs ${framed.token}`);
  ok(framed.themeBg === framed.themeToken,
    'xterm paints the same token, so frame and terminal cannot disagree', `${framed.themeBg} vs ${framed.themeToken}`);

  // The revert path, driven through the real Settings UI rather than an API.
  await evalJS(`document.querySelector('#btn-settings').click()`);
  await evalJS(`document.querySelector('.settings-tab[data-tab="appearance"]').click()`);
  await evalJS(`document.querySelector('#st-term-style').value = 'classic'`);
  await evalJS(`document.querySelector('#st-save').click()`);
  await waitFor(async () => await evalJS(`document.body.classList.contains('term-classic')`), 'classic style applied');
  const classic = await frameGeom();
  ok(classic.radius === 0 && classic.insetLeft === 0 && classic.insetBottom === 0,
    'Settings → Appearance restores the classic edge-to-edge terminal', JSON.stringify(classic));

  await evalJS(`document.querySelector('#btn-settings').click()`);
  await evalJS(`document.querySelector('.settings-tab[data-tab="appearance"]').click()`);
  await evalJS(`document.querySelector('#st-term-style').value = 'panel'`);
  await evalJS(`document.querySelector('#st-save').click()`);
  await waitFor(async () => !(await evalJS(`document.body.classList.contains('term-classic')`)), 'framed style restored');
  const backToFramed = await frameGeom();
  ok(backToFramed.radius > 0 && backToFramed.insetLeft === 12,
    'switching back to the framed panel works too', JSON.stringify(backToFramed));

  // 9a. Session row actions — only commands the kimi CLI actually exposes
  await evalJS(`__kcd.state.filter = ''; __kcd.renderSessionList()`);
  await evalJS(`document.querySelector('.session-item .si-more').click()`);
  ok(await evalJS(`!document.querySelector('#session-menu').classList.contains('hidden')`),
    'session actions menu opens from the row');
  const menuActions = await evalJS(`[...document.querySelectorAll('#session-menu button[data-action]')].map(b => b.dataset.action).join(',')`);
  ok(menuActions === 'resume,fork,export,copy-id',
    'menu offers the CLI-backed actions (resume/fork/export/copy id)', menuActions);
  ok(await evalJS(`![...document.querySelectorAll('#session-menu button[data-action]')].some(b => /^(delete|archive)$/.test(b.dataset.action))`),
    'no delete/archive action — not available on the kimi CLI');
  await evalJS(`__kcd.closeSessionMenu()`);
  ok(await evalJS(`document.querySelector('#session-menu').classList.contains('hidden')`),
    'session actions menu closes');

  await evalJS(`__kcd.state.filter = ''; __kcd.renderSessionList()`);
  await evalJS(`document.querySelector('#session-filter').value = 'webhook'; document.querySelector('#session-filter').dispatchEvent(new Event('input'))`);
  const filtered = await evalJS(`document.querySelectorAll('.session-item').length`);
  ok(filtered === 1, 'session search filter narrows history', `showing ${filtered}`);

  // 9b. Sidebar collapse toggle + drag-to-resize splitter
  await evalJS(`document.querySelector('#btn-toggle-sidebar').click()`);
  ok(await evalJS(`document.body.classList.contains('sidebar-collapsed')`),
    'title-bar icon collapses the sidebar completely');
  await evalJS(`document.querySelector('#btn-toggle-sidebar').click()`);
  ok(await evalJS(`!document.body.classList.contains('sidebar-collapsed')`),
    'title-bar icon reopens the sidebar');
  await evalJS(`__kcd.applySidebarWidth(430, true)`);
  ok(await evalJS(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().width) === 430`),
    'splitter resizes the session-history sidebar');
  await evalJS(`__kcd.applySidebarWidth(292, true)`);

  // 10. Close a tab
  const tabsBefore = await evalJS(`document.querySelectorAll('.tab').length`);
  await evalJS(`__kcd.closeTab(__kcd.state.tabs.get(__kcd.state.activeTabId))`);
  const tabsAfter = await evalJS(`document.querySelectorAll('.tab').length`);
  ok(tabsAfter === tabsBefore - 1, 'tab closes cleanly');

  // 11. Changing the session folder (KIMI_CODE_HOME) and pressing Apply must
  // reload the window: the app re-boots against the new home with no manual
  // restart. Driven last — the reload kills live sessions and rebuilds the UI.
  console.log('\n[e2e] settings: session folder change triggers reload');
  await evalJS(`document.querySelector('#btn-settings').click()`);
  await evalJS(`document.querySelector('.settings-tab[data-tab="cli"]').click()`);
  ok((await evalJS(`document.querySelector('#st-save').textContent.trim()`)) === 'Apply changes',
    'the settings action button is labelled "Apply changes"');
  await evalJS(`document.querySelector('#st-kimi-home').value = ${JSON.stringify(FAKE_HOME2)}`);
  // A marker in the current JS context proves the reload really happened:
  // after webContents.reload() the context is rebuilt and the marker is gone.
  await evalJS(`window.__KCD_E2E_GEN = 'before-reload'`);
  await evalJS(`document.querySelector('#st-save').click()`);
  await waitFor(async () =>
    (await evalJS(`window.__KCD_E2E_GEN === undefined && document.readyState === 'complete'`)),
    'the app reloads into a fresh context after Apply', 30000);
  await waitFor(async () =>
    (await evalJS(`document.querySelector('#status-home').textContent`)).includes(path.basename(FAKE_HOME2)),
    'status bar shows the new session folder', 60000);
  ok(true, 'Apply on a changed session folder reloads the app into the new home');
  ok((await evalJS(`document.querySelector('#modal-settings').classList.contains('hidden')`)),
    'the settings modal does not reopen after the reload');
  ok((await evalJS(`document.querySelectorAll('.session-item').length`)) === 0,
    'the empty second home lists no sessions (the reload really switched folders)');

  console.log(failures === 0 ? '\nE2E ALL PASSED ✔' : `\nE2E ${failures} FAILED ✘`);
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nE2E ERROR:', err.message);
    if (appStderrTail.trim()) console.error('\n--- last Electron stderr ---\n' + appStderrTail + '\n----------------------------');
    // Surfaces as a red annotation on the GitHub Actions run summary —
    // readable without admin log access.
    console.error(`::error::E2E failed: ${err.message}${appStderrTail.trim() ? ` :: ${appStderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  })
  .finally(() => {
    // On a GPU-less host (VM / container / RDP) the app relaunches itself with
    // safe flags and then exits, so the process above is already gone and the
    // real app is a DETACHED child that would keep the CDP socket — and this
    // script — alive forever. killStrayApps() (inside reap) sweeps it by path.
    reap();

    try { if (ws) ws.close(); } catch { /* already closed */ }

    // Let Node exit on its own so buffered stdout (test output) flushes fully —
    // a hard process.exit() here silently drops it on Windows. The unref'd
    // timer is a safety net for any handle that is still holding the loop open.
    process.exitCode = failures === 0 ? 0 : 1;
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  });