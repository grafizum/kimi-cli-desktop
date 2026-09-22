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
// Window title
// ---------------------------------------------------------------------------
// The title always says what the app is doing. While a lifecycle card is up
// (starting / setup / error) the shell owns the title and describes the state;
// once the chat is live the guest's own title takes over completely.

const BASE_TITLE = 'Kimi Code Desktop';
let chatLive = false; // the guest is showing — it owns the title
let chatTitle = '';   // last title the guest reported

function updateTitle(st) {
  if (chatLive) {
    if (chatTitle) document.title = chatTitle;
    return;
  }
  const kimi = st.kimi || {};
  const found = !!(st.running || st.starting || kimi.found);
  if (st.running) document.title = `${BASE_TITLE} — connecting…`;
  else if (st.starting) document.title = `${BASE_TITLE} — starting the CLI…`;
  else if (!found) document.title = kimi.pending
    ? `${BASE_TITLE} — looking for the CLI…`
    : `${BASE_TITLE} — CLI not found`;
  else if (st.lastError) document.title = `${BASE_TITLE} — couldn't start the chat`;
  else document.title = BASE_TITLE;
}

// ---------------------------------------------------------------------------
// State cards
// ---------------------------------------------------------------------------

function showCard(which) {
  el.noKimi.hidden = which !== 'no-kimi';
  el.starting.hidden = which !== 'starting';
  el.errorState.hidden = which !== 'error';
  // The live webview stays laid out underneath every card (visibility rule in
  // styles.css); it only becomes visible when a URL is actually loaded.
  chatLive = which === 'chat' && !!lastLoadedUrl;
  el.chat.classList.toggle('webview-live', chatLive);
}

function renderStatus(st) {
  const kimi = st.kimi || {};
  const found = !!(st.running || st.starting || kimi.found);
  updateTitle(st);
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
  // The guest is the app's face; surface its title in the shell chrome — but
  // only while it is actually live, so a stale guest can't mask a state card.
  chatTitle = e.title || '';
  if (chatLive && chatTitle) document.title = chatTitle;
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
// Models & providers (config.toml editor)
// ---------------------------------------------------------------------------
// The kimi CLI picks its model/provider from <KIMI_CODE_HOME>/config.toml.
// This panel inserts correctly-shaped [providers.*] / [models.*] blocks —
// custom API platforms or a local llama served by Ollama / llama.cpp /
// LM Studio — and saves after validating the file with the CLI itself.

// Provider types accepted by kimi 2.0.2's config. NOTE: `openai` (NOT
// `openai_legacy`) — verified live: kimi infers the wire protocol from the
// provider type, while `openai_legacy` blocks fail with "must declare a wire
// protocol" unless every model also carries an explicit `protocol` field.
const MODEL_CAPS_DOC = {
  openai: 'OpenAI-compatible endpoints — Ollama (http://localhost:11434/v1), llama.cpp server (http://localhost:8080/v1), LM Studio (http://localhost:1234/v1), OpenRouter, OmniRoute (http://localhost:20128/v1), …',
  anthropic: 'Anthropic Claude API',
  gemini: 'Google Gemini API',
  kimi: 'Kimi / Moonshot platform',
};

const models = { modal: null, content: '' };

function openModels() {
  models.modal = document.getElementById('modal-models');
  models.modal.classList.remove('hidden');
  // One frame after un-hiding, mark .open so the fade/slide transition runs
  // (a display:none → block flip cannot animate on its own).
  requestAnimationFrame(() => requestAnimationFrame(() => models.modal.classList.add('open')));
  api.readConfig().then((res) => {
    models.content = res.content || '';
    document.getElementById('mp-config').value = models.content;
    setModelsStatus(`Loaded from ${res.path}${res.viaWsl ? ' (inside WSL)' : ''}${res.exists ? '' : ' — new file, save creates it'}.`);
  }).catch((err) => setModelsStatus(`Could not read the config: ${err.message || err}`, 'err'));
}

function closeModels() {
  if (!models.modal || models.modal.classList.contains('hidden')) return;
  // Animate out first, then hard-hide when the transition ends.
  models.modal.classList.remove('open');
  const backdrop = models.modal;
  const hide = () => { backdrop.classList.add('hidden'); backdrop.removeEventListener('transitionend', hide); };
  backdrop.addEventListener('transitionend', hide);
  setTimeout(hide, 260); // fallback if transitionend never fires
}

function setModelsStatus(text, kind) {
  const elStatus = document.getElementById('mp-status');
  elStatus.textContent = text;
  elStatus.className = `field-hint${kind ? ` ${kind}` : ''}`;
}

// Append a (commented) block to the editor. Idempotent: an existing block
// with the same name is pointed out instead of duplicated.
function insertProviderBlock() {
  const name = (document.getElementById('mp-name').value || '').trim().replace(/[^A-Za-z0-9_-]/g, '-') || 'my-provider';
  const type = document.getElementById('mp-type').value;
  const url = (document.getElementById('mp-url').value || '').trim();
  const key = (document.getElementById('mp-key').value || '').trim();
  const editor = document.getElementById('mp-config');
  if (editor.value.includes(`[providers.${name}]`)) {
    setModelsStatus(`A [providers.${name}] block already exists — edit it below instead.`, 'err');
    return;
  }
  const block = [
    ``,
    `[providers.${name}]`,
    `type = "${type}"          # ${MODEL_CAPS_DOC[type]}`,
    `base_url = "${url || 'http://localhost:11434/v1'}"`,
    ...(key ? [`api_key = "${key.replace(/"/g, '\\"')}"`] : []),
    ``,
  ].join('\n');
  editor.value = editor.value.replace(/\s*$/, '') + '\n' + block;
  setModelsStatus(`Provider block added — now add at least one model for it.`, 'ok');
}

function insertModelBlock() {
  const id = (document.getElementById('md-id').value || '').trim();
  const ctx = Math.max(1024, parseInt(document.getElementById('md-ctx').value, 10) || 32768);
  const caps = [];
  if (document.getElementById('md-think').checked) caps.push('thinking');
  if (document.getElementById('md-img').checked) caps.push('image_in');
  const editor = document.getElementById('mp-config');
  if (!id) { setModelsStatus('Enter the model id first (e.g. llama3.1:8b for Ollama).', 'err'); return; }
  const providerHint = (editor.value.match(/\[providers\.([A-Za-z0-9_-]+)\]/) || [])[1] || 'my-provider';
  if (editor.value.includes(`[models."${id}"]`)) {
    setModelsStatus(`A [models."${id}"] block already exists — edit it below instead.`, 'err');
    return;
  }
  const block = [
    ``,
    `[models."${id}"]`,
    `provider = "${providerHint}"`,
    `model = "${id}"`,
    `max_context_size = ${ctx}`,
    ...(caps.length ? [`capabilities = [${caps.map((c) => `"${c}"`).join(', ')}]`] : []),
    ``,
  ].join('\n');
  editor.value = editor.value.replace(/\s*$/, '') + '\n' + block;
  setModelsStatus(`Model block added. Save, then switch with /model in the chat.`, 'ok');
}

async function saveModels() {
  const content = document.getElementById('mp-config').value;
  // Validate with the CLI itself when possible — it is the consumer of the
  // file, so its parser is the truth. A CLI without validation still saves.
  setModelsStatus('Validating with the kimi CLI…');
  try {
    const res = await api.writeConfig(content);
    if (!res.ok) { setModelsStatus(`Save failed: ${res.error}`, 'err'); return; }
    setModelsStatus(`Saved to ${res.path}${res.viaWsl ? ' (inside WSL)' : ''} — start a new conversation (or /model in chat) to use it.`, 'ok');
    models.content = content;
    setTimeout(closeModels, 1600);
  } catch (err) {
    setModelsStatus(`Save failed: ${err.message || err}`, 'err');
  }
}

document.getElementById('btn-models').addEventListener('click', openModels);
document.getElementById('mp-add-provider').addEventListener('click', insertProviderBlock);
document.getElementById('mp-add-model').addEventListener('click', insertModelBlock);
document.getElementById('mp-save').addEventListener('click', saveModels);
document.getElementById('mp-cancel').addEventListener('click', closeModels);
document.getElementById('modal-models').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal-models') closeModels(); // backdrop click closes
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && models.modal && !models.modal.classList.contains('hidden')) closeModels();
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
