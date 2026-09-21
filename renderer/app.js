'use strict';

// Kimi Code Desktop — WEB EDITION renderer.
// The entire UI is the Kimi CLI's own web UI in one <webview>. This file only
// drives the lifecycle around it: request the server, show state cards while
// it is absent, load the URL when it is up, and keep the guest pixel-synced to
// the window (the Electron webview sizing contract — see syncChatSize).

const api = window.kimiDesktop;

const el = {
  badge: document.getElementById('tb-badge'),
  statusLeft: document.getElementById('status-left'),
  statusRight: document.getElementById('status-right'),
  noKimi: document.getElementById('no-kimi'),
  installCmd: document.getElementById('install-cmd'),
  detectHint: document.getElementById('detect-hint'),
  starting: document.getElementById('starting'),
  startingDetail: document.getElementById('starting-detail'),
  errorState: document.getElementById('error-state'),
  errorDetail: document.getElementById('error-detail'),
  chat: document.getElementById('chat'),
};

let lastLoadedUrl = '';   // the URL currently in the webview (dedupe reloads)
let lastFatalError = '';  // what the error card is showing

// ---------------------------------------------------------------------------
// State cards
// ---------------------------------------------------------------------------

function showCard(which) {
  el.noKimi.hidden = which !== 'no-kimi';
  el.starting.hidden = which !== 'starting';
  el.errorState.hidden = which !== 'error';
  // The live webview stays laid out underneath every card (visibility rule in
  // styles.css); it only becomes visible when a URL is actually loaded.
  el.chat.classList.toggle('webview-live', which === 'chat' && !!lastLoadedUrl);
}

function renderStatus(st) {
  const kimi = st.kimi || {};
  const found = !!(st.running || st.starting || kimi.found);

  // Status bar
  el.statusLeft.textContent = kimi.found
    ? `kimi ${kimi.version || ''}${st.wsl ? ` · ${st.wsl.distro}` : ''}`
    : 'Kimi Code CLI not found';
  el.statusRight.textContent = st.running
    ? 'chat · localhost'
    : (st.starting ? 'starting…' : (found ? '' : 'waiting for the CLI'));

  // Title-bar badge: WSL mode (the CLI runs inside the distro)
  if (st.wsl) {
    el.badge.textContent = st.wsl.distro || 'WSL';
    el.badge.hidden = false;
  } else {
    el.badge.hidden = true;
  }

  // Cards
  if (st.running && st.url) {
    loadChat(st.url);
    showCard('chat');
  } else if (st.starting) {
    showCard('starting');
    el.startingDetail.textContent = kimi.found
      ? `Launching ${kimi.path || 'the CLI'}'s web interface on localhost.`
      : 'Launching the CLI\'s web interface on localhost.';
  } else if (!kimi.found) {
    showCard('no-kimi');
    el.detectHint.textContent = kimi.pending
      ? 'Checking this machine for the CLI…'
      : `Looked in ${Array.isArray(kimi.checked) && kimi.checked.length ? kimi.checked.length : 'all the usual'} locations on PATH, npm and WSL.`;
  } else if (st.lastError) {
    showCard('error');
    el.errorDetail.textContent = String(st.lastError);
  } else {
    showCard('starting');
  }
}

// ---------------------------------------------------------------------------
// The chat webview
// ---------------------------------------------------------------------------

function loadChat(url) {
  if (!url || url === lastLoadedUrl) {
    if (url && el.chat.getAttribute('src')) showCard('chat');
    return;
  }
  lastLoadedUrl = url;
  try {
    el.chat.setAttribute('src', url);
  } catch { /* webview not ready — dom-ready wiring will retry */ }
  showCard('chat');
}

function syncChatSize() {
  const stage = document.getElementById('stage');
  if (!stage || !el.chat) return;
  const r = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (el.chat.style.width !== `${w}px`) el.chat.style.width = `${w}px`;
  if (el.chat.style.height !== `${h}px`) el.chat.style.height = `${h}px`;
}

// Always laid out (the CSS keeps it visibility:hidden until live) so Electron
// never attaches the guest at 0x0 — the black-rectangle bug.
new ResizeObserver(() => syncChatSize()).observe(document.getElementById('stage'));
window.addEventListener('resize', syncChatSize);

el.chat.addEventListener('dom-ready', () => {
  syncChatSize();
  try { el.chat.focus(); } catch { /* not focusable yet */ }
});
el.chat.addEventListener('did-fail-load', (e) => {
  if (!e.isMainFrame) return; // subframe misses are normal (fonts, telemetry)
  lastLoadedUrl = ''; // a retry must actually navigate again
  api.ensureWeb().then(renderStatus);
});
el.chat.addEventListener('render-process-gone', () => {
  lastLoadedUrl = '';
  api.ensureWeb().then(renderStatus);
});
el.chat.addEventListener('page-title-updated', (e) => {
  // The guest is the app's face; surface its title in the shell chrome.
  if (e.title) document.title = e.title;
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

document.getElementById('btn-recheck').addEventListener('click', async () => {
  await api.detectKimi(true);
  renderStatus(await api.ensureWeb());
});
document.getElementById('btn-retry').addEventListener('click', async () => {
  renderStatus(await api.restartWeb());
});
document.getElementById('btn-copy-cmd').addEventListener('click', () => {
  api.copyText(el.installCmd.textContent.trim());
});

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

document.getElementById('win-min').addEventListener('click', () => api.windowControls.minimize());
document.getElementById('win-max').addEventListener('click', async () => {
  const max = await api.windowControls.toggleMaximize();
  document.body.classList.toggle('maximized', !!max);
});
api.windowControls.onMaximizedChanged((max) => document.body.classList.toggle('maximized', !!max));
document.getElementById('win-close').addEventListener('click', () => api.windowControls.close());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  const boot = await api.getBootstrap();
  document.body.dataset.theme = boot.settings && boot.settings.theme === 'light' ? 'light' : 'dark';
  if (boot.testHarness) {
    el.badge.textContent = 'TEST RUN';
    el.badge.hidden = false;
    document.title = 'Kimi Code Desktop [TEST RUN]';
  }
  if (boot.kimi && boot.kimi.pending) {
    api.onKimiDetected((det) => renderStatus({ kimi: det }));
  }
  renderStatus(await api.ensureWeb());
  api.onWebStatus(renderStatus);
  syncChatSize();
})();
