'use strict';

// Smoke test for the WEB EDITION's pure-Node pieces:
//   - src/kimi-detect.js  (CLI discovery, unchanged from the CLI edition)
//   - src/settings.js     (trimmed settings store)
//   - src/web-session.js  (the `kimi web` server contract)
//   - main.js / renderer  (shape checks the runtime depends on)
// Dependency-free on purpose — run with: node scripts/smoke-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const settingsStore = require('../src/settings');
const detect = require('../src/kimi-detect');
const webSession = require('../src/web-session');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `kcdweb-${name}-`));
}

// ---------------------------------------------------------------------------
// 1. Settings store (web edition shape)
// ---------------------------------------------------------------------------
console.log('\n[settings] the web edition store');

ok(settingsStore.DEFAULTS.theme === 'dark', 'defaults: dark theme');
ok(settingsStore.DEFAULTS.defaultMode === 'default', 'defaults: default permission mode');
ok(!('fontSize' in settingsStore.DEFAULTS) && !('scrollback' in settingsStore.DEFAULTS),
  'defaults: no terminal-era settings remain');
ok(!('sessionView' in settingsStore.DEFAULTS) && !('sidebarWidth' in settingsStore.DEFAULTS),
  'defaults: no tabs/sidebar-era settings remain');

const sdir = tmpRoot('settings');
const s1 = settingsStore.load(sdir);
ok(s1.kimiPath === '' && s1.kimiCodeHome === '', 'load: empty file → defaults');

const s2 = settingsStore.sanitizePatch({ kimiPath: ' C:\\x\\kimi.exe ', theme: 'light', bogus: 'x' });
ok(s2.kimiPath === 'C:\\x\\kimi.exe', 'sanitize: paths are trimmed');
ok(s2.theme === 'light', 'sanitize: theme passes through');
ok(!('bogus' in s2), 'sanitize: unknown keys are dropped');

settingsStore.save(sdir, { ...s1, theme: 'light' });
ok(JSON.parse(fs.readFileSync(path.join(sdir, 'settings.json'), 'utf8')).theme === 'light',
  'save: round-trips through settings.json');

// ---------------------------------------------------------------------------
// 2. kimi-detect (contract the shell depends on)
// ---------------------------------------------------------------------------
console.log('\n[kimi-detect] discovery contract');

ok(typeof detect.detect === 'function' && typeof detect.buildSpawn === 'function',
  'exports: detect + buildSpawn exist (main.js calls both)');
ok(typeof detect.commonCandidates === 'function', 'exports: commonCandidates exists');
ok(detect.isTestDouble(path.join('x', 'test-fixtures', 'bin', 'kimi'), ''),
  'the e2e fake binary is refused outside a test run');
ok(!detect.isTestDouble('C:\\Users\\me\\AppData\\kimi.exe', 'kimi 2.0.2'),
  'a real binary is accepted');

// ---------------------------------------------------------------------------
// 3. web-session — the server contract that IS the app
// ---------------------------------------------------------------------------
console.log('\n[web-session] the embedded Kimi Web contract');

ok(JSON.stringify(webSession.buildWebArgs({})) === JSON.stringify(['web', '--no-open']),
  'web args: plain server start is `web --no-open`');
ok(JSON.stringify(webSession.buildWebArgs({ mode: 'yolo' }))
    === JSON.stringify(['--yolo', 'web', '--no-open']),
  'web args: the permission mode maps to the root --yolo flag');
ok(JSON.stringify(webSession.buildWebArgs({ resumeId: 'abc' }))
    === JSON.stringify(['--session', 'abc', 'web', '--no-open']),
  'web args: --session goes BEFORE the web subcommand (root options)');

const banner = [
  '  ▐█▛█▛█▌  Kimi server ready  2.0.2',
  '  Local:    http://127.0.0.1:58627/#token=JUdXb5eIGip7b-yks7wO-vSeaU',
  '  Token:    JUdXb5eIGip7b-yks7wO-vSeaU',
].join('\n');
const parsed = webSession.parseServerUrl(banner);
ok(!!parsed && parsed.url === 'http://127.0.0.1:58627/#token=JUdXb5eIGip7b-yks7wO-vSeaU',
  'banner: the Local URL is extracted from the real server output shape', JSON.stringify(parsed));
ok(!!parsed && parsed.token === 'JUdXb5eIGip7b-yks7wO-vSeaU', 'banner: the token is parsed');
ok(!!parsed && parsed.port === '58627', 'banner: the port is parsed');
ok(webSession.parseServerUrl('Local:    http://127.0.0.1:58627/') === null,
  'banner: a URL without a token is not accepted');
ok(webSession.isServerReadyLine('Kimi server ready 2.0.2'), 'banner: the ready line is recognised');

// The webview URL carries the UI's official onboarding skip (?kimi_onboarded=1)
// so the chat opens straight into the workspace — no first-run introduction.
ok(webSession.withOnboardingSkip('http://127.0.0.1:58627/#token=abc123')
  === 'http://127.0.0.1:58627/?kimi_onboarded=1#token=abc123',
  'onboarding skip: the query lands BEFORE the #token fragment');
ok(webSession.isAllowedWebUrl(webSession.withOnboardingSkip('http://127.0.0.1:58627/#token=x')),
  'onboarding skip: the decorated URL still passes the webview guard');

ok(webSession.isAllowedWebUrl('http://127.0.0.1:58627/#token=x'), 'url guard: loopback + token passes');
ok(webSession.isAllowedWebUrl('http://localhost:58627/#token=x'), 'url guard: localhost passes');
ok(!webSession.isAllowedWebUrl('http://10.0.0.5:58627/#token=x'), 'url guard: LAN addresses are refused');
ok(!webSession.isAllowedWebUrl('https://evil.example/#token=x'), 'url guard: remote hosts are refused');
ok(!webSession.isAllowedWebUrl('http://127.0.0.1:58627/'), 'url guard: loopback WITHOUT a token is refused');
ok(!webSession.isAllowedWebUrl('file:///etc/passwd'), 'url guard: non-http schemes are refused');
ok(!webSession.isAllowedWebUrl('not a url'), 'url guard: garbage is refused');

// ---------------------------------------------------------------------------
// 4. Guest preload — the theme/onboarding seed
// ---------------------------------------------------------------------------
console.log('\n[guest preload] the chat theme seed');

const guest = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-guest-preload.js'), 'utf8');
ok(guest.includes('kimi-web.color-scheme') && guest.includes('kimi-web.onboarded'),
  'guest preload: seeds color-scheme + onboarded');
ok(guest.includes("ipcRenderer.sendSync('webui:get-appearance')"),
  'guest preload: reads the appearance over the one allowed bridge call');
ok(!/require\(['"](?!electron)['"][^'"]+['"]\)/.test(guest),
  'guest preload: requires nothing but the electron bridge');
ok(!/nodeIntegration|contextBridge|[^a-z]fs\./.test(guest),
  'guest preload: no node access beyond the bridge');

// ---------------------------------------------------------------------------
// 5. main.js — the web edition shape
// ---------------------------------------------------------------------------
console.log('\n[main] the web edition main process');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(mainSrc.includes("require('./src/web-session')"), 'main: drives the web-session module');
ok(!mainSrc.includes("require('./src/pty')"), 'main: no PTY machinery in the web edition');
ok(!mainSrc.includes("require('./src/sessions')"), 'main: no session-history scanning in the web edition');
ok(mainSrc.includes('will-attach-webview') && mainSrc.includes('isAllowedWebUrl'),
  'main: every webview URL is validated in the main process');
ok(mainSrc.includes('web-guest-preload.js'), 'main: the guest preload is attached by the main process');
ok(mainSrc.includes('scheduleCliWatch'), 'main: retries detection while the CLI is missing');
ok(mainSrc.includes('requestSingleInstanceLock'), 'main: single-instance lock (no port races)');
ok(mainSrc.includes('needsSandboxFallback') && mainSrc.includes('hasNoUsableGpu'),
  'main: the UNC/GPU self-check survived the rewrite (launches from network shares)');

// ---------------------------------------------------------------------------
// 6. Renderer — one webview, no tabs, no xterm
// ---------------------------------------------------------------------------
console.log('\n[renderer] the web edition shell');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
ok((htmlNoComments.match(/<webview/g) || []).length === 1, 'index: exactly one webview — the whole app');
ok(!html.includes('xterm'), 'index: no terminal in the web edition');
ok(!/id="sidebar"|id="tabs"|id="modal-settings"/.test(html),
  'index: no sidebar, tab strip or settings modal');
ok(html.includes('no-kimi') && html.includes('starting') && html.includes('error-state'),
  'index: the three lifecycle cards exist');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
ok(appSrc.includes('ensureWeb') && appSrc.includes('onWebStatus'),
  'app: drives the server lifecycle via the bridge');
ok(appSrc.includes('ResizeObserver') && appSrc.includes('syncChatSize'),
  'app: the webview is pixel-synced (no black-rectangle bug)');
ok(!appSrc.includes('xterm') && !appSrc.includes('new Tab('),
  'app: no terminal or tab machinery in the web edition');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
ok(css.includes('.webview-live') && !/display:\s*none[^}]*(#chat|webview)/.test(css),
  'css: the webview stays laid out (visibility, never display:none)');
ok(css.includes("data-theme='light'"), 'css: light theme tokens exist');
// A JS artifact at the top of the CSS (once shipped as "'use strict';") glued
// itself onto the :root selector, silently killing EVERY dark-theme token -
// black icons/text on the near-black panel. Guard both directions.
ok(/:\s*root\s*\{/.test(css), 'css: the :root token block parses');
ok(!css.includes("'use strict'") && !/\bfunction\b/.test(css), 'css: no JavaScript artifacts in the stylesheet');

// preload bridge surface
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
ok(preloadSrc.includes("exposeInMainWorld('kimiDesktop'"), 'preload: exposes the kimiDesktop bridge');
ok(preloadSrc.includes('ensureWeb') && preloadSrc.includes('restartWeb'),
  'preload: the web lifecycle is bridged');
ok(!preloadSrc.includes('writeInput') && !preloadSrc.includes('listSessions'),
  'preload: no PTY/history bridges remain');

// ---------------------------------------------------------------------------
// 7. Packaging — a separate edition with separate artifacts
// ---------------------------------------------------------------------------
console.log('\n[package] the web edition identity');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
ok(pkg.name === 'kimi-cli-desktop-web', 'package: the web edition has its own package name');
ok(/^1\.0\.0-web\./.test(pkg.version), 'package: the version line is web-flavoured', pkg.version);
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  'package: no runtime deps (xterm/node-pty are gone)');
ok(JSON.stringify(pkg.build.win.target).includes('nsis'), 'package: Windows NSIS + portable targets kept');
ok(pkg.build.portable.artifactName && pkg.build.nsis.artifactName
  && pkg.build.portable.artifactName.includes('Web-') && pkg.build.nsis.artifactName.includes('Web-'),
  'package: Windows artifacts are Web-suffixed (never collides with the CLI edition)');

const release = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
ok(release.includes('web-v*'), 'release workflow: triggers on web-v* tags');
ok(release.includes("startsWith(github.ref_name, 'web-')"), 'release workflow: names the Web edition release');

const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
ok(ci.includes('kimi-web-desktop'), 'ci workflow: runs on the web edition branch');

// ---------------------------------------------------------------------------
// 8. Fixture CLI — the `web` subcommand mimic the e2e/test windows rely on
// ---------------------------------------------------------------------------
console.log('\n[fixture] the fake kimi binary');

const fixturePath = path.join(__dirname, '..', 'test-fixtures', 'bin', 'kimi');
const fixture = fs.readFileSync(fixturePath, 'utf8');
ok(fixture.includes('#token='), 'fixture: prints the banner shape the app parses');
ok(fixture.includes('nc -l'), 'fixture: serves the port so the webview load is honest');

let fakeVersion = '';
try {
  fakeVersion = execFileSync(fixturePath, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
} catch { /* POSIX sh on Windows — checked implicitly by the suites on CI */ }
ok(fakeVersion === 'kimi 9.9.9-test' || process.platform === 'win32',
  'fixture: --version returns a version-like token', fakeVersion || '(skipped on Windows)');

console.log(failures === 0 ? '\nALL CHECKS PASSED ✔' : `\n${failures} CHECK(S) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
