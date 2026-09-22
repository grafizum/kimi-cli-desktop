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
// 3. Terminal look for the reasoning itself. The web bundle renders the
//    thinking body as a plain <pre class="think-text"> — monochrome, chat
//    font (verified against the kimi 2.0.2 bundle). The CLI shows reasoning
//    as a tinted monospace block with a live caret; a small stylesheet
//    mirrors that here (theme-aware via data-color-scheme, which this
//    preload already seeds). Purely cosmetic — if the class names ever
//    change in a kimi update, nothing breaks, the text just renders plain.
//
// 4. CLI-style tool activity rows. Same story for the Plan/Skill/tool lines
//    (bundle class `tool-line`): the web renders them in the chat font with
//    an uncolored status chip, while the terminal colors them (red error
//    rows, green running state, mono text) and always shows errors inline.
//    Here: mono styling + status colors via CSS, and every expandable row is
//    clicked open once so args/results/errors are visible immediately — the
//    terminal never hides tool feedback behind a chevron (Alt+click hands the
//    row back to the user, same escape hatch as the thinking blocks).
//
// 5. Precise live status. The web's working indicator only ever says
//    "Requesting…"/"Working…" (verified: its label computed switches between
//    two generic i18n strings), while the CLI reports WHAT it is doing and
//    for how long. The enhancer derives the real activity from the DOM — the
//    running tool row's own label, else the streaming reasoning block — and
//    rewrites the indicator as "<activity> · <elapsed>", ticking via a single
//    1s clock that runs ONLY while a turn is active. No DOM polling: the
//    MutationObserver drives everything else, and the clock self-clears the
//    moment the indicator goes idle.
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
    // Terminal styling for the reasoning block (see header comment, point 3).
    try {
      if (!document.getElementById('kcd-tui-thinking-style')) {
        const st = document.createElement('style');
        st.id = 'kcd-tui-thinking-style';
        st.textContent = [
          ':root{--kcd-think-accent:#3fb27f;--kcd-think-text:#b9c6d2;--kcd-think-dim:#7e8c9a;}',
          ':root[data-color-scheme="light"]{--kcd-think-accent:#187f56;--kcd-think-text:#414d59;--kcd-think-dim:#87939f;}',
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
          // Tool activity rows — the CLI's colored-log look (see point 4).
          '.tool-line,.tool-line .tl-lead,.tool-line .tl-head{font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono",Menlo,monospace;}',
          '.tool-line .tl-lead{color:var(--kcd-think-text);font-size:.84em;}',
          '.tool-line .tl-status.running,.tool-line .tl-status.suspended{color:var(--kcd-think-accent);}',
          '.tool-line .tl-status.error,.tool-line .tl-status.cancelled{color:var(--kcd-err);}',
          '.tool-line.err{box-shadow:inset 2px 0 0 var(--kcd-err);background:color-mix(in srgb,var(--kcd-err) 6%,transparent);border-radius:6px;}',
          '.tool-line .tl-body-content,.tool-line .tl-body pre,.tool-line .tl-body code{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.84em;line-height:1.5;color:var(--kcd-think-text);}',
          '.tool-line.err .tl-body-content{color:color-mix(in srgb,var(--kcd-err) 80%,var(--kcd-think-text));}',
          ':root{--kcd-err:#ff6369;}',
          ':root[data-color-scheme="light"]{--kcd-err:#c4323a;}',
          // Status pill — terminal log line look (see point 5).
          '.working-indicator .wi-label{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.8em;color:var(--kcd-think-text);}',
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
      }
    } catch { /* cosmetic only — ignore */ }

    const userManaged = new WeakSet(); // blocks the user took over via Alt+click
    let scanning = false;

    function clickHeader(block) {
      const head = block.querySelector('.think-head');
      if (head instanceof HTMLElement) head.click();
    }

    function isOpen(block) {
      return block.classList.contains('open');
    }

    // Tool rows: open once so args/results/errors are visible immediately —
    // the terminal never hides tool feedback behind a chevron. A small
    // attempt budget guards against fighting a row the UI re-collapses;
    // Alt+click permanently hands a row back to the user.
    function openToolRow(row) {
      if (userManaged.has(row)) return;
      const head = row.querySelector('.tl-head.clickable');
      if (!(head instanceof HTMLElement)) return;
      if (row.dataset.tuiRowOpen === '1' && row.classList.contains('open')) return;
      const tries = Number(row.dataset.tuiRowTries || '0');
      if (tries >= 3) return;
      row.dataset.tuiRowTries = String(tries + 1);
      row.dataset.tuiRowOpen = '1';
      head.click();
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
          const rows = (root instanceof Element ? root : document)
            .querySelectorAll('.tool-line:not([data-tui-row-open])');
          for (const r of rows) openToolRow(r);
          ensureClock();
        } catch { /* a detached node raced us — the next mutation rescan covers it */ }
      });
    }

    document.addEventListener('click', (e) => {
      try {
        if (!(e.altKey)) return;
        const el = e.target && e.target.closest ? e.target : null;
        if (!el) return;
        const thinkHead = el.closest('.think-head');
        if (thinkHead) {
          const block = thinkHead.closest('.think');
          if (block) {
            userManaged.add(block); // Alt+click = "I'll drive this one myself"
            block.dataset.tui = 'manual';
          }
          return;
        }
        const toolHead = el.closest('.tl-head');
        if (toolHead) {
          const row = toolHead.closest('.tool-line');
          if (row) userManaged.add(row); // same escape hatch for tool rows
        }
      } catch { /* never break the guest's own handlers */ }
    }, true);

    // Precise live status (see header comment, point 5). One gated clock,
    // no DOM polling: the tick only rewrites the indicator label while a
    // turn is active and stops the moment the indicator goes away. Vue's
    // own re-renders restore its generic text; the observer repaints ours.
    let turnStart = 0;
    let clock = null;

    function fmtDur(ms) {
      const s = Math.max(1, Math.round(ms / 1000));
      return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
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
      for (const ind of document.querySelectorAll('.working-indicator:not(.idle)')) {
        const label = ind.querySelector('.wi-label');
        if (!(label instanceof HTMLElement)) continue;
        const dur = fmtDur(Date.now() - (turnStart || Date.now()));
        const raw = label.textContent || '';
        const base = currentActivity()
          || raw.replace(/\s·\s\d+(s|m\s\d\ds)$/, ''); // strip our own suffix
        const next = base ? base + ' · ' + dur : '';
        if (next && label.textContent !== next) label.textContent = next;
      }
    }

    function ensureClock() {
      const anyActive = document.querySelector('.working-indicator:not(.idle)');
      if (anyActive) {
        if (!turnStart) turnStart = Date.now();
        paintStatus();
        if (clock === null) {
          clock = setInterval(() => {
            try {
              if (!document.querySelector('.working-indicator:not(.idle)')) {
                clearInterval(clock); clock = null; turnStart = 0;
                return;
              }
              paintStatus();
            } catch { /* cosmetic only */ }
          }, 1000);
        }
      } else if (clock !== null) {
        clearInterval(clock); clock = null; turnStart = 0;
      }
    }

    const start = () => {
      try {
        scan(document);
        new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'attributes' && m.target instanceof Element) {
              if (m.target.classList.contains('think')) {
                enforceTui(m.target); // streaming edge — cheap, targeted
              } else if (m.target.classList.contains('tool-line')) {
                openToolRow(m.target);
              } else if (m.target.classList.contains('working-indicator')) {
                ensureClock();
              }
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
