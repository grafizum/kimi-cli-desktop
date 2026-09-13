'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const kimiDetect = require('./src/kimi-detect');
const sessions = require('./src/sessions');
const settingsStore = require('./src/settings');
const ptyManager = require('./src/pty');

// --- Startup self-check -----------------------------------------------------
// Two environments kill Chromium before the window exists, both with the same
// "GPU process isn't usable. Goodbye." exit:
//   1. the app files live on a UNC path (\\wsl.localhost\..., a network share),
//      where the sandbox cannot spawn child processes;
//   2. the machine has no usable GPU (headless/VMs, Windows RDP sessions).
// Both are detectable up front, so relaunch once with safe flags instead of
// dying silently.

const { spawn } = require('child_process');

// `npm run dev` runs the app straight from source — no packaging, no installed
// build to keep in sync. It turns on the affordances a shipped build leaves out:
// detached DevTools and renderer console/error output forwarded to the terminal
// that launched it.
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
    // Windows marks Remote Desktop sessions in SESSIONNAME ("RDP-Tcp#12").
    return /^RDP/i.test(process.env.SESSIONNAME || '');
  }
  if (process.platform === 'linux') {
    // A usable GPU exposes a DRI device node; GPU-less VMs and containers don't.
    try { return !fs.existsSync('/dev/dri'); } catch { return true; }
  }
  return false;
}

// Flags this machine needs beyond the defaults — empty when nothing is wrong.
function fallbackFlags() {
  const flags = [];
  if (needsSandboxFallback() && !process.argv.includes('--no-sandbox')) flags.push('--no-sandbox');
  if (hasNoUsableGpu() && !process.argv.includes('--disable-gpu')) flags.push('--disable-gpu');
  return flags;
}

// In a packaged build __dirname points INSIDE app.asar. Electron's patched fs
// reports that as a directory, but the OS refuses it as a working directory
// (spawn died with ENOTDIR), so the relaunch below failed on exactly the
// installs that need it. Only a dev run can use __dirname — and there it is the
// project directory, which the child needs so its '.' argument resolves.
function relaunchCwd() {
  if (process.defaultApp) return __dirname;
  try { return app.getPath('userData'); } catch { return os.homedir(); }
}

// A portable build runs from a copy that the NSIS stub extracts into %TEMP%
// and deletes the moment this process exits — so relaunching process.execPath
// left the child pointing at a file that was about to vanish, and the app died
// on exactly the machines that need the fallback (RDP, network shares).
// electron-builder tells a portable app where its real launcher lives.
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
    // Nothing more we can do — surface why the app will not start.
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

let mainWindow = null;
// A window running against the e2e test double (fake kimi) must never be
// mistaken for the user's real app: the suites set KCD_TEST_HARNESS=1, and the
// UI wears a yellow TEST RUN banner + a [TEST RUN] title suffix while it is on.
// A leftover, interrupted test window is then instantly identifiable.
const TEST_HARNESS = process.env.KCD_TEST_HARNESS === '1';
let settings = settingsStore.load(app.getPath('userData'));
let detection = { found: false, path: null, version: null, source: null, checked: [] };
let detectionPromise = null;
// Whether `detection` holds a real, finished result (as opposed to the empty
// placeholder above). Keeps app:get-bootstrap from ever blocking the window.
let detectionSettled = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userDataDir() {
  return app.getPath('userData');
}

function saveSettings() {
  settingsStore.save(userDataDir(), settings);
}

function isWslMode() {
  return detection.source === 'wsl' && !!detection.wsl;
}

// Linux-side KIMI_CODE_HOME (inside WSL when in WSL mode).
function linuxKimiCodeHome() {
  if (settings.kimiCodeHome) return settings.kimiCodeHome;
  if (isWslMode()) return detection.wsl.kimiCodeHome || `${detection.wsl.home}/.kimi-code`;
  return process.env.KIMI_CODE_HOME || '';
}

// Windows-readable KIMI_CODE_HOME for scanning session history.
function scanKimiCodeHome() {
  if (settings.kimiCodeHome) {
    if (isWslMode()) {
      return kimiDetect.linuxToWindowsUnc(detection.wsl.distro, settings.kimiCodeHome) || '';
    }
    return settings.kimiCodeHome;
  }
  if (isWslMode()) return detection.wsl.kimiCodeHomeWindows || '';
  return process.env.KIMI_CODE_HOME || sessions.kimiHome(currentEnv());
}

// Resolve the Kimi CLI config.toml. On WSL the file lives in the Linux home,
// which Windows can still read/write through the \\wsl.localhost UNC mount.
function kimiConfigPaths() {
  if (isWslMode()) {
    const linuxHome = (linuxKimiCodeHome() || `${detection.wsl.home}/.kimi-code`).replace(/\/+$/, '');
    const unc = kimiDetect.linuxToWindowsUnc(detection.wsl.distro, linuxHome);
    return {
      windowsPath: unc ? path.join(unc, 'config.toml') : '',
      displayPath: `${linuxHome}/config.toml`,
      viaWsl: true,
    };
  }
  const home = settings.kimiCodeHome || sessions.kimiHome(currentEnv());
  return { windowsPath: path.join(home, 'config.toml'), displayPath: path.join(home, 'config.toml'), viaWsl: false };
}

function isWindowsPath(p) {
  return typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p);
}

// A Windows path saved back when kimi ran natively can't be used inside the
// distro, so fall back to the distro's home directory in that case.
function effectiveCwd() {
  if (isWslMode()) {
    return settings.defaultCwd && !isWindowsPath(settings.defaultCwd)
      ? settings.defaultCwd
      : detection.wsl.home;
  }
  return settings.defaultCwd || os.homedir();
}

function currentEnv() {
  return { ...process.env };
}

// Single-quote for `bash -lc`, escaping embedded single quotes.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// A Windows save-dialog path has to become a Linux path before it is handed to
// a command running inside WSL ('C:\\Users\\me\\a.zip' -> '/mnt/c/Users/me/a.zip').
function wslSafePath(p) {
  if (!isWslMode() || !isWindowsPath(p)) return p;
  const drive = p[0].toLowerCase();
  return `/mnt/${drive}/${p.slice(2).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

// Run `kimi <args>` to completion (no PTY) and capture its output. Used for the
// non-interactive CLI subcommands the app exposes — export, and anything else
// that just writes a file and exits.
async function runKimiCli(args = [], timeout = 180000) {
  if (!detection.found || !detection.path) {
    const det = await runDetection();
    if (!det.found) return { code: -1, stdout: '', stderr: 'kimi-not-found' };
  }
  if (isWslMode()) {
    const cmd = `exec ${shellQuote(detection.path)} ${args.map(shellQuote).join(' ')}`;
    return kimiDetect.wslExec(detection.wsl.distro, cmd, currentEnv(), timeout);
  }
  const { file, args: fileArgs } = kimiDetect.buildSpawn(detection.path, args);
  return kimiDetect.run(file, fileArgs, { env: currentEnv(), timeout });
}

// Poll until a path exists (used for the WSL UNC mount). Resolves false on timeout.
async function waitForPath(p, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(p)) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Run detection, sharing the in-flight promise so concurrent callers (startup
// + renderer bootstrap) both get the real result instead of a stale one.
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

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#050505',
    title: 'Kimi Code Desktop',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Custom in-app title bar on Windows/Linux; macOS keeps its traffic lights.
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    autoHideMenuBar: true,
    // Marked in the native window title too (Chrome may strip the suffix from
    // the in-page title, but the taskbar keeps it).
    title: TEST_HARNESS ? 'Kimi Code Desktop [TEST RUN]' : 'Kimi Code Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require() to load only ipcRenderer
    },
  });

  const emitMaximized = () => send('window:maximized-changed', !!(mainWindow && mainWindow.isMaximized()));
  mainWindow.on('maximize', emitMaximized);
  mainWindow.on('unmaximize', emitMaximized);

  // Crash-visible logging: a renderer that dies must never fail silently.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] renderer process gone:', details.reason);
  });

  if (DEV_MODE) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Forward the renderer's console (both Electron's legacy positional args and
    // the newer single-event form) so errors show up in the launching terminal.
    mainWindow.webContents.on('console-message', (...a) => {
      const ev = a[0];
      const message = ev && typeof ev.message === 'string' ? ev.message : a[2];
      const line = ev && typeof ev.lineNumber === 'number' ? ev.lineNumber : a[3];
      const source = ev && ev.sourceId ? ev.sourceId : a[4];
      console.log(`[renderer] ${message}${source ? ` (${source}:${line})` : ''}`);
    });
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The renderer watches document.title for the suffix (its own <title> would
  // overwrite it once the page loads).
  if (TEST_HARNESS) {
    const enforceTestTitle = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.getTitle().includes('[TEST RUN]')) {
        mainWindow.setTitle('Kimi Code Desktop [TEST RUN]');
      }
    };
    mainWindow.on('page-title-updated', (e) => {
      e.preventDefault();
      enforceTestTitle();
    });
    enforceTestTitle();
  }

  // Show the window as soon as the page has painted — with hard fallbacks so
  // a slow or failed load can never leave the user with an invisible app.
  const showWindow = () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    } catch (_) { /* ignore */ }
  };
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.webContents.once('did-finish-load', () => setTimeout(showWindow, 300));
  mainWindow.webContents.once('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] page failed to load:', code, desc, url);
    showWindow();
  });
  // Absolute last resort: even a wedged load shows a window after 5 seconds.
  setTimeout(showWindow, 5000);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('focus', () => send('app:window-focused'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) openWithOs(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Menu — terminal-friendly: Ctrl+C is left to the terminal, copy/paste are
// Ctrl+Shift+C / Ctrl+Shift+V (macOS keeps Cmd+C/Cmd+V).
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const copyPasteAccel = isMac ? ['CmdOrCtrl+C', 'CmdOrCtrl+V'] : ['Ctrl+Shift+C', 'Ctrl+Shift+V'];

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        // Shortcuts are handled in the renderer (terminal input must keep
        // Ctrl+T / Ctrl+W etc.), so menu items carry no accelerators.
        { label: 'New Session… (Ctrl+T)', click: () => send('menu:action', 'new-session') },
        { label: 'New Quick Task… (Ctrl+Shift+T)', click: () => send('menu:action', 'new-quick-task') },
        { type: 'separator' },
        { label: 'Edit Kimi config.toml…', click: () => send('menu:action', 'open-config') },
        { type: 'separator' },
        { label: 'Close Session Tab (Ctrl+W)', click: () => send('menu:action', 'close-tab') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: `Copy Selection (${copyPasteAccel[0]})`, click: () => send('menu:action', 'copy') },
        { label: `Paste (${copyPasteAccel[1]})`, click: () => send('menu:action', 'paste') },
        { type: 'separator' },
        { label: 'Find in Terminal… (Ctrl+Shift+F)', click: () => send('menu:action', 'find') },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Increase Terminal Font (Ctrl+=)', click: () => send('menu:action', 'font-up') },
        { label: 'Decrease Terminal Font (Ctrl+-)', click: () => send('menu:action', 'font-down') },
        { label: 'Reset Terminal Font (Ctrl+0)', click: () => send('menu:action', 'font-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'Next Session Tab (Ctrl+Tab)', click: () => send('menu:action', 'next-tab') },
        { label: 'Previous Session Tab (Ctrl+Shift+Tab)', click: () => send('menu:action', 'prev-tab') },
        { type: 'separator' },
        { label: 'Sign In to Kimi…', click: () => send('menu:action', 'login') },
        { label: 'Re-detect Kimi CLI', click: () => send('menu:action', 're-detect') },
        { label: 'Refresh Session History', click: () => send('menu:action', 'refresh-sessions') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Kimi Code Docs', click: () => openExternalOrReport('https://www.kimi.com/code/docs/en/kimi-code-cli/') },
        { label: 'Kimi CLI on GitHub', click: () => openExternalOrReport('https://github.com/MoonshotAI/kimi-cli') },
        { label: 'Install Kimi Code CLI', click: () => openExternalOrReport('https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html') },
        { type: 'separator' },
        { role: 'about' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Opening links and folders
// ---------------------------------------------------------------------------
// Electron routes shell.openExternal / shell.openPath through xdg-open on Linux.
// That silently does nothing when xdg-open is missing, shadowed by a broken shim
// earlier on PATH (common on WSL), or has no browser / file manager registered.
// The old code ignored the result, so "Installation docs", "Open sessions
// folder" and the sign-in browser hand-off looked wired but were dead. Run the
// opener ourselves so a failure becomes a real result we can report.
function spawnOpener(file, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let out = '';
    const collect = (d) => { if (out.length < 2000) out += d.toString(); };
    try { child.stdout.on('data', collect); child.stderr.on('data', collect); } catch { /* no pipes */ }

    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      // Stop listening once decided: the child may outlive this call (a real GUI
      // handler keeps running), and its pipes must not hold anything open.
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners(); child.removeAllListeners(); } catch { /* gone */ }
      if (ok) { try { child.unref(); } catch { /* already gone */ } }
      resolve({ ok, error });
    };

    child.on('error', (err) => done(false, err.message));
    // `close` (not `exit`): these tools complain on stderr from a GRANDCHILD, so
    // listening for `exit` decided before the message was drained. And an exit
    // code alone is not evidence either — `gio` on a broken WSL setup exits 0
    // after printing its error, and those tools are silent when they work.
    child.on('close', (code) => {
      const noise = out.replace(/\s+/g, ' ').replace(/\u001b\(B/g, '').trim();
      if (code === 0 && !noise) return done(true);
      const why = code === 0 ? 'reported an error' : `exited with code ${code}`;
      done(false, `${why}${noise ? `: ${noise.slice(0, 180)}` : ''}`);
    });
    // Still running after the grace period means a real handler took over (a
    // GUI app inherits these pipes and stays alive).
    setTimeout(() => done(true), 800);
  });
}

// Linux openers, most likely first. Absolute paths lead on purpose: a broken
// `xdg-open` earlier on PATH must not shadow the real one.
const LINUX_OPENERS = [
  ['/usr/bin/xdg-open', []],
  ['/bin/xdg-open', []],
  ['xdg-open', []],
  ['/usr/bin/gio', ['open']],
  ['gio', ['open']],
  ['/usr/bin/sensible-browser', []],
];

async function openWithOs(target) {
  if (process.platform !== 'linux') {
    try {
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const failures = [];
  for (const [file, prefix] of LINUX_OPENERS) {
    // Skip absolute paths that are not installed; let PATH resolve bare names.
    if (file.startsWith('/') && !fs.existsSync(file)) continue;
    const res = await spawnOpener(file, [...prefix, target]);
    if (res.ok) return { ok: true, via: file };
    failures.push(`${file}: ${res.error}`);
  }
  return { ok: false, error: failures.join('; ') || 'no browser or file manager found' };
}

// Menu items have no error UI of their own — surface the failure in a dialog so
// a link that cannot open is still usable (the URL is shown and copyable).
async function openExternalOrReport(url) {
  const res = await openWithOs(url);
  if (!res.ok) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Could not open the link',
      message: 'No browser could be opened on this system.',
      detail: `${url}\n\n${res.error || ''}`,
    }).catch(() => {});
  }
  return res;
}

// ---------------------------------------------------------------------------
// Resume guard
// ---------------------------------------------------------------------------
// `kimi --session <id>` only resumes when the process runs in the exact
// directory the session was created in. Handing it anything else — including the
// home-directory fallback — makes the CLI print "Session ... was created under
// a different directory" and exit, which is what a dead Resume button looked
// like. Returns { cwd } on success, or { error, ... } so the renderer can say
// what actually happened instead of showing an optimistic success toast.
async function prepareResume(sessionId, recordedCwd) {
  const id = String(sessionId || '').trim();
  const plan = sessions.resumePlan(recordedCwd);
  const recorded = plan.cwd;
  const command = recorded ? `cd "${recorded}" && kimi -r ${id}` : `kimi -r ${id}`;

  if (plan.reason === 'unknown') {
    // Migrated/legacy sessions can lack a recorded directory, and kimi cannot
    // resume those from an arbitrary place.
    return {
      error: 'resume-cwd-unknown',
      sessionId: id,
      command,
      message: 'This session has no recorded working directory, so kimi cannot resume it.',
    };
  }
  if (plan.ok) return { cwd: recorded };

  const answer = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    buttons: ['Create folder & resume', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Resume session',
    message: 'This session was created in a folder that no longer exists',
    detail: `${recorded}\n\n` +
      'Kimi Code only resumes a session from the folder it was created in. ' +
      'Create that folder again and resume?\n\n' +
      `Equivalent command:\n${command}`,
  });
  const response = answer && typeof answer.response === 'number' ? answer.response : 1;
  if (response !== 0) return { error: 'resume-cancelled', sessionId: id, cwd: recorded, command };

  try {
    fs.mkdirSync(recorded, { recursive: true });
  } catch (err) {
    return {
      error: 'resume-cwd-missing',
      sessionId: id,
      cwd: recorded,
      command,
      message: `Could not create ${recorded}: ${err.message}`,
    };
  }
  return { cwd: recorded };
}

function registerIpc() {
  // Never await CLI detection here: it can take seconds (PATH lookup, npm
  // prefix, version probe, WSL fallback) and the window used to stay blank or
  // on the splash until it finished. Return the cheap data right away and flag
  // the detection as pending — the renderer resolves it in the background via
  // kimi:detect / the kimi:detected event.
  ipcMain.handle('app:get-bootstrap', () => {
    if (!detectionSettled) runDetection();
    const det = detectionSettled ? detection : { ...detection, pending: true };
    const wsl = det.source === 'wsl' && det.wsl ? det.wsl : null;
    return {
      settings,
      kimi: det,
      kimiHome: wsl ? (wsl.kimiCodeHomeWindows || wsl.kimiCodeHome) : (linuxKimiCodeHome() || sessions.kimiHome(currentEnv())),
      kimiHomeDisplay: wsl ? `${wsl.distro} · ${wsl.kimiCodeHome}` : (linuxKimiCodeHome() || sessions.kimiHome(currentEnv())),
      wsl,
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      homeDir: os.homedir(),
      // True when this window was launched by a test suite (KCD_TEST_HARNESS=1):
      // the renderer shows the TEST RUN banner from it.
      testHarness: TEST_HARNESS,
      // Candidate locations surfaced in the UI when sessions or the CLI are
      // missing, so users can create/point to them without guessing.
      sessionHomeDefault: sessions.kimiHome(currentEnv()),
      kimiCliCandidates: kimiDetect.commonCandidates(currentEnv()),
    };
  });

  // force=false joins the in-flight detection (or returns the finished result
  // without redoing the work) — used while booting. force=true re-runs a full
  // detection — used by “Re-detect” and the install self-heal.
  ipcMain.handle('kimi:detect', async (_e, force) => {
    if (detectionSettled && !force) return detection;
    return runDetection();
  });

  ipcMain.handle('kimi:set-path', async (_e, p) => {
    settings.kimiPath = typeof p === 'string' ? p.trim() : '';
    saveSettings();
    const det = await runDetection();
    return det;
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...settingsStore.sanitizePatch(patch) };
    saveSettings();
    return settings;
  });

  ipcMain.handle('sessions:list', async () => {
    const home = scanKimiCodeHome() || sessions.kimiHome(currentEnv());
    // The WSL 9P mount (\\wsl.localhost\...) can lag the VM start — wait for
    // it before scanning so a fresh launch doesn't report zero sessions.
    if (isWslMode() && home) await waitForPath(home, 8000);
    return { home, sessions: sessions.listSessions({ home }) };
  });

  ipcMain.handle('session:start', async (_e, opts) => {
    if (!detection.found || !detection.path) {
      const det = await runDetection();
      if (!det.found) return { error: 'kimi-not-found' };
    }

    let args;
    if (Array.isArray(opts.argv) && opts.argv.length) {
      // A literal kimi subcommand (e.g. `fork <id> -y`) — passed through as-is.
      args = opts.argv.map(String);
    } else if (opts.command === 'login') {
      args = ['login'];
    } else {
      args = ptyManager.buildArgs({
        mode: opts.mode || 'default',
        resumeId: opts.resumeId || '',
        quickPrompt: opts.quickPrompt || '',
      });
    }
    const cols = Math.max(opts.cols || 80, 2);
    const rows = Math.max(opts.rows || 24, 2);

    let session;
    let cwd = opts.cwd || effectiveCwd();
    // kimi refuses to resume a session from any directory other than the one the
    // session was created in ("Session ... was created under a different
    // directory"). Quietly swapping in the home directory therefore looked like
    // a dead Resume button: the tab opened, the CLI errored and exited. Keep the
    // recorded directory and let the user recreate it when it is gone.
    if (opts.resumeId) {
      const prepared = await prepareResume(opts.resumeId, opts.cwd);
      if (prepared.error) return prepared;
      cwd = prepared.cwd;
    }
    // Never hand a Windows path to `cd` inside the distro.
    if (!opts.resumeId && isWslMode() && isWindowsPath(cwd)) cwd = detection.wsl.home;
    if (isWslMode()) {
      // Working directory is a Linux path inside WSL — no Windows existence check.
      session = ptyManager.spawnWslSession({
        wsl: detection.wsl,
        kimiPath: detection.path,
        cwd,
        args,
        env: currentEnv(),
        kimiCodeHome: linuxKimiCodeHome(),
        cols,
        rows,
      });
    } else {
      // Never start inside a directory that doesn't exist — fall back to home.
      try {
        if (!opts.resumeId && !fs.existsSync(cwd)) cwd = os.homedir();
      } catch {
        cwd = os.homedir();
      }
      session = ptyManager.spawnKimiSession({
        binary: detection.path,
        cwd,
        args,
        env: currentEnv(),
        kimiCodeHome: linuxKimiCodeHome(),
        cols,
        rows,
      });
    }

    session.on('data', (data) => send('pty:data', { tabId: session.id, data }));
    session.on('exit', ({ exitCode, signal }) => {
      send('pty:exit', { tabId: session.id, exitCode, signal });
      sessionsByTab.delete(session.id);
    });
    sessionsByTab.set(session.id, session);

    return {
      tabId: session.id,
      pid: session.pid,
      binary: detection.path,
      kimiVersion: detection.version,
      cwd,
      args,
      mode: opts.mode || 'default',
      resumeId: opts.resumeId || null,
      quickPrompt: opts.quickPrompt || null,
    };
  });

  ipcMain.on('session:write', (_e, { tabId, data }) => {
    const s = sessionsByTab.get(tabId);
    if (s) s.write(data);
  });

  ipcMain.on('session:resize', (_e, { tabId, cols, rows }) => {
    const s = sessionsByTab.get(tabId);
    if (s) s.resize(Math.max(cols, 2), Math.max(rows, 2));
  });

  ipcMain.handle('session:kill', (_e, tabId) => {
    const s = sessionsByTab.get(tabId);
    if (s) {
      s.kill();
      sessionsByTab.delete(tabId);
      return true;
    }
    return false;
  });

  // `kimi export <id> -o <path> -y` — the CLI writes the ZIP itself; we just ask
  // where it should land. Inside WSL the target path is translated to /mnt/<drive>.
  ipcMain.handle('session:export', async (e, opts) => {
    const id = String((opts && opts.id) || '').trim();
    if (!id) return { ok: false, error: 'Missing session id.' };

    const rawTitle = String((opts && opts.title) || '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const suggested = `${rawTitle ? `${rawTitle} — ` : ''}${safeId}.zip`;

    let defaultDir = '';
    try { defaultDir = app.getPath('downloads'); } catch { defaultDir = app.getPath('home'); }

    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Kimi session as ZIP',
      defaultPath: path.join(defaultDir, suggested),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const target = result.filePath;
    const res = await runKimiCli(['export', id, '-o', wslSafePath(target), '-y']);
    if (res.code !== 0) {
      const detail = String(res.stderr || res.stdout || '').trim()
        || `kimi export exited with code ${res.code}`;
      return { ok: false, error: detail.split(/\r?\n/).filter(Boolean).slice(-1)[0] || detail };
    }
    return { ok: true, path: target };
  });

  ipcMain.handle('dialog:pick-folder', async (e, current) => {
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a working directory for Kimi Code',
      defaultPath: current || effectiveCwd(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-file', async (e, current) => {
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: 'Locate the kimi executable',
      defaultPath: current || '',
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat', '*'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open-external', async (_e, url) => {
    const target = String(url);
    if (!/^https?:\/\//.test(target)) return { ok: false, error: 'Only http(s) links can be opened.' };
    return openWithOs(target);
  });

  // Open a local folder (e.g. the session-storage directory) in the OS file
  // manager, so users can drop exported/migrated session data in place.
  ipcMain.handle('shell:open-path', async (_e, p) => {
    const target = String(p || '');
    try {
      if (target && fs.existsSync(target)) {
        return await openWithOs(target);
      }
      // Missing folder: open its nearest existing ancestor so the user can
      // create it in the right place.
      let probe = path.dirname(target);
      while (probe && probe !== path.parse(probe).root && !fs.existsSync(probe)) {
        probe = path.dirname(probe);
      }
      if (probe && fs.existsSync(probe)) {
        return { ...(await openWithOs(probe)), createdHint: true };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Path not found' };
  });

  ipcMain.handle('app:get-path', (_e, name) => {
    const allowed = new Set(['home', 'appData', 'userData', 'temp', 'exe', 'documents', 'downloads']);
    if (!allowed.has(String(name))) return '';
    try { return app.getPath(String(name)); } catch { return ''; }
  });

  // Window controls for the custom in-app title bar.
  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  ipcMain.handle('window:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));

  // Kimi CLI config.toml editor.
  ipcMain.handle('config:read', async () => {
    const { windowsPath, displayPath, viaWsl } = kimiConfigPaths();
    if (!windowsPath) {
      return { path: displayPath, exists: false, content: '', error: 'Could not resolve the Kimi config path.' };
    }
    try {
      // The WSL 9P mount can lag VM startup — wait briefly before reading.
      if (viaWsl) await waitForPath(path.dirname(windowsPath), 4000);
      const exists = fs.existsSync(windowsPath);
      const content = exists ? fs.readFileSync(windowsPath, 'utf8') : '';
      return { path: displayPath, exists, content, viaWsl };
    } catch (err) {
      return { path: displayPath, exists: false, content: '', error: err.message };
    }
  });

  ipcMain.handle('config:write', async (_e, content) => {
    const { windowsPath, displayPath } = kimiConfigPaths();
    if (!windowsPath) {
      return { ok: false, path: displayPath, error: 'Could not resolve the Kimi config path.' };
    }
    try {
      fs.mkdirSync(path.dirname(windowsPath), { recursive: true });
      fs.writeFileSync(windowsPath, typeof content === 'string' ? content : '', 'utf8');
      return { ok: true, path: displayPath };
    } catch (err) {
      return { ok: false, path: displayPath, error: err.message };
    }
  });

  ipcMain.handle('clipboard:write-text', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
}

const sessionsByTab = new Map();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Launch with safe fallback flags when the environment is known-broken
// (UNC path / no usable GPU) instead of crashing with "GPU process isn't
// usable". Only flags that are actually missing are added, so an explicit
// --disable-gpu from the user is respected rather than duplicated.
const startupFallbackFlags = fallbackFlags();
if (startupFallbackFlags.length) {
  relaunchWithFlags(startupFallbackFlags);
} else {

// Crash-visible: a silent exit is the worst failure mode for a desktop app.
process.on('uncaughtException', (err) => {
  console.error('[app] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[app] unhandled rejection:', err);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error('[app] another instance already holds the lock - quitting.');
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
    buildMenu();
    createWindow();
    runDetection().then((det) => send('kimi:detected', det));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    for (const s of sessionsByTab.values()) s.kill();
    sessionsByTab.clear();
  });

}
}
