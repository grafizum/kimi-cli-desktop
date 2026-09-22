'use strict';

// Guest preload for the chat <webview> — runs INSIDE the embedded Kimi web UI
// before any of its scripts. Two jobs, both hint-only (the UI keeps working if
// any of this fails):
//
// 1. Appearance + onboarding seeds. The web UI reads `kimi-web.color-scheme`
//    and `kimi-web.font-scale` from localStorage in its boot.js pre-paint
//    (verified against the kimi 2.0.2 bundle); seeding them means the chat
//    comes up in the SAME theme and density the user picked for the desktop
//    app. The served URL also carries ?kimi_onboarded=1 (the UI's official
//    skip); seeding the flag covers partitions holding stale state.
//
// 2. TUI-thinking mode (the shell's "terminal feel" ask). In the CLI's
//    terminal UI the model's reasoning streams FULLY VISIBLE while it thinks;
//    the web UI collapses every thinking block to a small pill and re-collapses
//    it the moment streaming ends (verified in the 2.0.2 bundle: the block's
//    state watcher sets open=false on the streaming→idle edge, and the open
//    state is per-session component state — not a localStorage pref — so it
//    cannot be seeded). When the shell asks for TUI mode, this preload watches
//    the DOM and keeps blocks expanded the way the terminal shows them:
//      - a block that gains the `streaming` class is clicked open once;
//      - a block that LOSES `streaming` (the auto-collapse edge) is clicked
//        open again, once, so the finished reasoning stays readable;
//      - Alt+click on a block marks it user-managed: the enhancer never
//        touches that block again, so collapsing/expanding by hand works.
//    Only real header clicks are synthesized (the same handler the user's
//    click runs), and only on state CHANGES, so the loop cost is ~nothing.
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
    if (localStorage.getItem('kimi-web.onboarded') !== '1') {
      localStorage.setItem('kimi-web.onboarded', '1');
    }
  } catch { /* storage disabled — the UI keeps its own defaults */ }

  // --- TUI-thinking mode ----------------------------------------------------
  if (appearance && appearance.tuiThinking) {
    const userManaged = new WeakSet(); // blocks the user took over via Alt+click
    let scanning = false;

    function clickHeader(block) {
      const head = block.querySelector('.think-head');
      if (head instanceof HTMLElement) head.click();
    }

    function isOpen(block) {
      return block.classList.contains('open');
    }

    function enforceTui(block) {
      if (userManaged.has(block)) return;
      const streaming = block.classList.contains('streaming');
      // Open while streaming (with the TUI's live-scroll behavior), and
      // re-open once on the streaming→finished edge (the UI's auto-collapse).
      if ((streaming || block.dataset.tuiWasStreaming === '1') && !isOpen(block)) {
        clickHeader(block);
      }
      block.dataset.tuiWasStreaming = streaming ? '1' : '0';
    }

    function scan(root) {
      if (scanning) return;
      scanning = true;
      queueMicrotask(() => {
        scanning = false;
        try {
          const blocks = (root instanceof Element ? root : document)
            .querySelectorAll('.think:not([data-tui])');
          for (const b of blocks) {
            b.dataset.tui = '1';
            if (b.classList.contains('streaming') || b.dataset.tuiWasStreaming === '1') enforceTui(b);
          }
        } catch { /* a detached node raced us — the next mutation rescan covers it */ }
      });
    }

    document.addEventListener('click', (e) => {
      try {
        if (!(e.altKey)) return;
        const head = e.target && e.target.closest ? e.target.closest('.think-head') : null;
        const block = head && head.closest('.think');
        if (block) {
          userManaged.add(block); // Alt+click = "I'll drive this one myself"
          block.dataset.tui = 'manual';
        }
      } catch { /* never break the guest's own handlers */ }
    }, true);

    const start = () => {
      try {
        scan(document);
        new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'attributes' && m.target instanceof Element
              && m.target.classList.contains('think')) {
              enforceTui(m.target); // streaming edge — cheap, targeted
            } else if (m.type === 'childList') {
              scan(m.target);
            }
          }
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      } catch { /* body not ready — DOMContentLoaded retry below */ }
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }
} catch {
  /* bridge unavailable — never break the guest page over a preference hint */
}
