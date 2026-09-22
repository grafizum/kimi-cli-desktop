'use strict';

// Kimi Code Desktop — WEB EDITION (branch kimi-web-desktop)
//
// The whole app is the Kimi CLI's own web UI (`kimi web`) embedded in a
// desktop window. No tabs, no sidebar, no terminal pane, no in-app settings —
// Moonshot ships the chat interface, this shell just puts it on the desktop:
//   - spawns ONE `kimi web` server per app run (loopback + token),
//   - loads it in a sandboxed <webview> that fills the window,
//   - seeds the UI's color scheme + onboarding skip from the shell theme,
//   - restarts the server when the CLI is missing until it is installed.
// The CLI-edition app (tabs/TUI/history) lives on `main` and ships separately.

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const kimiDetect = require('./src/kimi-detect');
const settingsStore = require('./src/settings');
const webSession = require('./src/web-session');

// --- Startup self-check -----------------------------------------------------
// Two environments kill Chromium before the window exists, both with the same
// "GPU process isn't usable. Goodbye." exit:
//   1. the app files live on a UNC path (\\wsl.localhost\..., a network share),
//      where the sandbox cannot spawn child processes;
//   2. the machine has no usable GPU (headless/VMs, Windows RDP sessions).
// Both are detectable up front, so relaunch once with safe flags instead of
// dying silently.

const { spawn } = require('child_process');

const DEV_MODE = process.argv.includes('--dev');

function isUncPath(p) {
  return typeof p === 'string' && /^\\\\/.test(p);
}

function needsSandboxFallback() {
  return process.defaultApp
    ? isUncPath(__dirname)
    : isUncPath(process.execPath) || isUncPath(__dirname);
}

// Machines without a usable GPU need --disable-gpu or Chromium aborts.
function hasNoUsableGpu() {
  if (process.platform === 'win32') {
    return /^RDP/i.test(process.env.SESSIONNAME || '');
  }
  if (process.platform === 'linux') {
    try { return !fs.existsSync('/dev/dri'); } catch { return true; }
  }
  return false;
}

function fallbackFlags() {
  const flags = [];
  if (needsSandboxFallback() && !process.argv.includes('--no-sandbox')) flags.push('--no-sandbox');
  if (hasNoUsableGpu() && !process.argv.includes('--disable-gpu')) flags.push('--disable-gpu');
  return flags;
}

// In a packaged build __dirname points INSIDE app.asar — only a dev run can
// relaunch from it (there it is the project directory the child needs).
function relaunchCwd() {
  if (process.defaultApp) return __dirname;
  try { return app.getPath('userData'); } catch { return os.homedir(); }
}

// A portable build runs from a copy the NSIS stub extracts into %TEMP% and
// deletes on exit — relaunch the real launcher, not the vanishing copy.
function relaunchExecutable() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    if (portable && fs.existsSync(portable)) return portable;
  } catch { /* fall through to execPath */ }
  return process.execPath;
}

function relaunchWithFlags(flags) {
  const child = spawn(
    relaunchExecutable(),
    [...process.argv.slice(1), ...flags],
    { cwd: relaunchCwd(), detached: true, stdio: DEV_MODE ? 'inherit' : 'ignore' }
  );
  child.on('error', () => {
    dialog.showErrorBox(
      'Kimi Code Desktop could not start',
      'The app could not relaunch itself safely. Try starting it yourself with\n' +
      `the flags: ${flags.join(' ')}\n` +
      '(or move the project to a local drive if it lives on a network share).'
    );
  });
  child.unref();
  app.exit(0);
}

if (fallbackFlags().length) relaunchWithFlags(fallbackFlags());

// A window running against the e2e test double (fake kimi) must never be
// mistaken for the user's real app: the suites set KCD_TEST_HARNESS=1, and the
// window wears a [TEST RUN] title suffix while it is on.
const TEST_HARNESS = process.env.KCD_TEST_HARNESS === '1';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let settings = settingsStore.load(app.getPath('userData'));
let detection = { found: false, path: null, version: null, source: null, checked: [] };
let detectionPromise = null;
let detectionSettled = false;

// The one `kimi web` server this app hosts. A null here means "not running";
// restarting (CLI install, version change, server crash) replaces it.
let server = null;            // { id, promise, url, token, port, kill(), on() }
let serverStarting = false;   // guards against double-start races
let serverWanted = false;     // true once the renderer asked for the UI
let pendingRestart = false;   // a restart is queued (CLI changed / re-detected)

function userDataDir() {
  return app.getPath('userData');
}

function saveSettings() {
  settingsStore.save(userDataDir(), settings);
}

function currentEnv() {
  return { ...process.env };
}

// In WSL mode the CLI lives inside the distro; the server then also runs there
// (reaching Windows' 127.0.0.1 on WSL2) with the same session folder.
function isWslMode() {
  return detection.source === 'wsl' && !!detection.wsl;
}

// Run detection, sharing the in-flight promise so concurrent callers both get
// the real result instead of a stale one.
function runDetection() {
  if (detectionPromise) return detectionPromise;
  detectionPromise = (async () => {
    detection = await kimiDetect.detect({
      explicitPath: settings.kimiPath || undefined,
      env: currentEnv(),
    });
    detectionSettled = true;
    return detection;
  })();
  detectionPromise.finally(() => { detectionPromise = null; }).catch(() => {});
  return detectionPromise;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function serverStatus() {
  return {
    running: !!(server && server.url),
    url: server ? server.url : null,
    starting: serverStarting,
    kimi: detectionSettled ? detection : { ...detection, pending: true },
    wsl: isWslMode() ? detection.wsl : null,
    appVersion: app.getVersion(),
    platform: process.platform,
  };
}

// ---------------------------------------------------------------------------
// The kimi web server lifecycle
// ---------------------------------------------------------------------------

function stopServer(reason) {
  if (server) {
    try { server.kill(); } catch { /* already gone */ }
    server = null;
    if (reason) console.error(`[web] server stopped: ${reason}`);
  }
}

async function ensureServer() {
  if (serverStarting) return serverStatus();
  if (server && server.url) return serverStatus();

  serverStarting = true;
  send('web:status', serverStatus());
  try {
    if (!detectionSettled || !detection.found) await runDetection();

    // Retry detection in the background until the user installs the CLI —
    // the shell's only job is to come up the moment `kimi` appears.
    if (!detection.found || !detection.path) {
      serverStarting = false;
      send('web:status', serverStatus());
      scheduleCliWatch();
      return serverStatus();
    }

    const srv = webSession.startWebServer({
      id: webSession.newId(),
      binary: detection.path,
      args: webSession.buildWebArgs({ mode: settings.defaultMode || 'default' }),
      cwd: os.homedir(),
      env: currentEnv(),
      kimiCodeHome: settings.kimiCodeHome || '',
      buildSpawn: kimiDetect.buildSpawn,
      wsl: isWslMode() ? detection.wsl : null,
    });
    server = srv;
    const result = await srv.promise;
    serverStarting = false;

    if (!result.ok || !webSession.isAllowedWebUrl(result.url)) {
      const detail = String(result.log || '').split(/\r?\n/).filter(Boolean).slice(-1)[0]
        || 'the server did not report a URL';
      console.error(`[web] server failed: ${detail}`);
      stopServer('failed to start');
      send('web:status', { ...serverStatus(), lastError: detail });
      return serverStatus();
    }
    console.log(`[web] serving ${result.url}`);
    srv.on('exit', ({ code, signal }) => {
      // A crash while the window is open restarts the server (same CLI, new
      // port); the renderer repaints whatever state arrives.
      if (server === srv) {
        server = null;
        console.error(`[web] server exited (code=${code} signal=${signal})`);
        send('web:status', { ...serverStatus(), lastError: `the chat server exited (code ${code ?? '?'})` });
        if (serverWanted) ensureServer().catch(() => {});
      }
    });
    send('web:status', serverStatus());
    return serverStatus();
  } catch (err) {
    serverStarting = false;
    stopServer('start threw');
    send('web:status', { ...serverStatus(), lastError: String((err && err.message) || err) });
    return serverStatus();
  }
}

// While the CLI is missing, poll detection every few seconds (bounded, stops
// once found) so the app lights up right after `npm i -g kimi` — no restart.
let cliWatchTimer = null;
function scheduleCliWatch() {
  if (cliWatchTimer || detection.found) return;
  let tries = 0;
  const tick = async () => {
    cliWatchTimer = null;
    if (detection.found) return;
    await runDetection();
    if (detection.found) {
      send('kimi:detected', detection);
      if (serverWanted) ensureServer().catch(() => {});
      return;
    }
    if (++tries < 60) cliWatchTimer = setTimeout(tick, 5000);
  };
  cliWatchTimer = setTimeout(tick, 5000);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Webview security + guest preload — module scope so it is registered BEFORE
// any window (and therefore any host webContents) exists. will-attach-webview
// fires on the HOST webContents: registering this after new BrowserWindow(...)
// misses the event, and the guest preload silently never runs — the bug that
// left the embedded chat completely vanilla.
// ---------------------------------------------------------------------------
const dbgBoot = (line) => {
  try { fs.appendFileSync(path.join(__dirname, 'debug-boot.log'), new Date().toISOString() + ' ' + line + '\n'); }
  catch { /* diagnostics only */ }
};
app.on('web-contents-created', (_e, contents) => {
  dbgBoot('web-contents-created: type=' + contents.getType());
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    if (!webSession.isAllowedWebUrl(params.src)) {
      console.error('[webview] refused to attach a webview loading a non-loopback URL');
      _ev.preventDefault();
      return;
    }
    delete webPreferences.nodeIntegration;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.nodeIntegrationInSubFrames = false;
    // Runs inside the Kimi web UI BEFORE its scripts: seeds the UI's own
    // color-scheme from the shell theme and its onboarding skip, so the chat
    // opens in the user's theme, straight into the workspace.
    webPreferences.preload = path.join(__dirname, 'src', 'web-guest-preload.js');
    console.log('[webview] attaching:', params.src, '(guest preload set)');
    dbgBoot('webview attaching: ' + params.src + ' preload=' + webPreferences.preload);
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) openWithOs(url);
      return { action: 'deny' };
    });
  }
});

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: settings.theme === 'light' ? '#DFDFDF' : '#050505',
    title: TEST_HARNESS ? 'Kimi Code Desktop [TEST RUN]' : 'Kimi Code Desktop',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Custom in-app title bar on Windows/Linux; macOS keeps its traffic lights.
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require() to load only ipcRenderer
      // The app's whole face is the CLI's own web UI in a <webview>; every URL
      // it may load is validated in the will-attach-webview guard below.
      webviewTag: true,
    },
  });

  // The renderer embeds the CLI's own web UI in a single <webview>. Everything
  // it may load is decided in the module-scope web-contents-created handler
  // (registered BEFORE any window exists — see the block above
  // createWindow()): will-attach-webview fires on the HOST webContents, so
  // attaching that handler only after new BrowserWindow(...) misses the event
  // and the guest preload silently never runs. That ordering bug left the
  // embedded chat completely vanilla.
  mainWindow.on('maximize', () => send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => send('window:maximized-changed', false));

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] renderer process gone:', details.reason);
  });

  if (DEV_MODE) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('console-message', (...a) => {
      const ev = a[0];
      const message = ev && typeof ev.message === 'string' ? ev.message : a[2];
      console.log(`[renderer] ${message}`);
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (TEST_HARNESS) {
    const enforceTestTitle = () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle('Kimi Code Desktop [TEST RUN]');
    };
    mainWindow.on('page-title-updated', (e) => { e.preventDefault(); enforceTestTitle(); });
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openWithOs(url) {
  try { shell.openExternal(url); } catch { /* nothing sensible left to do */ }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  // Cheap bootstrap: settings + detection-so-far. Detection may still be
  // pending; the renderer follows up via kimi:detect / kimi:detected.
  ipcMain.handle('app:get-bootstrap', () => {
    if (!detectionSettled) runDetection();
    return {
      settings,
      kimi: detectionSettled ? detection : { ...detection, pending: true },
      wsl: isWslMode() ? detection.wsl : null,
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      testHarness: TEST_HARNESS,
    };
  });

  ipcMain.handle('kimi:detect', async (_e, force) => {
    if (detectionSettled && !force) return detection;
    return runDetection();
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_e, patch) => {
    const prevPath = settings.kimiPath;
    settings = { ...settings, ...settingsStore.sanitizePatch(patch) };
    saveSettings();
    // A changed kimi path (or cleared override) invalidates the running
    // server: restart it against the new CLI so the change is visible at once.
    if (settings.kimiPath !== prevPath && serverWanted) {
      pendingRestart = true;
    }
    return settings;
  });

  // Ask the guest preload (synchronous, before the Kimi web UI paints) so the
  // embedded UI starts in the SAME appearance the user picked for the shell.
  // Boot telemetry from the guest preload (sent synchronously during
  // document-start, before any of the web UI's own scripts). Written to a
  // file (not just stdout) so a dead enhancer is diagnosable even when the
  // app's console output is swallowed.
  ipcMain.on('webui:preload-boot', (e, info) => {
    try {
      console.log('[guest-preload]', JSON.stringify(info));
      fs.appendFileSync(path.join(__dirname, 'debug-boot.log'),
        new Date().toISOString() + ' guest-preload ' + JSON.stringify(info) + '\n');
    } catch { /* never crash over logging */ }
    e.returnValue = { ok: true };
  });

  ipcMain.on('webui:get-appearance', (e) => {
    e.returnValue = {
      colorScheme: settings.theme === 'light' ? 'light' : 'dark',
      tuiThinking: settings.tuiThinking !== false,
    };
  });

  // --- config.toml (models & providers) -------------------------------------
  // The kimi CLI reads <KIMI_CODE_HOME>/config.toml at startup; custom models
  // (OpenRouter, local llama via Ollama/llama.cpp/LM Studio, …) are added
  // there. In WSL mode the file lives in the distro, reached over the UNC
  // mount — same path Windows-side as the CLI edition used for its editor.
  function kimiConfigPaths() {
    if (isWslMode()) {
      const linuxHome = (settings.kimiCodeHome || detection.wsl.kimiCodeHome
        || `${detection.wsl.home}/.kimi-code`).replace(/\/+$/, '');
      const unc = kimiDetect.linuxToWindowsUnc(detection.wsl.distro, linuxHome);
      return {
        fsPath: unc ? path.join(unc, 'config.toml') : '',
        displayPath: `${linuxHome}/config.toml`,
        viaWsl: true,
      };
    }
    const home = settings.kimiCodeHome || process.env.KIMI_CODE_HOME
      || path.join(os.homedir(), '.kimi-code');
    return { fsPath: path.join(home, 'config.toml'), displayPath: path.join(home, 'config.toml'), viaWsl: false };
  }

  ipcMain.handle('config:read', async () => {
    const p = kimiConfigPaths();
    let content = '';
    try { content = fs.readFileSync(p.fsPath, 'utf8'); } catch { /* first run — no file yet */ }
    return { content, path: p.displayPath, exists: content.length > 0, viaWsl: p.viaWsl };
  });

  ipcMain.handle('config:write', async (_e, content) => {
    if (typeof content !== 'string' || content.length > 1_000_000) {
      return { ok: false, error: 'invalid config content' };
    }
    const p = kimiConfigPaths();
    if (!p.fsPath) return { ok: false, error: 'config path unavailable in this setup' };
    try {
      fs.mkdirSync(path.dirname(p.fsPath), { recursive: true });
      const tmp = `${p.fsPath}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, p.fsPath);
      return { ok: true, path: p.displayPath, viaWsl: p.viaWsl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // The shell's core: report the server state and, if wanted but absent,
  // (re)start it. The renderer calls this on boot, on CLI detection, and
  // whenever the user hits retry.
  ipcMain.handle('web:ensure', async () => {
    serverWanted = true;
    if (pendingRestart) {
      pendingRestart = false;
      stopServer('settings changed');
    }
    return ensureServer();
  });

  ipcMain.handle('web:status', () => serverStatus());

  // Manual "restart the chat backend" (crash loop breaker, CLI update).
  ipcMain.handle('web:restart', async () => {
    stopServer('restarted by user');
    serverWanted = true;
    return ensureServer();
  });

  ipcMain.handle('kimi:set-path', async (_e, p) => {
    settings.kimiPath = typeof p === 'string' ? p.trim() : '';
    saveSettings();
    const det = await runDetection();
    if (serverWanted) {
      stopServer('kimi path changed');
      return { ...det, ...(await ensureServer()) };
    }
    return det;
  });

  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('window:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));

  ipcMain.handle('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) openWithOs(url);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance lock: two windows would race for one loopback port range and
// duplicate every server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    runDetection().then((det) => send('kimi:detected', det)).catch(() => {});
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopServer('app closing');
    app.quit();
  });
}
