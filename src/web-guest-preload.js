'use strict';

// Guest preload for the chat <webview> — runs INSIDE the embedded Kimi web UI
// before any of its scripts. Everything here is hint-only: if any part fails,
// the web UI keeps working untouched.
//
// 1. Appearance + onboarding seeds. The web UI reads `kimi-web.color-scheme`
//    and `kimi-web.font-scale` from localStorage in its boot.js pre-paint
//    (verified against the kimi 2.0.2 bundle); seeding them means the chat
//    comes up in the SAME theme and density the user picked for the desktop
//    app. The served URL also carries ?kimi_onboarded=1 (the UI's official
//    skip); seeding the flag covers partitions holding stale state.
//
// 2. TUI mode — EVERYTHING expanded, at every level. In the CLI's terminal,
//    all work feedback is visible: the reasoning streams open, every tool
//    call shows its args/result/error, nothing hides behind a chevron. The
//    web UI collapses at FOUR separate layers (verified in the 2.0.2 bundle):
//      .turn-fold   — whole turns ("1 tool call (1 failed) · 2m18s"); its
//                     children are NOT in the DOM while it is closed
//      .ar-head     — ActivityRun groups (consecutive same-kind tools)
//      .tl-head     — individual tool rows (args/results hidden)
//      .think-head  — reasoning blocks (default-collapsed, and force-
//                     collapsed again the moment a stream ends)
//    The open state of all four is per-session component state — not a
//    localStorage pref — so it cannot be seeded. Instead, when the shell
//    asks for TUI mode, this preload runs one generic expansion pass driven
//    by each header button's aria-expanded: any header still reading
//    "collapsed" is clicked once (the same handler a user click runs). A
//    small per-button attempt budget guards against fighting a re-collapse,
//    and Alt+click on any header hands that block back to the user forever.
//    Opening a fold makes its children appear, which triggers the observer,
//    which expands those children — the whole tree opens top-down.
//
// 3. Terminal look. The web renders reasoning as a plain chat-font <pre> and
//    tool rows in the chat font with uncolored status. A small theme-aware
//    stylesheet mirrors the CLI here: tinted monospace reasoning with a live
//    caret, mono tool rows with red error / green running status. Purely
//    cosmetic — if class names ever change in a kimi update, the text just
//    renders plain, nothing breaks.
//
// 4. Precise live status. The web's own working indicator only ever says
//    "Requesting…"/"Working…" (verified: its label computed switches between
//    two generic i18n strings), and it gives no elapsed time. The CLI shows
//    WHAT it is doing and for HOW LONG, from the moment a prompt is sent.
//    So this preload owns its status pill (#kcd-status, bottom-right): it
//    appears as soon as a turn is active (kimi's indicator active, OR a
//    reasoning block streaming, OR a tool running), shows the real activity
//    — the running tool's own label, else "Thinking", else "Working" — and
//    ticks the elapsed turn time. One gated 1s clock total: it starts with
//    the turn and clears itself the moment activity ends. No DOM polling;
//    the MutationObserver drives all other updates.
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

  // --- TUI mode ---------------------------------------------------------------
  if (appearance && appearance.tuiThinking) {
    // Terminal styling (see header comment, point 3).
    try {
      if (!document.getElementById('kcd-tui-thinking-style')) {
        const st = document.createElement('style');
        st.id = 'kcd-tui-thinking-style';
        st.textContent = [
          ':root{--kcd-think-accent:#3fb27f;--kcd-think-text:#b9c6d2;--kcd-think-dim:#7e8c9a;--kcd-err:#ff6369;--kcd-pill-bg:#10151add;}',
          ':root[data-color-scheme="light"]{--kcd-think-accent:#187f56;--kcd-think-text:#414d59;--kcd-think-dim:#87939f;--kcd-err:#c4323a;--kcd-pill-bg:#f4f6f8ee;}',
          '.think .think-head .think-title{color:var(--kcd-think-dim);font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono",Menlo,monospace;font-size:.82em;letter-spacing:.02em;}',
          '.think.streaming .think-head .think-title{color:var(--kcd-think-accent);}',
          '.think .think-time{color:var(--kcd-think-dim);font-variant-numeric:tabular-nums;}',
          '.think pre.think-text{',
          '  font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono","Fira Code",Menlo,monospace;',
          '  font-size:.84em;line-height:1.55;text-align:left;',
          '  color:var(--kcd-think-text);',
          '  background:color-mix(in srgb,var(--kcd-think-accent) 7%,transparent);',
          '  border-left:2px solid color-mix(in srgb,var(--kcd-think-accent) 55%,transparent);',
          '  border-radius:0 8px 8px 0;margin:6px 0;padding:10px 14px;max-width:96ch;',
          '  white-space:pre-wrap;overflow-wrap:anywhere;}',
          '.think.streaming pre.think-text::after{content:"\\25CD";color:var(--kcd-think-accent);margin-left:2px;animation:kcd-caret 1s steps(2,start) infinite;}',
          '@keyframes kcd-caret{to{visibility:hidden;}}',
          '@media (prefers-reduced-motion:reduce){.think.streaming pre.think-text::after{animation:none;}}',
          // Tool activity rows — the CLI's colored-log look.
          '.tool-line,.tool-line .tl-lead,.tool-line .tl-head,.turn-fold .tf-head{font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono",Menlo,monospace;}',
          '.tool-line .tl-lead{color:var(--kcd-think-text);font-size:.84em;}',
          '.tool-line .tl-status.running,.tool-line .tl-status.suspended{color:var(--kcd-think-accent);}',
          '.tool-line .tl-status.error,.tool-line .tl-status.cancelled{color:var(--kcd-err);}',
          '.tool-line.err{box-shadow:inset 2px 0 0 var(--kcd-err);background:color-mix(in srgb,var(--kcd-err) 6%,transparent);border-radius:6px;}',
          '.tool-line .tl-body-content,.tool-line .tl-body pre,.tool-line .tl-body code{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.84em;line-height:1.5;color:var(--kcd-think-text);}',
          '.tool-line.err .tl-body-content{color:color-mix(in srgb,var(--kcd-err) 80%,var(--kcd-think-text));}',
          // The owned status pill (see header comment, point 4).
          '#kcd-status{position:fixed;right:14px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:8px;pointer-events:none;',
          '  font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.78em;letter-spacing:.01em;',
          '  color:var(--kcd-think-text);background:var(--kcd-pill-bg);',
          '  border:1px solid color-mix(in srgb,var(--kcd-think-accent) 30%,transparent);border-radius:999px;padding:6px 12px;',
          '  box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:min(60vw,560px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
          '#kcd-status::before{content:"\\25CF";color:var(--kcd-think-accent);font-size:.85em;animation:kcd-pulse 1.2s ease-in-out infinite;}',
          '@keyframes kcd-pulse{0%,100%{opacity:1;}50%{opacity:.3;}}',
          '@media (prefers-reduced-motion:reduce){#kcd-status::before{animation:none;}}',
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
      }
    } catch { /* cosmetic only — ignore */ }

    const userManaged = new WeakSet(); // blocks the user took over via Alt+click
    let scanning = false;
    let turnStart = 0;
    let clock = null;
    let pill = null;

    // Every disclosure layer the web UI can collapse (see header, point 2).
    const HEADS = '.tf-head,.ar-head,.tl-head.clickable,.think-head';

    function rootOf(head) {
      return head.closest('.turn-fold,.tool-line,.think') || head;
    }

    // Click a collapsed header open once (the same handler a user click
    // runs). The attempt budget stops us from dueling with a re-collapse;
    // Alt+clicked blocks are never touched again.
    function expandOnce(head) {
      if (!(head instanceof HTMLElement)) return;
      if (head.getAttribute('aria-expanded') !== 'false') return;
      const root = rootOf(head);
      if (userManaged.has(root)) return;
      const tries = Number(head.dataset.kcdTries || '0');
      if (tries >= 3) return;
      head.dataset.kcdTries = String(tries + 1);
      head.click();
    }

    function expandAll(scope) {
      const root = scope instanceof Element ? scope : document;
      if (root.matches && root.matches(HEADS)) expandOnce(root);
      for (const h of root.querySelectorAll ? root.querySelectorAll(HEADS) : []) expandOnce(h);
    }

    function scan(target) {
      if (scanning) return;
      scanning = true;
      queueMicrotask(() => {
        scanning = false;
        try {
          expandAll(target instanceof Element ? target : document);
          ensureClock();
        } catch { /* a detached node raced us — the next mutation rescan covers it */ }
      });
    }

    // Alt+click = "I'll drive this one myself" — the enhancer never touches
    // that block again.
    document.addEventListener('click', (e) => {
      try {
        if (!e.altKey) return;
        const el = e.target && e.target.closest ? e.target : null;
        if (!el) return;
        const head = el.closest('.tf-head,.ar-head,.tl-head,.think-head');
        if (head) userManaged.add(rootOf(head));
      } catch { /* never break the guest's own handlers */ }
    }, true);

    // --- owned live status (see header comment, point 4) ----------------------
    function fmtDur(ms) {
      const s = Math.max(1, Math.round(ms / 1000));
      return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    }

    function isActive() {
      return !!document.querySelector(
        '.working-indicator:not(.idle), .think.streaming, .tool-line .tl-status.running, .turn-fold.streaming'
      );
    }

    function currentActivity() {
      const run = document.querySelector('.tool-line:not(.err) .tl-status.running');
      if (run) {
        const row = run.closest('.tool-line');
        const lead = row && row.querySelector('.tl-lead');
        const text = lead && lead.textContent ? lead.textContent.trim().replace(/\s+/g, ' ') : '';
        if (text) return text.length > 64 ? text.slice(0, 63) + '…' : text;
      }
      if (document.querySelector('.think.streaming')) return 'Thinking';
      return '';
    }

    function paintStatus() {
      if (!pill) return;
      const act = currentActivity() || 'Working';
      pill.textContent = act + ' \u00B7 ' + fmtDur(Date.now() - (turnStart || Date.now()));
      pill.style.display = '';
    }

    function ensureClock() {
      if (isActive()) {
        if (!turnStart) turnStart = Date.now();
        paintStatus();
        if (clock === null) {
          clock = setInterval(() => {
            try {
              if (!isActive()) {
                clearInterval(clock); clock = null; turnStart = 0;
                if (pill) pill.style.display = 'none';
                return;
              }
              paintStatus();
            } catch { /* cosmetic only */ }
          }, 1000);
        }
      } else if (clock !== null) {
        clearInterval(clock); clock = null; turnStart = 0;
        if (pill) pill.style.display = 'none';
      }
    }

    const start = () => {
      try {
        pill = document.createElement('div');
        pill.id = 'kcd-status';
        pill.style.display = 'none';
        pill.setAttribute('role', 'status');
        document.body.appendChild(pill);

        scan(document);
        new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'attributes' && m.target instanceof Element) {
              // Class flips are the re-collapse edges (fold closed, thinking
              // auto-collapsed, row finished) — re-run the expansion there.
              if (m.target.matches(HEADS) || m.target.querySelector(HEADS)) {
                expandAll(m.target);
              }
            } else if (m.type === 'childList') {
              scan(m.target);
            }
          }
          ensureClock();
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      } catch { /* body not ready — DOMContentLoaded retry below */ }
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }
} catch {
  /* bridge unavailable — never break the guest page over a preference hint */
}
