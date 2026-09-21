'use strict';

// Guest preload for the chat <webview> — runs INSIDE the embedded Kimi web UI
// before any of its scripts. The web UI reads `kimi-web.color-scheme` from
// localStorage in its boot.js pre-paint (verified against the kimi 2.0.2
// bundle); seeding it here means the chat comes up in the SAME theme the user
// picked for the desktop app, and its own theme step never shows a mismatched
// default. The value is fetched with synchronous IPC because this script must
// finish before the page's boot.js runs.
//
// Sandboxed preload: `electron` here exposes only the safe renderer APIs
// (ipcRenderer among them) — no Node, no fs, nothing else.

try {
  const { ipcRenderer } = require('electron');
  const appearance = ipcRenderer.sendSync('webui:get-appearance');
  const scheme = appearance && appearance.colorScheme === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem('kimi-web.color-scheme', scheme);
    document.documentElement.dataset.colorScheme = scheme;
    // Denser interface: the shell's chrome is compact, so the guest starts at
    // the web UI's own 'small' scale (boot.js honors it pre-paint). The user
    // can still change the scale inside the chat; this only sets the default.
    localStorage.setItem('kimi-web.font-scale', 'small');
    // The desktop app drives its own settings; the web UI's first-run
    // introduction (appearance pick, workspace walkthrough) is noise inside a
    // host that already has one. The served URL also carries ?kimi_onboarded=1
    // (the UI's official skip); seeding the flag here covers partitions that
    // already hold stale state from earlier launches.
    if (localStorage.getItem('kimi-web.onboarded') !== '1') {
      localStorage.setItem('kimi-web.onboarded', '1');
    }
  } catch { /* storage disabled — the UI keeps its own defaults */ }
} catch {
  /* bridge unavailable — never break the guest page over a preference hint */
}
