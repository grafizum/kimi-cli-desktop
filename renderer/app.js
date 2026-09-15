'use strict';

/* global Terminal, FitAddon, SearchAddon, WebLinksAddon */

const api = window.kimiDesktop;

// Terminal font. JetBrains Mono is the mono face the `kimi web` UI uses; it is
// bundled under assets/ and declared in styles.css so it works offline.
const FONT_STACK =
  '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", "Cascadia Mono", "SF Mono", "Fira Code", "Menlo", "Consolas", "DejaVu Sans Mono", monospace';

// Terminal palettes. Background/foreground/cursor follow the app palette
// (#181818 · #DFDFDF · #2A2A2A); the ANSI ramp stays colourful so CLI output
// (diffs, logs, warnings) keeps its meaning.
const THEMES = {
  dark: {
    background: '#181818', foreground: '#DFDFDF',
    cursor: '#DFDFDF', cursorAccent: '#181818',
    selectionBackground: '#3A3A3A',
    black: '#2A2A2A', red: '#E8776F', green: '#8BC98A', yellow: '#E0B463',
    blue: '#7AA2F7', magenta: '#C678DD', cyan: '#56B6C2', white: '#DFDFDF',
    brightBlack: '#5F5F5F', brightRed: '#E8776F', brightGreen: '#8BC98A',
    brightYellow: '#E0B463', brightBlue: '#7AA2F7', brightMagenta: '#C678DD',
    brightCyan: '#56B6C2', brightWhite: '#FFFFFF',
  },
  light: {
    background: '#FFFFFF', foreground: '#181818',
    cursor: '#2A2A2A', cursorAccent: '#FFFFFF',
    selectionBackground: '#DFDFDF',
    black: '#2A2A2A', red: '#C0392B', green: '#2E7D32', yellow: '#9A6700',
    blue: '#1565C0', magenta: '#7B1FA2', cyan: '#00838F', white: '#5A5A5A',
    brightBlack: '#767676', brightRed: '#C0392B', brightGreen: '#2E7D32',
    brightYellow: '#9A6700', brightBlue: '#1565C0', brightMagenta: '#7B1FA2',
    brightCyan: '#00838F', brightWhite: '#181818',
  },
};

const MODE_LABELS = { default: 'Default', plan: 'Plan', yolo: 'Yolo', auto: 'Auto' };

// Comment-only starter for an empty config.toml (no invented keys).
const CONFIG_TEMPLATE = `# Kimi Code CLI configuration (config.toml)
# Docs: https://www.kimi.com/code/docs/en/kimi-code-cli/
#
# Add your model, provider, permission and tool settings below.
# This is the same file the kimi CLI reads at startup.
`;

const state = {
  settings: null,
  kimi: null,
  kimiHome: '',
  kimiHomeDisplay: '',
  homeDir: '',
  platform: 'win32',
  appVersion: '',
  sessions: [],
  filter: '',
  tabs: new Map(), // tabId -> tab record
  // PTY output/exit that arrived before its tab record existed (see onPtyData).
  pendingPty: new Map(), // tabId -> { chunks: string[], exitCode: number|null }
  activeTabId: null,
  searchOpen: false,
  nsCwd: null,
  qtCwd: null,
  settingsTab: 'config',
  // config.toml editor buffer state: populated on first open, kept across tab
  // switches, and never clobbered while it holds unsaved edits.
  cfgLoaded: false,
  cfgDirty: false,
  sessionMenuFor: null,
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function $(sel) { return document.querySelector(sel); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function isMac() { return navigator.platform === 'MacIntel'; }

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
// Every icon is an inline SVG, never a text glyph. Glyph icons (fullwidth plus,
// fork, copy, key…) are only drawn when a font installed on the machine happens
// to cover their codepoint — when none does, the OS paints an empty tofu box in the middle of
// the button. That makes the same build look broken on one machine and fine on
// another. SVG has no font dependency, so every button renders identically.
const ICONS = {
  bolt: '<path d="M9.3 2 4.8 8.6h3l-.7 5.4 5.1-7.2H8.9z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3.6v8.8M3.6 8h8.8"/>',
  refresh: '<path d="M13.7 10a6 6 0 1 1-1.4-6.2L15.3 6.7"/><path d="M15.3 2.7v4h-4"/>',
  arrowUp: '<path d="M8 12.7V3.3M4.3 7 8 3.3 11.7 7"/>',
  arrowDown: '<path d="M8 3.3v9.4M4.3 9 8 12.7 11.7 9"/>',
  close: '<path d="M12 4 4 12M4 4l8 8"/>',
  check: '<path d="M13.3 4.1 6.2 11.2 2.7 7.7"/>',
  diamond: '<path d="M8 3.1 12.9 8 8 12.9 3.1 8z" fill="currentColor" stroke="none"/>',
  dot: '<circle cx="8" cy="8" r="3.1" fill="currentColor" stroke="none"/>',
  more: '<circle cx="3.4" cy="8" r="1.35" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.35" fill="currentColor" stroke="none"/>',
  branch: '<circle cx="4.6" cy="3.3" r="1.4"/><circle cx="4.6" cy="12.7" r="1.4"/><circle cx="11.4" cy="5.6" r="1.4"/><path d="M4.6 4.7v6.6"/><path d="M11.4 7c0 2.2-2.1 2.6-4.6 3.3"/>',
  fork: '<circle cx="4.4" cy="8" r="1.4"/><circle cx="11.6" cy="3.4" r="1.4"/><circle cx="11.6" cy="12.6" r="1.4"/><path d="M5.8 7.3 10.2 4.2"/><path d="M5.8 8.7l4.4 3.1"/>',
  resume: '<path d="M6.2 3.9 2.9 7.2l3.3 3.3"/><path d="M3.1 7.2h6a3.4 3.4 0 0 1 0 6.8H6.4"/>',
  export: '<path d="M8 2.6v7.6M4.7 7 8 10.2 11.3 7"/><path d="M2.9 10.4v2.3a1.3 1.3 0 0 0 1.3 1.3h7.6a1.3 1.3 0 0 0 1.3-1.3v-2.3"/>',
  copy: '<rect x="5.4" y="2.7" width="7.9" height="7.9" rx="1.8"/><rect x="2.7" y="5.4" width="7.9" height="7.9" rx="1.8"/>',
  key: '<circle cx="5.5" cy="8" r="2.7"/><path d="M8.2 8h5.2"/><path d="M11.3 8v2.1"/><path d="M13.4 8v1.5"/>',
  external: '<path d="M12 2.6h1.4a1.3 1.3 0 0 1 1.3 1.3V12a1.4 1.4 0 0 1-1.4 1.4H5.3A1.4 1.4 0 0 1 3.9 12V5.3a1.4 1.4 0 0 1 1.4-1.4h1"/><path d="M9.6 2.6h3.9v3.9"/><path d="M13.5 2.6 8.4 7.7"/>',
  chevron: '<path d="M5.9 3.6 10.3 8l-4.4 4.4"/>',
  folder: '<path d="M1.8 4.2c0-.9.7-1.6 1.6-1.6h3l1.6 1.7h5.2c.9 0 1.6.7 1.6 1.6v6c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6v-7.7z"/>',
  calendar: '<rect x="2.4" y="3.6" width="11.2" height="10" rx="1.8"/><path d="M2.4 6.7h11.2"/><path d="M5.6 2.3v2.5M10.4 2.3v2.5"/>',
};

// Returns the markup for one icon. Callers pass it through esc()-safe template
// strings — it contains no user data, only the fixed paths above.
function ico(name, cls) {
  const body = ICONS[name] || ICONS.dot;
  return `<svg class="ico${cls ? ` ${esc(cls)}` : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// In WSL mode the working directory must be a Linux path — ignore a Windows
// path left over from native mode so sessions can still start.
function usableCwd(value) {
  if (!value) return '';
  if (isWsl() && /^[A-Za-z]:[\\/]/.test(value)) return '';
  return value;
}

function isWsl() { return !!(state.kimi && state.kimi.source === 'wsl' && state.kimi.wsl); }
function wslDistro() { return isWsl() ? state.kimi.wsl.distro : ''; }

function toast(msg, kind = '') {
  const host = $('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  // Icon and message are separate nodes, and the message always goes in as
  // text — a CLI or file path echoed into a toast can never become markup.
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ico(kind === 'error' ? 'close' : kind === 'ok' ? 'check' : 'dot');
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = msg;
  el.append(icon, text);
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240); // match the toast-out fade
  }, 4200);
}

// Open a link in the OS browser and report when that fails. On Linux the OS
// opener can be missing or shadowed by a broken shim, and Electron reports
// success anyway — a link that silently does nothing looks like a dead button.
// Copying the URL keeps the action useful even with no browser available.
async function openExternalSafe(url, what = 'link') {
  let res = null;
  try { res = await api.openExternal(url); } catch { res = { ok: false }; }
  if (res && res.ok === false) {
    api.copyText(url);
    toast(`Could not open the ${what} — no browser available. Link copied to the clipboard.`, 'error');
  }
  return res;
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateBucket(ts) {
  if (!ts) return 'Older';
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfDay) return 'Today';
  if (ts >= startOfDay - 86400000) return 'Yesterday';
  if (ts >= startOfDay - 7 * 86400000) return 'This week';
  if (ts >= startOfDay - 30 * 86400000) return 'This month';
  return 'Older';
}

function sessionTitle(s) {
  if (s.title) return s.title;
  if (s.lastPrompt) return s.lastPrompt.length > 120 ? `${s.lastPrompt.slice(0, 117)}…` : s.lastPrompt;
  return 'Untitled session';
}

function projectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// Pure: bucket sessions into the sidebar's labelled groups. Deliberately free of
// DOM and of app state so the smoke suite can unit-test it (see the groupSessions
// block in scripts/smoke-test.js).
//
// Project mode keys groups by the *full* recorded directory, never the folder
// name — two checkouts that both end in "app" are different projects. Sessions
// with no recorded cwd cannot be attributed to one, so they get their own
// heading pinned last instead of being silently dropped.
function groupSessions(list, mode, collapsedKeys) {
  const collapsed = new Set(collapsedKeys || []);
  const groups = [];

  if (mode === 'date') {
    const byBucket = new Map();
    for (const s of list) {
      const bucket = dateBucket(s.updatedAt);
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(s);
    }
    for (const label of ['Today', 'Yesterday', 'This week', 'This month', 'Older']) {
      const items = byBucket.get(label);
      if (!items) continue;
      const key = `date:${label}`;
      groups.push({ key, label, hint: '', items, collapsed: collapsed.has(key) });
    }
    return groups;
  }

  const byDir = new Map();
  for (const s of list) {
    const dir = String(s.cwd || '').replace(/[\\/]+$/, '');
    // Case-insensitive because Windows paths are; harmless elsewhere.
    const key = dir.toLowerCase();
    if (!byDir.has(key)) byDir.set(key, { dir, items: [] });
    byDir.get(key).items.push(s);
  }
  for (const [key, g] of byDir) {
    groups.push({
      key: key ? `project:${key}` : 'project:none',
      label: key ? (projectName(g.dir) || g.dir) : 'No folder recorded',
      hint: g.dir,
      items: g.items,
      newest: g.items.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0),
    });
  }
  groups.sort((a, b) => {
    // Newest project first; "No folder recorded" is pinned last whatever its age.
    const aNone = a.key === 'project:none' ? 1 : 0;
    const bNone = b.key === 'project:none' ? 1 : 0;
    if (aNone !== bNone) return aNone - bNone;
    return (b.newest - a.newest) || a.label.localeCompare(b.label);
  });
  for (const g of groups) g.collapsed = collapsed.has(g.key);
  return groups;
}



// The OS account name must never show up in the UI just because that is where a
// path happens to live. Replace the user's home directory with the conventional
// shorthand (%USERPROFILE% on Windows, ~ elsewhere) for *display* only — the app
// itself still uses the real paths. Handles WSL too (Linux home of the distro).
function genericPath(p) {
  const raw = String(p == null ? '' : p);
  if (!raw) return raw;
  const home = String(
    (isWsl() && state.kimi && state.kimi.wsl ? state.kimi.wsl.home : state.homeDir) || ''
  ).replace(/[\\/]+$/, '');
  if (!home) return raw;
  const isWinHome = /^[A-Za-z]:[\\/]/.test(home);
  const marker = isWinHome ? '%USERPROFILE%' : '~';
  const swapped = raw.split(home).join(marker);
  if (swapped !== raw) return swapped;
  // Windows paths are case-insensitive.
  if (isWinHome) {
    const re = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return raw.replace(re, marker);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const boot = await api.getBootstrap();
  state.settings = boot.settings;
  state.kimi = boot.kimi;
  state.kimiHome = boot.kimiHome;
  state.kimiHomeDisplay = boot.kimiHomeDisplay || boot.kimiHome;
  state.homeDir = boot.homeDir;
  state.platform = boot.platform;
  state.appVersion = boot.appVersion;
  state.kimiCliCandidates = boot.kimiCliCandidates || [];
  state.sessionHomeDefault = boot.sessionHomeDefault || '';
  // Set by the e2e suites (KCD_TEST_HARNESS=1): this window runs the fake CLI.
  state.testHarness = boot.testHarness === true;

  document.documentElement.dataset.platform = state.platform;
  applyTestBanner();
  applyTheme();
  applyTerminalStyle();
  applySidebarWidth(state.settings.sidebarWidth || DEFAULT_SIDEBAR_W, false);
  applySidebarCollapsed(state.settings.sidebarCollapsed === true, false);
  renderKimiStatus();
  renderStatusBar();

  wireEvents();

  // The shell is usable the moment the above has run — drop the splash now
  // instead of waiting for the first terminal to paint. There is no terminal
  // until the user starts a session, so the old code sat on the splash until
  // the failsafe fired, which made every launch feel slow. The failsafe stays
  // armed as a last-resort net.
  armSplashFailsafe();
  hideSplash();

  // The pty is spawned in the main process *before* the renderer creates its
  // tab, so the first chunks of output can arrive while state.tabs has no entry
  // for the session yet. Dropping them loses the TUI's screen setup, which
  // makes kimi paint onto an uninitialised screen and leaves stray rows /
  // characters behind (worse the higher up the viewport you look). Buffer
  // those chunks and replay them as soon as the tab exists.
  api.onPtyData(({ tabId, data }) => {
    hideSplash(); // any terminal output means the PTY is alive and painting
    const tab = state.tabs.get(tabId);
    if (tab) {
      clearPaneLoader(tab); // first output means the CLI is painting
      if (tab.status === 'running') {
        tab.term.write(data);
        if (tab.kind === 'login') watchLoginUrl(tab, data);
      }
      return;
    }
    let pending = state.pendingPty.get(tabId);
    if (!pending) { pending = { chunks: [], exitCode: null }; state.pendingPty.set(tabId, pending); }
    pending.chunks.push(data);
  });

  api.onPtyExit(({ tabId, exitCode }) => {
    const tab = state.tabs.get(tabId);
    if (tab) {
      markExited(tab, exitCode);
    } else {
      let pending = state.pendingPty.get(tabId);
      if (!pending) { pending = { chunks: [], exitCode: null }; state.pendingPty.set(tabId, pending); }
      pending.exitCode = exitCode;
    }
    refreshSessions();
  });

  api.onKimiDetected((det) => applyDetection(det));

  api.onAppFocus(() => refreshSessions());

  api.onMenu((action) => handleMenuAction(action));

  // Show the session history / welcome as soon as detection is settled — it
  // may already be done (fast path), or the main process may still be looking,
  // in which case the result arrives asynchronously without blocking the UI.
  if (state.kimi && state.kimi.found) {
    renderWelcome(false);
    void refreshSessions();
  } else if (state.kimi && state.kimi.pending) {
    void resolveDetection();
  } else {
    renderWelcome(true);
  }
}

// Apply a finished detection result to the UI (status dot, welcome screen,
// session history). Safe to call more than once — the kimi:detected event and
// the explicit kimi:detect join can both deliver the same result.
function applyDetection(det) {
  if (!det) return;
  state.kimi = det;
  renderKimiStatus();
  renderStatusBar();
  renderWelcome(!det.found);
  if (det.found) void refreshSessions();
}

// Detection keeps running in the main process after the window is up. Join that
// in-flight work instead of awaiting it during boot, so the app is interactive
// immediately even on machines where detection is slow.
async function resolveDetection() {
  try {
    applyDetection(await api.detectKimi());
  } catch {
    /* detection never rejects in the main process — keep the pending state */
  }
}

function handleMenuAction(action) {
  switch (action) {
    case 'new-session': openModal('modal-new-session'); break;
    case 'new-quick-task': openModal('modal-quick-task'); break;
    case 'close-tab': closeActiveTab(); break;
    case 'copy': copySelection(); break;
    case 'paste': pasteClipboard(); break;
    case 'find': toggleSearch(); break;
    case 'font-up': changeFontSize(1); break;
    case 'font-down': changeFontSize(-1); break;
    case 'font-reset': setFontSize(13); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
    case 'login': startLogin(); break;
    case 'open-config': openConfigModal(); break;
    case 're-detect': reDetect(); break;
    case 'refresh-sessions': refreshSessions(); break;
  }
}

// ---------------------------------------------------------------------------
// Status / welcome rendering
// ---------------------------------------------------------------------------

// A test-harness window (the e2e suites set KCD_TEST_HARNESS=1; main.js passes
// the flag through bootstrap and titles the window "… [TEST RUN]") shows the
// yellow banner so a leftover, interrupted test window can never be mistaken
// for the user's real app.
function applyTestBanner() {
  const banner = $('#test-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', !state.testHarness);
  if (state.testHarness) document.title = 'Kimi Code Desktop [TEST RUN]';
}

function renderKimiStatus() {
  const dot = $('#kimi-status-dot');
  const text = $('#kimi-status-text');
  if (!state.kimi || state.kimi.pending) {
    dot.className = 'status-dot busy';
    text.textContent = 'Detecting Kimi Code CLI…';
    return;
  }
  if (state.kimi.found) {
    dot.className = 'status-dot ok';
    const wslTag = isWsl()
      ? ` <span class="wsl-tag">WSL · ${esc(state.kimi.wsl.distro)}</span>`
      : '';
    text.innerHTML = `<strong>kimi</strong> v${esc(state.kimi.version)}${wslTag}`;
  } else {
    dot.className = 'status-dot bad';
    text.innerHTML = `<strong>Kimi Code CLI not found</strong> — install it or set the path in Settings`;
  }
}

function renderStatusBar() {
  const kimi = state.kimi && state.kimi.pending
    ? 'detecting kimi…'
    : state.kimi && state.kimi.found
      ? `kimi v${state.kimi.version} · ${genericPath(state.kimi.path)}${isWsl() ? ` (WSL · ${state.kimi.wsl.distro})` : ''}`
      : 'kimi not detected';
  $('#status-kimi').textContent = kimi;
  $('#status-kimi').title = kimi;
  // Report the data directory without the OS account name in it.
  const homeText = genericPath(state.kimiHomeDisplay || state.kimiHome);
  $('#status-home').textContent = homeText;
  $('#status-home').title = homeText;
}

function renderWelcome(showMissing) {
  const welcome = $('#welcome');
  if (!showMissing) {
    welcome.classList.add('hidden');
    return;
  }
  // Welcome is a terminal state, not a transient flash — once it is on stage
  // the splash has nothing left to wait for.
  hideSplash();

  const win = state.platform === 'win32';
  const cmds = win
    ? [
        ['Windows (PowerShell)', 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'],
        ['Any OS (npm)', 'npm install -g @moonshot-ai/kimi-code'],
      ]
    : [
        ['macOS / Linux', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
        ['Any OS (npm)', 'npm install -g @moonshot-ai/kimi-code'],
      ];

  welcome.innerHTML = `
    <div class="welcome-card">
      <h1>Kimi Code CLI isn't on this machine yet</h1>
      <p class="lead">
        Kimi Code Desktop is a shell around the <strong>Kimi Code CLI</strong> — Moonshot AI's terminal
        coding agent. It reads and edits code, runs commands, browses the web, and shows its
        <strong>reasoning</strong> as it works. Install the CLI once, and this app will detect it and
        run full interactive sessions for you.
      </p>
      <h2>Install Kimi Code CLI</h2>
      ${cmds.map(([osName, cmd]) => `
        <div class="install-step">
          <span class="os-tag">${esc(osName)}</span>
          <code>${esc(cmd)}</code>
          <button class="btn ghost copy-btn" data-copy="${esc(cmd)}">Copy</button>
        </div>`).join('')}
      <p class="welcome-note">
        Windows: Git for Windows is required (Kimi uses its bundled Git Bash). On first launch, sign in
        from <strong>Settings → Account</strong>, then start a session.
      </p>
      <div class="welcome-actions">
        <button id="welcome-redetect" class="btn primary">I've installed it — re-detect</button>
        <button id="welcome-docs" class="btn ghost">Installation docs ${ico('external')}</button>
        <button id="welcome-settings" class="btn ghost">Point me to a kimi binary…</button>
      </div>
    </div>`;

  welcome.querySelectorAll('.copy-btn').forEach((b) => {
    b.addEventListener('click', () => {
      api.copyText(b.dataset.copy);
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
  });
  $('#welcome-redetect').addEventListener('click', reDetect);
  $('#welcome-docs').addEventListener('click', () =>
    openExternalSafe('https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html', 'installation docs'));
  $('#welcome-settings').addEventListener('click', () => openSettingsModal('cli'));
}

// ---------------------------------------------------------------------------
// Session history panel
// ---------------------------------------------------------------------------

async function refreshSessions() {
  if (!state.kimi || !state.kimi.found) return;
  try {
    const res = await api.listSessions();
    state.kimiHome = res.home;
    state.sessions = res.sessions;
    renderStatusBar();
    renderSessionList();
  } catch (err) {
    console.error('refreshSessions failed', err);
  }
}

function filteredSessions() {
  const q = state.filter.trim().toLowerCase();
  let list = state.sessions.filter((s) => s.interactive !== false);
  if (q) {
    list = list.filter((s) =>
      [sessionTitle(s), s.lastPrompt, s.cwd, projectName(s.cwd), s.id, s.gitBranch]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  return list.slice(0, 300);
}

function renderSessionList() {
  const listEl = $('#session-list');
  const list = filteredSessions();
  if (!list.length) {
    if (state.sessions.length) {
      listEl.innerHTML = '<div class="session-empty">No sessions match your search.</div>';
    } else {
      // Genuinely empty: tell the user where sessions live so a history from
      // another machine (or KIMI_CODE_HOME) can be dropped in by hand.
      const home = state.kimiHome || state.settings.kimiCodeHome || '';
      const shown = genericPath(home);
      const short = shown.length > 34 ? `…${shown.slice(-32)}` : shown;
      listEl.innerHTML = `
        <div class="session-empty">
          <div class="se-title">No sessions here yet</div>
          <div class="se-text">Sessions are read from the folder<br/>below. Copy a session history into it<br/>and press the refresh arrow above.</div>
          <code class="se-path" title="${esc(shown)}">${esc(short)}</code>
          <div class="se-actions">
            <button id="se-change-home" class="btn ghost" title="Choose the folder Kimi reads sessions from — opens Settings → Sessions">Change Folder</button>
          </div>
        </div>`;
      // The session folder lives on the Sessions tab, not Kimi CLI —
      // opening 'cli' landed users on the executable-path form instead.
      $('#se-change-home')?.addEventListener('click', () => openSettingsModal('sessions'));
    }
    return;
  }

  // Grouping is a user setting (project folders by default; date is the other
  // mode). A live search must never hide its own matches behind a folded group.
  const mode = state.settings.sessionGroupBy === 'date' ? 'date' : 'project';
  const searching = state.filter.trim().length > 0;
  const groups = groupSessions(list, mode, searching ? [] : state.settings.collapsedGroups);

  let html = '';
  for (const g of groups) {
    const tip = g.hint ? ` title="${esc(genericPath(g.hint))}"` : '';
    html += `
      <div class="session-group">
        <button class="session-group-label" type="button" data-key="${esc(g.key)}" aria-expanded="${g.collapsed ? 'false' : 'true'}"${tip}>
          <span class="sgl-caret" aria-hidden="true">${ico('chevron')}</span>
          <span class="sgl-text">${esc(g.label)}</span>
          <span class="sgl-count">${g.items.length}</span>
        </button>`;
    if (g.collapsed) { html += '</div>'; continue; }
    for (const s of g.items) {
      const title = sessionTitle(s);
      const project = projectName(s.cwd) || s.id.slice(0, 8);
      const branch = s.gitBranch ? ` <span class="branch">${ico('branch')} ${esc(s.gitBranch)}</span>` : '';
      html += `
        <div class="session-item" data-id="${esc(s.id)}" title="Click to resume ${esc(title)} — right-click or press the button for more actions">
          <div class="si-body">
            <div class="si-title">${esc(title)}</div>
            <div class="si-meta">${esc(project)}${branch} · ${relTime(s.updatedAt)}</div>
          </div>
          <button class="si-more" title="Session actions" aria-label="Session actions" aria-haspopup="menu">${ico('more')}</button>
        </div>`;
    }
    html += '</div>';
  }
  listEl.innerHTML = html;

  // Folding a group is a view preference, so it survives the re-render and the
  // next launch (collapsedGroups in settings.json).
  listEl.querySelectorAll('.session-group-label').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      const set = new Set(state.settings.collapsedGroups || []);
      if (set.has(key)) set.delete(key); else set.add(key);
      state.settings.collapsedGroups = [...set];
      api.setSettings({ collapsedGroups: state.settings.collapsedGroups });
      renderSessionList();
    });
  });

  listEl.querySelectorAll('.session-item').forEach((el) => {
    const s = state.sessions.find((x) => x.id === el.dataset.id);
    if (!s) return;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.si-more')) return; // the button opens the menu
      resumeSession(s);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSessionMenu(s, el);
    });
    const more = el.querySelector('.si-more');
    if (more) {
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        openSessionMenu(s, el);
      });
    }
  });

  // A re-render replaces every row node — close any menu attached to one.
  closeSessionMenu();
}

async function resumeSession(s) {
  if (!(await ensureKimi())) return;
  // Pass the recorded directory through untouched: substituting the home
  // directory makes kimi refuse to resume (see prepareResume in main.js).
  const cwd = s.cwd || '';
  const label = sessionTitle(s);
  const tab = await startSession({
    cwd,
    mode: 'default',
    resumeId: s.id,
    kind: 'resume',
    label,
  });
  if (tab) toast(`Resuming session — ${label}`, 'ok');
}

// ---------------------------------------------------------------------------
// Session row actions
// ---------------------------------------------------------------------------
// Each entry mirrors a command the `kimi` CLI really exposes — the app never
// invents its own session mutations:
//   resume  → kimi --session <id>
//   fork    → kimi fork <id> -y
//   export  → kimi export <id> -o <path> -y
// There is deliberately no delete/archive entry: `kimi session` only ships a
// `list` subcommand, so neither exists on the CLI surface.

function openSessionMenu(s, anchorEl) {
  const menu = $('#session-menu');
  if (!menu) return;
  closeSessionMenu();

  const title = sessionTitle(s);
  menu.innerHTML = `
    <div class="ctx-label" title="${esc(title)}">${esc(title)}</div>
    <button type="button" role="menuitem" data-action="resume"><span class="ctx-icon">${ico('resume')}</span>Resume session</button>
    <button type="button" role="menuitem" data-action="fork"><span class="ctx-icon">${ico('fork')}</span>Fork into a new session<span class="ctx-sub">kimi fork</span></button>
    <button type="button" role="menuitem" data-action="export"><span class="ctx-icon">${ico('export')}</span>Export as ZIP…<span class="ctx-sub">kimi export</span></button>
    <button type="button" role="menuitem" data-action="copy-id"><span class="ctx-icon">${ico('copy')}</span>Copy session ID</button>
    <div class="ctx-sep"></div>
    <div class="ctx-note">Rename, delete and archive live in kimi's own TUI (<code>/sessions</code>, <code>/title</code>) — the CLI has no non-interactive command for them.</div>`;

  // Position next to the row, kept inside the viewport.
  const r = anchorEl.getBoundingClientRect();
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  const top = Math.min(r.bottom + 6, window.innerHeight - mh - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  anchorEl.classList.add('menu-open');
  state.sessionMenuFor = s.id;

  menu.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      closeSessionMenu();
      runSessionAction(action, s);
    });
  });
  const first = menu.querySelector('button[data-action]');
  if (first) first.focus();
}

function closeSessionMenu() {
  const menu = $('#session-menu');
  if (menu) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }
  document.querySelectorAll('.session-item.menu-open').forEach((el) => el.classList.remove('menu-open'));
  state.sessionMenuFor = null;
}

function runSessionAction(action, s) {
  switch (action) {
    case 'resume': resumeSession(s); break;
    case 'fork': forkSession(s); break;
    case 'export': exportSession(s); break;
    case 'copy-id':
      api.copyText(s.id);
      toast('Session ID copied to the clipboard', 'ok');
      break;
  }
}

async function forkSession(s) {
  if (!(await ensureKimi())) return;
  const label = sessionTitle(s);
  // `kimi fork <id> -y` copies the conversation into a brand new session; the
  // copy shows up in Previous sessions once the command finishes.
  const tab = await startSession({
    cwd: s.cwd || state.homeDir,
    argv: ['fork', s.id, '-y'],
    kind: 'fork',
    label,
  });
  if (tab) toast('Forking conversation — the copy lands in Previous sessions', 'ok');
}

async function exportSession(s) {
  const res = await api.exportSession({ id: s.id, title: sessionTitle(s) });
  if (!res || res.canceled) return;
  if (res.ok) toast(`Session exported to ${genericPath(res.path)}`, 'ok');
  else toast(res.error || 'Could not export the session.', 'error');
}

// ---------------------------------------------------------------------------
// Tabs & terminals
// ---------------------------------------------------------------------------

function terminalOptions() {
  const s = state.settings;
  return {
    fontFamily: s.fontFamily || FONT_STACK,
    fontSize: s.fontSize || 13,
    theme: terminalTheme(),
    scrollback: s.scrollback || 10000,
    // Kimi's TUI is a dense grid of panels; a touch of leading keeps it in step
    // with the app's own text rhythm instead of reading as a wall of rows.
    lineHeight: 1.35,
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    allowProposedApi: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: true,
    // Windows sessions run on ConPTY (see src/pty.js); telling xterm lets it
    // apply its ConPTY reflow/repaint workarounds, which stops the TUI from
    // showing duplicated rows after a resize.
    windowsPty: state.platform === 'win32' ? { backend: 'conpty' } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Splash screen — a made-in-house loading cover that hides xterm/PTY start-up
// (font swap, blank canvas, ConPTY repaint) behind a Kimi-branded animation.
// It lifts when the first terminal has actually painted content, or after a
// failsafe timeout so a slow/missing CLI can never trap the user.
// ---------------------------------------------------------------------------

let splashHidden = false;
let splashFailsafe = null;

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  if (splashFailsafe) { clearTimeout(splashFailsafe); splashFailsafe = null; }
  const el = document.getElementById('splash');
  if (!el) return;
  el.classList.add('splash-hide');
  setTimeout(() => el.setAttribute('hidden', ''), 500); // match the CSS fade
}

function armSplashFailsafe() {
  if (splashFailsafe) return;
  splashFailsafe = setTimeout(hideSplash, 4000);
}

// ---------------------------------------------------------------------------
// Per-session loading cover. Between the PTY spawning and the CLI's first paint
// the terminal really is blank — and while the font metrics are still settling
// xterm measures against a stale box, which is what shows up as rectangles on a
// slow start. Cover the pane with the same Kimi animation as the boot splash and
// lift it on the first byte of output, with a failsafe so a CLI that never
// speaks still can't trap the cover on screen.
// ---------------------------------------------------------------------------

const SESSION_LOADER_FAILSAFE_MS = 8000;

const LOADER_LABELS = {
  resume: 'Resuming session',
  fork: 'Forking session',
  quick: 'Running task',
  login: 'Starting sign-in',
};

function createPaneLoader(pane, kind) {
  const el = document.createElement('div');
  el.className = 'pane-loader';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="pl-spinner">
      <svg class="pl-ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="pl-track" cx="22" cy="22" r="19"></circle>
        <circle class="pl-arc" cx="22" cy="22" r="19"></circle>
      </svg>
      <svg class="pl-mark" viewBox="0 0 200 200" fill="currentColor" aria-hidden="true">
        <path d="M52 48H82V152H52Z" />
        <path d="M87.72 110.86L147.72 72.86L132.28 47.14L72.28 85.14Z" />
        <path d="M71.97 114.67L131.97 152.67L148.03 127.33L88.03 89.33Z" />
      </svg>
    </div>
    <div class="pl-text">${LOADER_LABELS[kind] || 'Starting session'}</div>
    <div class="pl-bar"><span></span></div>`;
  pane.appendChild(el);
  return el;
}

function clearPaneLoader(tab) {
  if (tab.loaderTimer) { clearTimeout(tab.loaderTimer); tab.loaderTimer = null; }
  const el = tab.loader;
  if (!el) return;
  tab.loader = null;
  el.classList.add('pl-out');
  setTimeout(() => el.remove(), 300); // match the pl-out fade
}

function createTab({ id, label, kind }) {
  const kindIcon = ico(kind === 'resume' ? 'resume' : kind === 'fork' ? 'fork' : kind === 'quick' ? 'bolt' : kind === 'login' ? 'key' : 'dot');

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.setAttribute('role', 'button');
  tabEl.dataset.tab = id;
  tabEl.innerHTML = `
    <span class="tab-kind">${kindIcon}</span>
    <span class="tab-label"></span>
    <span class="tab-status-badge"></span>
    <span class="tab-close" title="Close session">${ico('close')}</span>`;
  $('#tabs').appendChild(tabEl);

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  pane.dataset.tab = id;
  pane.style.display = 'none';
  $('#terminal-host').appendChild(pane);

  const term = new Terminal(terminalOptions());
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openExternalSafe(uri, 'link')));

  const tab = {
    id, kind, label, term, fit, search,
    tabEl, pane, status: 'running', exitCode: null,
    sentCols: null, sentRows: null,
    meta: null, loader: null, loaderTimer: null,
  };

  term.open(pane);
  tab.loader = createPaneLoader(pane, kind);
  tab.loaderTimer = setTimeout(() => clearPaneLoader(tab), SESSION_LOADER_FAILSAFE_MS);
  // Double rAF: let the pane finish laying out before measuring, otherwise the
  // first fit uses a stale box and the TUI renders at the wrong size.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { fit.fit(); sendResize(tab); } catch { /* layout not ready */ }
  }));

  // Custom terminal fonts can settle after the first measure; re-fit once the
  // browser reports them ready so cols/rows match the real cell metrics.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready
      .then(() => {
        try {
          fit.fit();
          sendResize(tab);
          if (tab.term.rows > 0) tab.term.refresh(0, tab.term.rows - 1);
        } catch { /* disposed */ }
      })
      .catch(() => { /* ignore */ });
  }

  term.onData((data) => api.writeInput(id, data));
  term.onResize(({ cols, rows }) => {
    tab.sentCols = cols;
    tab.sentRows = rows;
    api.resizeTerminal(id, cols, rows);
  });
  term.onTitleChange((title) => { if (title) setTabLabel(tab, title); });
  term.attachCustomKeyEventHandler((e) => customKeyHandler(tab, e));

  const ro = new ResizeObserver(debounce(() => {
    try { fit.fit(); sendResize(tab); } catch { /* hidden */ }
  }, 80));
  ro.observe(pane);
  tab.ro = ro;

  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) {
      e.stopPropagation();
      closeTab(tab);
      return;
    }
    activateTab(tab.id);
  });

  pane.addEventListener('contextmenu', (e) => {
    if (isMac()) return;
    e.preventDefault();
    if (term.hasSelection()) {
      api.copyText(term.getSelection());
      term.clearSelection();
    } else {
      pasteClipboard();
    }
  });

  try {
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!state.searchOpen) return;
      $('#search-count').textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : 'no matches';
    });
  } catch { /* older search addon without result events */ }

  state.tabs.set(id, tab);

  // Replay whatever the PTY already produced before this tab existed. This
  // runs synchronously (no await above it), so it always precedes any later
  // pty:data event for the same session and the byte order is preserved.
  const pending = state.pendingPty.get(id);
  if (pending) {
    state.pendingPty.delete(id);
    if (pending.chunks.length) {
      const replayed = pending.chunks.join('');
      clearPaneLoader(tab);
      term.write(replayed);
      // The device-login URL can land in the very first chunks.
      if (tab.kind === 'login') watchLoginUrl(tab, replayed);
    }
    if (pending.exitCode !== null && pending.exitCode !== undefined) {
      markExited(tab, pending.exitCode);
    }
  }

  setTabLabel(tab, label);
  activateTab(id);
  return tab;
}

function customKeyHandler(tab, e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  // Combos we reserve for the app (handled at window level) — never let xterm see
  // them, but let the event bubble so the window handler performs the action.
  if (e.ctrlKey && e.shiftKey && /^[cCfFvV]$/.test(key)) return false;
  if (mod && key.toLowerCase() === 't' && !e.shiftKey) return false;
  if (e.ctrlKey && key === 'Tab') return false; // Ctrl+Shift+Tab included (cycle)
  if (mod && ['=', '+', '-', '0'].includes(key)) return false;

  // Ctrl+W intentionally passes through: in the terminal it's word-delete in the
  // TUI input; close-tab is handled at window level only when the terminal does
  // NOT have focus.

  // Paste: Ctrl+V on win/linux, Cmd+V on mac — handled fully here so it doesn't
  // double-fire at window level.
  if (!e.shiftKey && !e.altKey && key.toLowerCase() === 'v' && mod) {
    e.preventDefault();
    e.stopPropagation();
    pasteClipboard();
    return false;
  }
  // Copy on mac: Cmd+C
  if (isMac() && e.metaKey && !e.ctrlKey && !e.shiftKey && key.toLowerCase() === 'c') {
    if (tab.term.hasSelection()) {
      e.preventDefault();
      e.stopPropagation();
      api.copyText(tab.term.getSelection());
      return false;
    }
    return true; // no selection → let the terminal see Cmd+C
  }
  return true;
}

function setTabLabel(tab, label) {
  tab.label = label || tab.label;
  tab.tabEl.querySelector('.tab-label').textContent = tab.label;
  tab.tabEl.title = tab.label;
}

function activateTab(id) {
  state.activeTabId = id;
  for (const [tid, t] of state.tabs) {
    const active = tid === id;
    t.tabEl.classList.toggle('active', active);
    t.pane.style.display = active ? 'block' : 'none';
    if (active) {
      t.term.focus();
      requestAnimationFrame(() => {
        try {
          t.fit.fit();
          sendResize(t);
          // Force a clean repaint so switching tabs can't leave stale rows behind.
          if (t.term.rows > 0) t.term.refresh(0, t.term.rows - 1);
        } catch { /* hidden */ }
      });
    }
  }
  // A terminal is on stage — the welcome placeholder has no business showing.
  const welcome = $('#welcome');
  if (welcome) welcome.classList.add('hidden');
}

function sendResize(tab) {
  const cols = tab.term.cols;
  const rows = tab.term.rows;
  if (!cols || !rows) return;
  // Redundant resizes make ConPTY repaint the screen, which garbles the TUI —
  // only forward genuine size changes.
  if (tab.sentCols === cols && tab.sentRows === rows) return;
  tab.sentCols = cols;
  tab.sentRows = rows;
  api.resizeTerminal(tab.id, cols, rows);
}

function cycleTab(dir) {
  const ids = [...state.tabs.keys()];
  if (!ids.length) return;
  const idx = ids.indexOf(state.activeTabId);
  const next = ids[(idx + dir + ids.length) % ids.length];
  activateTab(next);
}

async function closeTab(tab) {
  if (tab.loaderTimer) { clearTimeout(tab.loaderTimer); tab.loaderTimer = null; }
  if (tab.status === 'running') {
    await api.killSession(tab.id);
  }
  tab.ro.disconnect();
  tab.term.dispose();
  tab.tabEl.remove();
  tab.pane.remove();
  state.tabs.delete(tab.id);
  if (state.activeTabId === tab.id) {
    const ids = [...state.tabs.keys()];
    if (ids.length) activateTab(ids[ids.length - 1]);
    else state.activeTabId = null;
  }
  refreshSessions();
}

function closeActiveTab() {
  if (state.activeTabId) closeTab(state.tabs.get(state.activeTabId));
}

function markExited(tab, exitCode) {
  clearPaneLoader(tab); // never leave the cover over an exit chip
  tab.status = 'exited';
  tab.exitCode = exitCode;
  tab.tabEl.classList.add('exited');
  const badge = tab.tabEl.querySelector('.tab-status-badge');
  badge.textContent = `ended (${exitCode == null ? '?' : exitCode})`;
  const chip = document.createElement('div');
  chip.className = 'exit-chip';
  chip.innerHTML = `
    <span>Session ended${exitCode == null ? '' : ` — exit code ${exitCode}`}</span>
    <button class="btn ghost">Close tab</button>`;
  chip.querySelector('button').addEventListener('click', () => closeTab(tab));
  tab.pane.appendChild(chip);
  toast(tab.kind === 'login'
    ? (exitCode === 0 ? 'Signed in successfully' : 'Sign-in flow ended')
    : tab.kind === 'fork'
      ? (exitCode === 0 ? 'Fork complete — the copy is in Previous sessions' : 'Fork did not complete')
      : `Session ended (exit code ${exitCode == null ? '?' : exitCode})`,
    exitCode === 0 ? 'ok' : '');
}

// ---------------------------------------------------------------------------
// Session launching
// ---------------------------------------------------------------------------

// Gate for starting sessions. Self-heals: if detection failed at startup
// (e.g. the CLI was installed after the app launched, which left every
// session click dead until a restart), re-run detection once before giving up.
let kimiRecheckDone = false;
async function ensureKimi() {
  if (state.kimi && state.kimi.found) return true;
  if (!kimiRecheckDone) {
    kimiRecheckDone = true;
    const dot = $('#kimi-status-dot');
    dot.className = 'status-dot busy';
    $('#kimi-status-text').textContent = 'Detecting…';
    const det = await api.detectKimi(true);
    state.kimi = det;
    renderKimiStatus();
    renderStatusBar();
    renderWelcome(!det.found);
    if (det.found) { await refreshSessions(); return true; }
  }
  toast('Kimi Code CLI was not found. Install it or set the path in Settings.', 'error');
  openModal('modal-settings');
  return false;
}

async function startSession({ cwd, mode, resumeId, quickPrompt, kind, label, command, argv }) {
  const res = await api.startSession({
    cwd,
    mode: mode || 'default',
    resumeId: resumeId || '',
    quickPrompt: quickPrompt || '',
    command: command || '',
    // Literal kimi argv (e.g. `fork <id> -y`) for CLI subcommands that are not
    // session flags — the main process uses it as-is instead of buildArgs().
    argv: Array.isArray(argv) ? argv.map(String) : [],
  });
  if (res.error) {
    if (res.error === 'kimi-not-found') {
      toast('Kimi Code CLI was not found. Install it or set the path in Settings.', 'error');
      renderWelcome(true);
    } else if (res.error === 'resume-cancelled') {
      // The user declined to recreate the session's folder — nothing to report.
    } else if (res.error === 'resume-cwd-unknown' || res.error === 'resume-cwd-missing') {
      // kimi only resumes from the session's original directory, so say why
      // instead of opening a tab that immediately errors out.
      if (res.command) api.copyText(res.command);
      toast(`${res.message || 'kimi cannot resume this session from here.'}${res.command ? ' Resume command copied to the clipboard.' : ''}`, 'error');
      if (res.error === 'resume-cwd-unknown' && res.command) {
        toast(`Run it yourself: ${res.command}`, 'error');
      }
    } else {
      toast(`Failed to start session: ${res.error}`, 'error');
    }
    return null;
  }
  const tab = createTab({ id: res.tabId, label: label || defaultLabel(kind, res), kind: kind || 'interactive' });
  tab.meta = res;
  return tab;
}

function defaultLabel(kind, res) {
  if (kind === 'quick') return 'Quick task';
  if (kind === 'login') return 'Sign in';
  if (kind === 'resume') return 'Resumed session';
  return `New session${res.cwd ? ` · ${projectName(res.cwd)}` : ''}`;
}

async function startLogin() {
  if (!(await ensureKimi())) return;
  await startSession({ cwd: state.homeDir, kind: 'login', label: 'Sign in to Kimi', command: 'login' });
}

// `kimi login` prints a device-login URL/code and *also* tries to launch a
// browser itself. Inside a PTY — and especially when the CLI runs through WSL —
// that launch often fails silently, which left the sign-in tab showing a code
// but no page to enter it on. Watch the output and open the URL with the OS
// browser ourselves so the button actually completes the flow.

// Strip colour/CSI sequences so a styled URL still matches. OSC-8 hyperlinks
// carry the URL *inside* the escape sequence, so unwrap those to plain text
// first — stripping them outright would throw the URL away with the wrapper.
const OSC8_RE = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

// The CLI wraps this URL across terminal lines when the pane is narrow, so the
// scan buffer has all whitespace removed before matching. The trailing user code
// is pinned to its XXXX-XXXX shape so we never run on into following prose.
const LOGIN_URL_RE = /https?:\/\/[^\s"'`<>]*authorize_device\?user_code=[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/;

function watchLoginUrl(tab, text) {
  if (tab.loginUrlOpened) return;
  const flat = String(text).replace(OSC8_RE, '$1').replace(ANSI_RE, '').replace(/\s+/g, '');
  tab.loginScan = ((tab.loginScan || '') + flat).slice(-8000);
  const match = tab.loginScan.match(LOGIN_URL_RE);
  if (!match) return;
  tab.loginUrlOpened = true;
  tab.loginUrl = match[0];
  // The device code is on screen in this tab either way, so a machine with no
  // browser still finishes the flow by hand.
  openExternalSafe(match[0], 'sign-in page').then((res) => {
    if (res && res.ok !== false) toast('Opened the Kimi sign-in page in your browser', 'ok');
    else toast(`Open this URL to finish signing in: ${match[0]}`, 'ok');
  });
}

// ---------------------------------------------------------------------------
// Copy / paste / search
// ---------------------------------------------------------------------------

function activeTab() { return state.tabs.get(state.activeTabId) || null; }

function copySelection() {
  const tab = activeTab();
  if (!tab) return;
  const sel = tab.term.getSelection();
  if (sel) api.copyText(sel);
}

function pasteClipboard() {
  const tab = activeTab();
  if (!tab) return;
  api.readText().then((text) => {
    if (text) api.writeInput(tab.id, text);
  }).catch(() => { /* clipboard unavailable */ });
}

function toggleSearch() {
  const tab = activeTab();
  if (!tab) { return; }
  state.searchOpen = !state.searchOpen;
  $('#searchbar').classList.toggle('hidden', !state.searchOpen);
  if (state.searchOpen) {
    $('#search-input').value = '';
    $('#search-count').textContent = '';
    $('#search-input').focus();
  } else {
    tab.search.clearDecorations();
  }
}

function runSearch() {
  const tab = activeTab();
  if (!tab) return;
  const q = $('#search-input').value;
  if (!q) { $('#search-count').textContent = ''; return; }
  tab.search.findNext(q, {
    incremental: true,
    decorations: {
      matchBackground: state.settings.theme === 'light' ? '#DFDFDF' : '#3A3A3A',
      activeMatchBackground: state.settings.theme === 'light' ? '#BDBDBD' : '#5F5F5F',
      activeMatchColorOverviewRuler: state.settings.theme === 'light' ? '#2A2A2A' : '#DFDFDF',
    },
  });
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function openModal(id) {
  $(`#${id}`).classList.remove('hidden');
  const firstInput = $(`#${id}`).querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}

function closeModal(id) {
  $(`#${id}`).classList.add('hidden');
}

// In WSL mode the working directory is a Linux path typed into the field;
// on Windows it is chosen with a folder dialog (readonly field).
function configureCwdField(inputSel, browseSel, labelSel, value) {
  const input = $(inputSel);
  const browse = $(browseSel);
  const label = $(labelSel);
  input.value = value;
  if (isWsl()) {
    input.removeAttribute('readonly');
    input.placeholder = state.kimi.wsl.home || '/home/you';
    browse.classList.add('hidden');
    if (label) label.textContent = 'Working directory (Linux path inside WSL)';
  } else {
    input.setAttribute('readonly', 'readonly');
    input.placeholder = 'Select a folder…';
    browse.classList.remove('hidden');
    if (label) label.textContent = 'Working directory';
  }
}

async function openNewSessionModal() {
  if (!(await ensureKimi())) return;
  state.nsCwd = usableCwd(state.settings.defaultCwd) || (isWsl() ? state.kimi.wsl.home : state.homeDir);
  configureCwdField('#ns-cwd', '#ns-browse', '#ns-cwd-label', state.nsCwd);
  const modeRadio = $(`#ns-modes input[value="${state.settings.defaultMode || 'default'}"]`);
  if (modeRadio) modeRadio.checked = true;
  openModal('modal-new-session');
}

async function openQuickTaskModal() {
  if (!(await ensureKimi())) return;
  state.qtCwd = usableCwd(state.settings.defaultCwd) || (isWsl() ? state.kimi.wsl.home : state.homeDir);
  configureCwdField('#qt-cwd', '#qt-browse', '#qt-cwd-label', state.qtCwd);
  $('#qt-prompt').value = '';
  openModal('modal-quick-task');
}

async function confirmNewSession() {
  const mode = document.querySelector('#ns-modes input:checked').value;
  closeModal('modal-new-session');
  const tab = await startSession({
    cwd: state.nsCwd,
    mode,
    kind: 'interactive',
    label: `New session${state.nsCwd ? ` · ${projectName(state.nsCwd)}` : ''}`,
  });
  if (tab) {
    state.settings.defaultCwd = state.nsCwd;
    api.setSettings({ defaultCwd: state.nsCwd });
  }
}

async function confirmQuickTask() {
  const prompt = $('#qt-prompt').value.trim();
  if (!prompt) { toast('Enter a prompt first.', 'error'); return; }
  closeModal('modal-quick-task');
  const tab = await startSession({
    cwd: state.qtCwd,
    quickPrompt: prompt,
    kind: 'quick',
    label: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
  });
  if (tab) state.settings.defaultCwd = state.qtCwd, api.setSettings({ defaultCwd: state.qtCwd });
}

// ---------------------------------------------------------------------------
// Kimi CLI config.toml editor
// ---------------------------------------------------------------------------

async function loadConfigIntoView({ force = false } = {}) {
  const editor = $('#cfg-content');
  const pathEl = $('#cfg-path');
  const statusEl = $('#cfg-status');
  // Never throw away edits just because the tab was re-entered.
  if (state.cfgDirty && !force) {
    statusEl.className = 'config-status';
    statusEl.textContent = 'Unsaved changes — Save to write them, or Reload to discard.';
    return;
  }
  statusEl.className = 'config-status';
  statusEl.textContent = 'Loading…';
  const res = await api.readConfig();
  // Display-only: swap the OS account name for ~ / %USERPROFILE% (see genericPath).
  pathEl.textContent = genericPath(res.path) || '(unknown)';
  pathEl.title = genericPath(res.path);
  if (res.error) {
    editor.value = '';
    state.cfgLoaded = true;
    state.cfgDirty = false;
    statusEl.className = 'config-status err';
    statusEl.textContent = res.error;
    return;
  }
  editor.value = res.content || '';
  state.cfgLoaded = true;
  state.cfgDirty = false;
  statusEl.textContent = res.exists
    ? 'Loaded from disk.'
    : 'No config.toml yet — saving will create it.';
}

// Kept for the File ▸ “Edit Kimi config.toml…” menu item: opens Settings with
// the config.toml tab already active and the file already loaded.
async function openConfigModal() {
  await openSettingsModal('config');
}

async function saveConfigFromModal() {
  const button = $('#cfg-save');
  const statusEl = $('#cfg-status');
  button.disabled = true;
  const res = await api.writeConfig($('#cfg-content').value);
  button.disabled = false;
  if (res.ok) {
    state.cfgDirty = false;
    state.cfgLoaded = true;
    statusEl.className = 'config-status ok';
    statusEl.textContent = `Saved — ${genericPath(res.path)}. New sessions pick this up.`;
    toast('config.toml saved — applies to new sessions', 'ok');
  } else {
    statusEl.className = 'config-status err';
    statusEl.textContent = res.error || 'Could not save config.toml.';
    toast('Could not save config.toml', 'error');
  }
}

// ---------------------------------------------------------------------------
// Settings modal — tab strip
// ---------------------------------------------------------------------------

const SETTINGS_TABS = ['config', 'appearance', 'sessions', 'cli', 'account'];

function setSettingsTab(name) {
  const tab = SETTINGS_TABS.includes(name) ? name : 'config';
  state.settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach((el) => {
    el.setAttribute('aria-selected', el.dataset.tab === tab ? 'true' : 'false');
  });
  document.querySelectorAll('#settings-scroll > [data-panel]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.panel !== tab);
  });
  const scroll = $('#settings-scroll');
  if (scroll) scroll.scrollTop = 0;
  // The config.toml tab is self-loading: switching to it already shows the file.
  if (tab === 'config') {
    if (!state.cfgLoaded || !state.cfgDirty) loadConfigIntoView();
    requestAnimationFrame(() => {
      const ed = $('#cfg-content');
      if (ed && !state.cfgDirty) ed.focus();
    });
  }
}

function wireSettingsTabs() {
  document.querySelectorAll('.settings-tab').forEach((el) => {
    el.addEventListener('click', () => setSettingsTab(el.dataset.tab));
  });
}

// ---------------------------------------------------------------------------
// Settings — theme
// ---------------------------------------------------------------------------

function applyThemeValue(value) {
  const theme = value === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  for (const t of state.tabs.values()) {
    t.term.options.theme = terminalTheme(theme);
  }
}

function applyTheme() {
  applyThemeValue(state.settings.theme);
}

// ---------------------------------------------------------------------------
// Terminal appearance
// ---------------------------------------------------------------------------

// One source of truth for the colours the terminal paints with: they are read
// back from the same CSS tokens the chrome uses, so light/dark (and any future
// palette edit) can never leave the terminal behind the rest of the window.
//
// This matters for more than looks: the Kimi TUI paints no background of its own
// (it emits no 48;2; / 48;5; / ESC[4Nm sequence — checked against the CLI binary),
// so it inherits xterm's. Pane, xterm and tab all resolve to --terminal-bg, which
// is what makes a visible seam around the CLI's output structurally impossible.
function cssToken(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

function terminalTheme(themeValue) {
  const name = themeValue === 'light' || themeValue === 'dark'
    ? themeValue
    : (state.settings.theme === 'light' ? 'light' : 'dark');
  const base = THEMES[name] || THEMES.dark;
  return {
    ...base,
    background: cssToken('--terminal-bg', base.background),
    foreground: cssToken('--text', base.foreground),
    cursor: cssToken('--text', base.cursor),
    cursorAccent: cssToken('--terminal-bg', base.cursorAccent),
    selectionBackground: cssToken('--border-strong', base.selectionBackground),
    selectionInactiveBackground: cssToken('--accent-soft', base.selectionBackground),
    // xterm draws its own scrollbar (a VS Code-style widget) and takes its
    // colours from the theme, so the app's scrollbar tokens reach it here
    // instead of through the global ::-webkit-scrollbar rules.
    scrollbarSliderBackground: cssToken('--scrollbar-thumb', 'rgba(223,223,223,.2)'),
    scrollbarSliderHoverBackground: cssToken('--scrollbar-thumb-hover', 'rgba(223,223,223,.35)'),
    scrollbarSliderActiveBackground: cssToken('--scrollbar-thumb-hover', 'rgba(223,223,223,.5)'),
    black: cssToken('--bg-hover', base.black),
    red: cssToken('--red', base.red),
    green: cssToken('--green', base.green),
    yellow: cssToken('--yellow', base.yellow),
    white: cssToken('--text', base.white),
    brightBlack: cssToken('--border-strong', base.brightBlack),
    brightRed: cssToken('--red', base.brightRed),
    brightGreen: cssToken('--green', base.brightGreen),
    brightYellow: cssToken('--yellow', base.brightYellow),
  };
}

// 'panel' (default) frames the terminal as a card in the app chrome; 'classic'
// restores the pre-restyle edge-to-edge terminal. Exposed in Settings →
// Appearance so the change can be undone in the UI, without touching git.
function applyTerminalStyle() {
  document.body.classList.toggle('term-classic', state.settings.terminalStyle === 'classic');
  for (const t of state.tabs.values()) t.term.options.theme = terminalTheme();
  // The frame changes the pane's inner size, so re-fit once the new geometry has
  // been laid out — otherwise cols/rows describe the old, larger box.
  requestAnimationFrame(() => {
    for (const t of state.tabs.values()) {
      try { t.fit.fit(); sendResize(t); } catch { /* terminal closing */ }
    }
  });
}

function currentThemeValue() {
  const el = document.querySelector('input[name="st-theme"]:checked');
  return el ? el.value : (state.settings.theme === 'light' ? 'light' : 'dark');
}

function setThemeRadios(value) {
  const v = value === 'light' ? 'light' : 'dark';
  document.querySelectorAll('input[name="st-theme"]').forEach((el) => {
    el.checked = el.value === v;
  });
}

// ---------------------------------------------------------------------------
// Sidebar layout — resizable width + full collapse
// ---------------------------------------------------------------------------

const DEFAULT_SIDEBAR_W = 292;
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 560;

function sidebarWidthBounds() {
  const viewport = window.innerWidth || 1280;
  // Always leave at least ~420px of terminal next to the sidebar.
  const max = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, viewport - 420));
  return { min: SIDEBAR_MIN_W, max };
}

function applySidebarWidth(width, persist) {
  const { min, max } = sidebarWidthBounds();
  const w = Math.min(max, Math.max(min, Math.round(width || DEFAULT_SIDEBAR_W)));
  state.settings.sidebarWidth = w;
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  if (persist) api.setSettings({ sidebarWidth: w });
  return w;
}

function applySidebarCollapsed(collapsed, persist) {
  const on = collapsed === true;
  state.settings.sidebarCollapsed = on;
  document.body.classList.toggle('sidebar-collapsed', on);
  const btn = $('#btn-toggle-sidebar');
  if (btn) {
    const label = on ? 'Show sidebar (Ctrl+B)' : 'Hide sidebar (Ctrl+B)';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  if (persist) api.setSettings({ sidebarCollapsed: on });
  // The terminal just changed size — re-measure after layout settles.
  requestAnimationFrame(() => {
    const tab = activeTab();
    if (!tab) return;
    try { tab.fit.fit(); sendResize(tab); } catch { /* hidden */ }
  });
}

function toggleSidebar() {
  applySidebarCollapsed(!state.settings.sidebarCollapsed, true);
}

function wireSidebarSplitter() {
  const splitter = $('#sidebar-splitter');
  const sidebar = $('#sidebar');
  if (!splitter || !sidebar) return;

  const onMove = (e) => {
    const point = e.touches && e.touches.length ? e.touches[0] : e;
    const left = sidebar.getBoundingClientRect().left;
    applySidebarWidth(point.clientX - left, false);
  };

  const stop = () => {
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', stop);
    // Persist only once the drag ends.
    api.setSettings({ sidebarWidth: state.settings.sidebarWidth });
    const tab = activeTab();
    if (tab) { try { tab.fit.fit(); sendResize(tab); } catch { /* hidden */ } }
  };

  const start = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', stop);
  };

  splitter.addEventListener('mousedown', start);
  splitter.addEventListener('touchstart', start, { passive: false });
  splitter.addEventListener('dblclick', () => applySidebarWidth(DEFAULT_SIDEBAR_W, true));

  // Keyboard resize (the splitter is focusable).
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 12;
    const cur = state.settings.sidebarWidth || DEFAULT_SIDEBAR_W;
    if (e.key === 'ArrowLeft') { e.preventDefault(); applySidebarWidth(cur - step, true); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); applySidebarWidth(cur + step, true); }
  });

  // Keep the sidebar within bounds when the window is resized.
  window.addEventListener('resize', () => applySidebarWidth(state.settings.sidebarWidth || DEFAULT_SIDEBAR_W, false));
}

async function openSettingsModal(tab) {
  const s = state.settings;
  $('#st-kimi-path').value = s.kimiPath || '';
  $('#st-kimi-home').value = s.kimiCodeHome || '';
  $('#st-shell-path').value = s.shellPath || '';
  // Where the CLI usually lives, so the user can find/verify it by hand: the
  // detected path above already covers this machine, so list this platform's
  // usual spot only when nothing was detected, plus the other systems' spots.
  const CANDIDATE_HINTS = {
    win32: '%USERPROFILE%\\AppData\\Local\\Programs\\kimi\\kimi.exe',
    darwin: '/opt/homebrew/bin/kimi',
    linux: '~/.local/bin/kimi',
  };
  const herePlatform = state.platform === 'darwin' ? 'darwin' : (state.platform === 'win32' ? 'win32' : 'linux');
  const platformLabel = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const hintRows = [];
  if (!(state.kimi && state.kimi.found)) hintRows.push(`${platformLabel[herePlatform]}: ${CANDIDATE_HINTS[herePlatform]}`);
  for (const p of ['win32', 'darwin', 'linux']) {
    if (p === herePlatform) continue;
    hintRows.push(`${platformLabel[p]}: ${CANDIDATE_HINTS[p]}`);
  }
  $('#st-kimi-candidates').innerHTML = hintRows
    .map((t) => `<span class="candidate-path">${esc(t)}</span>`)
    .join('<br />');
  $('#st-default-cwd').value = s.defaultCwd || '';
  $('#st-default-mode').value = s.defaultMode || 'default';
  $('#st-font-size').value = s.fontSize || 13;
  $('#st-scrollback').value = s.scrollback || 10000;
  $('#st-term-style').value = s.terminalStyle === 'classic' ? 'classic' : 'panel';
  $('#st-font-family').value = s.fontFamily || '';
  setThemeRadios(s.theme || 'dark');
  const ver = state.kimi && state.kimi.found
    ? `Detected: v${state.kimi.version} at ${genericPath(state.kimi.path)}${isWsl() ? ` (WSL · ${state.kimi.wsl.distro})` : ''}`
    : 'Not detected — leave empty for auto-detection.';
  $('#st-kimi-version').textContent = ver;

  // Account actions.
  const signedIn = state.kimi && state.kimi.found;
  $('#st-account-status').textContent = signedIn
    ? 'Only needed if the CLI is not signed in yet.'
    : 'Kimi Code CLI was not detected — install it first.';
  $('#st-signin').disabled = !signedIn;
  // WSL: cwd is a Linux path; hide the Windows folder dialog.
  configureCwdField('#st-default-cwd', '#st-default-cwd-browse', '#st-cwd-label', usableCwd(s.defaultCwd) || (isWsl() ? state.kimi.wsl.home : state.homeDir));
  const homeHint = isWsl()
    ? 'Linux path inside WSL (e.g. /home/you/.kimi-code). It is mapped to the WSL filesystem automatically.'
    : 'Where Kimi stores sessions, config and credentials. Changing this switches to a different session history.';
  $('#st-kimi-home-hint').textContent = homeHint;
  openModal('modal-settings');
  // No explicit tab (gear click) → reopen the last one used; config.toml loads
  // itself whenever it becomes the active tab.
  setSettingsTab(tab === undefined ? (state.settingsTab || 'config') : tab);
}

async function saveSettingsFromModal() {
  const oldKimiPath = state.settings.kimiPath || '';
  const oldKimiHome = state.settings.kimiCodeHome || '';
  const patch = {
    kimiPath: $('#st-kimi-path').value.trim(),
    kimiCodeHome: $('#st-kimi-home').value.trim(),
    shellPath: $('#st-shell-path').value.trim(),
    defaultCwd: $('#st-default-cwd').value.trim(),
    defaultMode: $('#st-default-mode').value,
    fontSize: clampNum($('#st-font-size').value, 8, 24, 13),
    theme: currentThemeValue(),
    scrollback: clampNum($('#st-scrollback').value, 1000, 100000, 10000),
    fontFamily: $('#st-font-family').value.trim(),
    terminalStyle: $('#st-term-style').value === 'classic' ? 'classic' : 'panel',
  };
  state.settings = { ...state.settings, ...patch };
  const saved = api.setSettings(patch);
  closeModal('modal-settings');
  applyTheme();
  applyTerminalStyle();
  renderKimiStatus();
  // Re-apply terminal options to open terminals
  for (const t of state.tabs.values()) {
    t.term.options.fontSize = patch.fontSize;
    t.term.options.fontFamily = patch.fontFamily || FONT_STACK;
    t.term.options.scrollback = patch.scrollback;
    try { t.fit.fit(); sendResize(t); } catch { /* noop */ }
  }
  if (patch.kimiCodeHome !== oldKimiHome) {
    // The session folder changed: live sessions still run with the old
    // KIMI_CODE_HOME env, so a full window reload re-boots the app against
    // the new folder — the change is immediately visible (and verifiable)
    // without a manual restart.
    try { await saved; } catch { /* reload shows any persist error anyway */ }
    await api.reloadWindow();
    return;
  }
  if (patch.kimiPath !== oldKimiPath) {
    // Re-detect / re-scan against the new CLI path
    reDetect();
    return;
  }
  refreshSessions();
  toast('Settings saved', 'ok');
}

function clampNum(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

async function reDetect() {
  const dot = $('#kimi-status-dot');
  dot.className = 'status-dot busy';
  $('#kimi-status-text').textContent = 'Detecting…';
  const det = await api.detectKimi(true);
  state.kimi = det;
  renderKimiStatus();
  renderStatusBar();
  renderWelcome(!det.found);
  if (det.found) await refreshSessions();
  toast(det.found ? `Detected kimi v${det.version}` : 'Kimi Code CLI still not found.', det.found ? 'ok' : 'error');
}

function changeFontSize(delta) {
  const cur = state.settings.fontSize || 13;
  setFontSize(Math.min(24, Math.max(8, cur + delta)));
}

function setFontSize(size) {
  state.settings.fontSize = size;
  api.setSettings({ fontSize: size });
  for (const t of state.tabs.values()) {
    t.term.options.fontSize = size;
    try { t.fit.fit(); sendResize(t); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------

function isTypingTarget(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function inModal() {
  return !!document.querySelector('.modal-backdrop:not(.hidden)');
}

function isTerminalFocused() {
  const t = document.activeElement;
  return t && t.className && String(t.className).includes('xterm-helper-textarea');
}

function onGlobalKeydown(e) {
  if (inModal()) return; // modals have their own inputs

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  const typing = isTypingTarget(e);

  // Ctrl+Tab / Ctrl+Shift+Tab — cycle sessions (works anywhere, even in terminal
  // because the terminal custom handler lets this one bubble).
  if (e.ctrlKey && key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
    return;
  }

  if (mod && key.toLowerCase() === 't' && !e.shiftKey && !typing) {
    e.preventDefault();
    void openNewSessionModal();
    return;
  }
  if (mod && key.toLowerCase() === 'w' && !e.shiftKey && !typing && !isTerminalFocused()) {
    e.preventDefault();
    closeActiveTab();
    return;
  }
  if (mod && e.shiftKey && key.toLowerCase() === 'f' && !typing) {
    e.preventDefault();
    toggleSearch();
    return;
  }
  if (mod && e.shiftKey && key.toLowerCase() === 'c' && !typing) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (mod && e.shiftKey && key.toLowerCase() === 'v' && !typing) {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (mod && !e.shiftKey && key.toLowerCase() === 'v' && !isMac() && !typing && isTerminalFocused()) {
    // Ctrl+V paste inside the terminal (handled here when the custom key
    // handler didn't already take it)
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (mod && ['=', '+'].includes(key) && !typing) { e.preventDefault(); changeFontSize(1); return; }
  if (mod && key === '-' && !typing) { e.preventDefault(); changeFontSize(-1); return; }
  if (mod && key === '0' && !typing) { e.preventDefault(); setFontSize(13); return; }
  if (mod && !e.shiftKey && key.toLowerCase() === 'b' && !typing) {
    e.preventDefault();
    toggleSidebar();
    return;
  }
}

// ---------------------------------------------------------------------------
// Wire up static UI
// ---------------------------------------------------------------------------

function wireWindowControls() {
  const controls = api.windowControls;
  if (!controls) return;
  // macOS keeps its native traffic lights — nothing to wire.
  if (state.platform === 'darwin') return;

  $('#win-min').addEventListener('click', () => controls.minimize());
  $('#win-max').addEventListener('click', () => controls.toggleMaximize());
  $('#win-close').addEventListener('click', () => controls.close());
  $('#topbar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input')) return;
    controls.toggleMaximize();
  });

  const MAX_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>';
  const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.3" y="2.7" width="6" height="6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M3.4 2.5V2.2A1.2 1.2 0 014.6 1h3.1A1.2 1.2 0 019 2.2v3.1a1.2 1.2 0 01-1.2 1.2h-.4" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>';

  const syncMaximizeState = (isMaximized) => {
    const btn = $('#win-max');
    btn.title = isMaximized ? 'Restore' : 'Maximize';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = isMaximized ? RESTORE_ICON : MAX_ICON;
  };

  controls.onMaximizedChanged(syncMaximizeState);
  controls.isMaximized().then(syncMaximizeState).catch(() => { /* ignore */ });
}

function wireEvents() {
  // Custom title bar (window controls / drag)
  wireWindowControls();

  // Top bar
  $('#btn-new-session').addEventListener('click', openNewSessionModal);
  $('#btn-quick-task').addEventListener('click', openQuickTaskModal);
  $('#btn-add-tab').addEventListener('click', openNewSessionModal);

  // Title bar sidebar toggle + drag-to-resize splitter
  $('#btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  wireSidebarSplitter();

  // Settings gear (bottom-left of the sidebar, next to the kimi version).
  // Arrow-wrapped: openSettingsModal(tab) would otherwise receive the click event.
  $('#btn-settings').addEventListener('click', () => openSettingsModal());

  // Sidebar
  $('#btn-refresh-sessions').addEventListener('click', () => { refreshSessions(); toast('Session history refreshed', 'ok'); });
  $('#session-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderSessionList();
  });
  $('#session-list').addEventListener('scroll', closeSessionMenu, { passive: true });

  // Session action menu dismissals
  document.addEventListener('mousedown', (e) => {
    if (!state.sessionMenuFor) return;
    if (e.target.closest('#session-menu, .si-more')) return;
    closeSessionMenu();
  });
  window.addEventListener('resize', closeSessionMenu);
  window.addEventListener('blur', closeSessionMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.sessionMenuFor) {
      e.preventDefault();
      closeSessionMenu();
    }
  }, true);

  // New session modal
  $('#ns-cancel').addEventListener('click', () => closeModal('modal-new-session'));
  $('#ns-start').addEventListener('click', confirmNewSession);
  $('#ns-browse').addEventListener('click', async () => {
    const p = await api.pickFolder(state.nsCwd);
    if (p) { state.nsCwd = p; $('#ns-cwd').value = p; }
  });

  // Quick task modal
  $('#qt-cancel').addEventListener('click', () => closeModal('modal-quick-task'));
  $('#qt-run').addEventListener('click', confirmQuickTask);
  $('#qt-browse').addEventListener('click', async () => {
    const p = await api.pickFolder(state.qtCwd);
    if (p) { state.qtCwd = p; $('#qt-cwd').value = p; }
  });
  $('#qt-prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); confirmQuickTask(); }
  });

  // Settings modal — tab strip + live theme preview
  wireSettingsTabs();
  $('#st-cancel').addEventListener('click', () => {
    // Close without saving: drop any theme preview back to the stored value.
    applyTheme();
    closeModal('modal-settings');
  });
  $('#st-save').addEventListener('click', saveSettingsFromModal);
  document.querySelectorAll('input[name="st-theme"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) applyThemeValue(el.value);
    });
  });
  $('#st-signin').addEventListener('click', () => {
    // Hand off to a session tab so the device-code flow is visible there.
    closeModal('modal-settings');
    startLogin();
  });
  $('#st-kimi-browse').addEventListener('click', async () => {
    const p = await api.pickFile($('#st-kimi-path').value);
    if (p) $('#st-kimi-path').value = p;
  });
  $('#st-kimi-home-browse').addEventListener('click', async () => {
    const p = await api.pickFolder($('#st-kimi-home').value || state.kimiHome || state.homeDir);
    if (p) $('#st-kimi-home').value = p;
  });
  $('#st-kimi-detect').addEventListener('click', reDetect);
  $('#st-default-cwd-browse').addEventListener('click', async () => {
    const p = await api.pickFolder($('#st-default-cwd').value);
    if (p) $('#st-default-cwd').value = p;
  });

  // config.toml tab (inside Settings)
  $('#cfg-reload').addEventListener('click', () => loadConfigIntoView({ force: true }));
  $('#cfg-save').addEventListener('click', saveConfigFromModal);
  $('#cfg-content').addEventListener('input', () => {
    state.cfgDirty = true;
    const statusEl = $('#cfg-status');
    statusEl.className = 'config-status';
    statusEl.textContent = 'Unsaved changes — Save (Ctrl+S) writes them to disk.';
  });
  $('#cfg-template').addEventListener('click', () => {
    const editor = $('#cfg-content');
    if (editor.value.trim()) {
      toast('Editor already has content — clear it first.', 'error');
      return;
    }
    editor.value = CONFIG_TEMPLATE;
    state.cfgDirty = true;
    const statusEl = $('#cfg-status');
    statusEl.className = 'config-status';
    statusEl.textContent = 'Unsaved changes — Save (Ctrl+S) writes them to disk.';
    editor.focus();
  });
  $('#cfg-content').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveConfigFromModal();
    }
  });

  // Backdrop click closes modals
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target !== backdrop) return;
      if (backdrop.id === 'modal-settings') applyTheme(); // drop theme preview
      backdrop.classList.add('hidden');
    });
  });

  // Search bar
  $('#search-input').addEventListener('input', runSearch);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) activeTab()?.search.findPrevious($('#search-input').value);
      else runSearch();
    } else if (e.key === 'Escape') {
      toggleSearch();
    }
  });
  $('#search-next').addEventListener('click', () => { const q = $('#search-input').value; if (q) activeTab()?.search.findNext(q); });
  $('#search-prev').addEventListener('click', () => { const q = $('#search-input').value; if (q) activeTab()?.search.findPrevious(q); });
  $('#search-close').addEventListener('click', toggleSearch);

  window.addEventListener('keydown', onGlobalKeydown);
}

// Debug/test handle (used by scripts/e2e-test.js; harmless in production)
window.__kcd = {
  state,
  createTab,
  activateTab,
  closeTab,
  refreshSessions,
  renderSessionList,
  startSession,
  startLogin,
  openNewSessionModal,
  openQuickTaskModal,
  openSettingsModal,
  openConfigModal,
  saveConfigFromModal,
  toggleSidebar,
  applySidebarWidth,
  applySidebarCollapsed,
  loadConfigIntoView,
  setSettingsTab,
  applyThemeValue,
  openSessionMenu,
  closeSessionMenu,
  forkSession,
  exportSession,
};

init();