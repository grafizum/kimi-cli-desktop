'use strict';

// E2E test against the REAL app and the REAL kimi installed inside WSL.
// Verifies: WSL detection, real session history (read via UNC), and an
// interactive kimi session booting through wsl.exe. No prompt is sent, so no
// API calls are made. Requires WSL + kimi inside a distro.
// Run with: npm run e2e:wsl

const { spawn, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const PORT = 9444;

let failures = 0;
function ok(cond, name, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', () => {});
app.stderr.on('data', () => {});

let ws = null;
let msgId = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
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
  if (r.exceptionDetails) throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function waitFor(fn, what, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep waiting */ }
    await delay(400);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  }, 'app page target', 60000);
  await connect(target.webSocketDebuggerUrl);

  // Slow disks (and WSL/network mounts) can keep the page loading for a while —
  // wait for a fully parsed DOM before evaluating anything.
  await waitFor(async () => (await evalJS('document.readyState')) === 'complete',
    'page load complete', 60000);

  console.log('\n[e2e:wsl] app booted with REAL environment — driving over CDP\n');

  // 1. Detection: WSL kimi with version
  await waitFor(async () =>
    (await evalJS(`document.querySelector('#kimi-status-text').textContent`)).includes('WSL'),
    'kimi status shows WSL marker');
  const status = await evalJS(`document.querySelector('#kimi-status-text').textContent`);
  ok(/WSL/.test(status), 'kimi detected inside WSL with version', status);
  const statusBar = await evalJS(`document.querySelector('#status-kimi').textContent`);
  ok(/kimi/.test(statusBar) && /WSL/.test(statusBar) && /\.kimi-code/.test(statusBar),
    'status bar shows kimi path + WSL', statusBar.slice(0, 120));
  const homeShown = await evalJS(`document.querySelector('#status-home').textContent`);
  ok(homeShown.includes('.kimi-code'), 'status bar shows kimi data dir', homeShown.slice(0, 120));

  // 2. Real session history from the WSL ~/.kimi-code
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.session-item').length`)) > 0,
    'real sessions listed');
  const count = await evalJS(`document.querySelectorAll('.session-item').length`);
  ok(count > 0, `real session history rendered (${count} sessions)`);
  const firstMeta = await evalJS(`document.querySelector('.session-item .si-meta').textContent`);
  console.log('    sample row:', firstMeta.slice(0, 100));

  // 3. New interactive session boots the real kimi TUI through WSL
  await evalJS(`document.querySelector('#btn-new-session').click()`);
  await waitFor(async () => await evalJS(`!document.querySelector('#modal-new-session').classList.contains('hidden')`),
    'new-session modal open');
  const cwdField = await evalJS(`({ readonly: document.querySelector('#ns-cwd').hasAttribute('readonly'), placeholder: document.querySelector('#ns-cwd').placeholder, label: document.querySelector('#ns-cwd-label').textContent })`);
  ok(cwdField.readonly === false, 'cwd field is editable in WSL mode', JSON.stringify(cwdField));
  ok(cwdField.placeholder.includes('/home/'), 'cwd placeholder is a WSL home path', cwdField.placeholder);
  ok(cwdField.label.includes('WSL'), 'cwd label explains WSL path', cwdField.label);
  const browseHidden = await evalJS(`document.querySelector('#ns-browse').classList.contains('hidden')`);
  ok(browseHidden, 'Windows folder browse hidden in WSL mode');

  await evalJS(`document.querySelector('#ns-start').click()`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.tab').length`)) >= 1, 'session tab created');
  await waitFor(async () => {
    const line = await evalJS(`__kcd.state.activeTabId ? (__kcd.state.tabs.get(__kcd.state.activeTabId).term.buffer.active.getLine(0) || {}).translateToString(true) : ''`);
    return String(line).length > 0;
  }, 'terminal received output from WSL kimi');
  const bufLen = await evalJS(`(() => { const t = __kcd.state.tabs.get(__kcd.state.activeTabId).term.buffer.active; let s = ''; for (let i = 0; i < t.length; i++) s += (t.getLine(i) || {}).translateToString(true) + '\\n'; return s.length; })()`);
  ok(bufLen > 0, `real kimi TUI streaming into the app (${bufLen} chars in buffer)`);

  // 4. Close it (no prompt sent — no API call)
  await evalJS(`window.kimiDesktop.killSession(__kcd.state.activeTabId)`);
  await waitFor(async () => (await evalJS(`document.querySelectorAll('.tab.exited').length`)) >= 1, 'tab marked exited');
  ok(true, 'session closed cleanly');

  console.log(failures === 0 ? '\nE2E:WSL ALL PASSED ✔' : `\nE2E:WSL ${failures} FAILED ✘`);
}

main()
  .catch(async (err) => {
    failures += 1;
    console.error('\nE2E:WSL ERROR:', err.message);
    try {
      const diag = await evalJS(`JSON.stringify({ sessions: __kcd.state.sessions.length, home: __kcd.state.kimiHome, kimiFound: !!__kcd.state.kimi, source: __kcd.state.kimi && __kcd.state.kimi.source })`);
      console.error('E2E:WSL DIAG:', diag);
    } catch { /* renderer gone */ }
  })
  .finally(() => {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
      else app.kill('SIGTERM');
    } catch { /* already gone */ }

    // Let Node exit on its own so buffered stdout (test output) flushes fully —
    // a hard process.exit() here silently drops it on Windows.
    process.exitCode = failures === 0 ? 0 : 1;
  });