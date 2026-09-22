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
// 2. TUI mode — EVERYTHING expanded, at every level. The CLI shows all work
//    feedback inline: reasoning streams open, every tool call shows its
//    args/result/error, nothing hides behind a chevron. The web UI collapses
//    at FOUR separate layers (verified in the 2.0.2 bundle):
//      .turn-fold   — whole turns ("1 tool call (1 failed) · 2m18s"); its
//                     children are NOT in the DOM while it is closed
//      .ar-head     — ActivityRun groups (consecutive same-kind tools)
//      .tl-head     — individual tool rows (args/results hidden)
//      .think-head  — reasoning blocks (default-collapsed, and force-
//                     collapsed again the moment a stream ends)
//    The open state is per-session component state, not a localStorage pref,
//    so it cannot be seeded. Instead, when the shell asks for TUI mode, a
//    generic expansion pass runs on every DOM change: any header still
//    reading aria-expanded="false" is clicked once (the same handler a user
//    click runs). The click is DEFERRED ~300ms and re-verified — clicking
//    synchronously races Vue's async re-render (the observer rescans before
//    Vue flips aria-expanded and toggles the block right back closed). A
//    small per-header budget guards against dueling re-collapses, and
//    Alt+click hands any block back to the user permanently.
//
// 3. Terminal look. The web renders reasoning as a plain chat-font <pre> and
//    tool rows in the chat font with uncolored status. A theme-aware
//    stylesheet mirrors the CLI: tinted monospace reasoning with a live
//    caret, mono tool rows with red error / green running status. Injected
//    via a CONSTRUCTED stylesheet (adoptedStyleSheets) because a <style>
//    element can be blocked by the page's Content-Security-Policy —
//    constructed sheets are not subject to style-src. Purely cosmetic: if
//    class names change in a kimi update, text just renders plain.
//
// 4. Live status with a real clock. The web's own indicator only says
//    "Requesting…"/"Working…" (verified: two generic i18n strings) and can
//    lag or vanish between phases, so a slow model looks FROZEN. This
//    preload owns the status (#kcd-status, bottom-right) instead:
//      - it ARMS the moment Enter is pressed in the composer, showing
//        "Thinking · 0s" ticking from the very first keystroke;
//      - as real activity appears it refines to the running tool's own
//        label ("Read src/main.js · 12s") or "Thinking";
//      - it keeps ticking through silent stretches (a provider that streams
//        nothing) and only goes away a few seconds after activity ends.
//    One gated 1s clock total; no DOM polling — the MutationObserver drives
//    everything else.
//
// Sandboxed preload: `electron` here exposes only the safe renderer APIs
// (ipcRenderer among them) — no Node, no fs, nothing else.

try {
  const { ipcRenderer } = require('electron');
  const boot = (info) => { try { ipcRenderer.sendSync('webui:preload-boot', info); } catch { /* telemetry only */ } };
  const appearance = ipcRenderer.sendSync('webui:get-appearance');
  const scheme = appearance && appearance.colorScheme === 'light' ? 'light' : 'dark';
  boot({ stage: 'document-start', hasAppearance: !!appearance, tuiThinking: !!(appearance && appearance.tuiThinking), scheme });
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
    const TUI_CSS = [
      ':root{--kcd-think-bar:#4d9fff;--kcd-think-accent:#3fb27f;--kcd-think-text:#b9c6d2;--kcd-think-dim:#7e8c9a;--kcd-err:#ff6369;--kcd-pill-bg:#10151add;}',
      ':root[data-color-scheme="light"]{--kcd-think-bar:#1f6fd6;--kcd-think-accent:#187f56;--kcd-think-text:#414d59;--kcd-think-dim:#87939f;--kcd-err:#c4323a;--kcd-pill-bg:#f4f6f8ee;}',
      '.think .think-head .think-title{color:var(--kcd-think-dim);font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono",Menlo,monospace;font-size:.82em;letter-spacing:.02em;}',
      '.think.streaming .think-head .think-title{color:var(--kcd-think-bar);}',
      '.think .think-time{color:var(--kcd-think-dim);font-variant-numeric:tabular-nums;}',
      '.think pre.think-text{',
      '  font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono","Fira Code",Menlo,monospace;',
      '  font-size:.84em;line-height:1.55;text-align:left;',
      '  color:var(--kcd-think-text);',
      '  background:transparent;',
      '  border-left:2px solid var(--kcd-think-bar);',
      '  border-radius:0 8px 8px 0;margin:6px 0;padding:10px 14px;max-width:96ch;',
      '  white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.think.streaming pre.think-text::after{content:"\\25CD";color:var(--kcd-think-bar);margin-left:2px;animation:kcd-caret 1s steps(2,start) infinite;}',
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

    // CSP-proof injection: constructed stylesheets are not subject to the
    // page's style-src policy (a <style> element can be). Fall back to a
    // style element where CSSStyleSheet construction is unavailable.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(TUI_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      try {
        if (!document.getElementById('kcd-tui-style')) {
          const st = document.createElement('style');
          st.id = 'kcd-tui-style';
          st.textContent = TUI_CSS;
          (document.head || document.documentElement).appendChild(st);
        }
      } catch { /* cosmetic only — ignore */ }
    }

    const userManaged = new WeakSet(); // blocks the user took over via Alt+click
    let scanning = false;
    let turnStart = 0;
    let clock = null;
    let pill = null;
    let armed = false;
    let graceTicks = 0;

    // Every disclosure layer the web UI can collapse (see header, point 2).
    const HEADS = '.tf-head,.ar-head,.tl-head.clickable,.think-head';

    function rootOf(head) {
      return head.closest('.turn-fold,.tool-line,.think') || head;
    }

    // Click a collapsed header open — but DEFER and re-verify. A synchronous
    // click races Vue: the observer rescans before Vue patches aria-expanded,
    // sees "false" again, and toggles the block right back closed. The delay
    // plus the re-check guarantees one click == one open.
    // A turn is LIVE only when the user submitted it (armed on Enter).
    // Class-based detection (".streaming") is NOT trustworthy for this: a
    // session interrupted mid-turn keeps those classes in its SAVED history,
    // so on load the enhancer would believe a turn is streaming and
    // force-expand the entire lazy-rendered conversation — a DOM explosion
    // that hard-blocks the renderer (measured: the main thread wedges solid,
    // CDP included). Only Enter-armed turns expand; everything else keeps
    // kimi's own folds (Alt+click still opens anything by hand).
    // Evaluated at most 4x/second; the passive load path stays ~free.
    let liveCache = false;
    let liveCheckedAt = 0;
    function liveTurn() {
      const now = Date.now();
      if (now - liveCheckedAt > 250) {
        liveCheckedAt = now;
        liveCache = armed;
      }
      return liveCache;
    }

    let clickBudget = 0; // hard bound per armed turn — no runaway expansion
    function expandOnce(head) {
      if (!(head instanceof HTMLElement)) return;
      if (!liveTurn()) return;
      if (clickBudget <= 0) return;
      if (head.getAttribute('aria-expanded') !== 'false') return;
      if (userManaged.has(rootOf(head))) return;
      if (head.dataset.kcdPending === '1') return;
      const tries = Number(head.dataset.kcdTries || '0');
      if (tries >= 3) return;
      head.dataset.kcdPending = '1';
      head.dataset.kcdTries = String(tries + 1);
      clickBudget -= 1;
      setTimeout(() => {
        try {
          head.dataset.kcdPending = '0';
          if (!head.isConnected) return;
          if (head.getAttribute('aria-expanded') !== 'false') return; // settled open
          if (userManaged.has(rootOf(head))) return;
          head.click();
        } catch { /* cosmetic only */ }
      }, 300);
    }

    function expandAll(scope) {
      if (!liveTurn()) return; // passive load: touch nothing (see liveTurn)
      const root = scope instanceof Element ? scope : document;
      if (root.matches && root.matches(HEADS)) expandOnce(root);
      for (const h of root.querySelectorAll ? root.querySelectorAll(HEADS) : []) expandOnce(h);
    }

    function scan(target) {
      if (scanning) return;
      if (!liveTurn()) return; // cheap gate FIRST — no DOM work while passive
      scanning = true;
      queueMicrotask(() => {
        scanning = false;
        try {
          // NEVER rescan from a high node (body/document) — a streaming turn
          // mutates top-level nodes hundreds of times, and a whole-document
          // querySelectorAll each time is an O(n²) storm that freezes the
          // renderer on long sessions. A body-level hit scans only the LAST
          // element (the newly added tail), which is where the new content is.
          const root = target instanceof Element && target !== document.body
            ? target
            : (document.body && document.body.lastElementChild) || document;
          expandAll(root);
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

    // Same 250ms-cache discipline as liveTurn: the observer fires thousands
    // of times during a big session render, and one querySelector per batch
    // is enough to hard-wedge the main thread. Never query per mutation.
    let activeCache = false;
    let activeCheckedAt = 0;
    function isActive() {
      const now = Date.now();
      if (now - activeCheckedAt > 250) {
        activeCheckedAt = now;
        activeCache = !!document.querySelector(
          '.working-indicator:not(.idle), .think.streaming, .tool-line .tl-status.running, .turn-fold.streaming'
        );
      }
      return activeCache;
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
      const act = currentActivity() || (armed ? 'Thinking' : 'Working');
      const text = act + ' \u00B7 ' + fmtDur(Date.now() - (turnStart || Date.now()));
      // IDEMPOTENT writes only: textContent replacement fires a childList
      // mutation, and this pill sits inside the observed body — a blind write
      // re-triggers our own observer, which paints again… an infinite
      // paint→observe→paint loop that hard-wedges the renderer.
      if (pill.textContent !== text) pill.textContent = text;
      if (pill.style.display !== '') pill.style.display = '';
    }

    function endTurn() {
      armed = false; turnStart = 0; graceTicks = 0; clickBudget = 0;
      if (clock !== null) { clearInterval(clock); clock = null; }
      if (pill) pill.style.display = 'none';
    }

    // Enter in the composer = a turn is starting NOW. The clock arms on the
    // keystroke so the pill ticks from second zero — no more frozen look
    // while the model warms up.
    function armTurn() {
      if (!turnStart) turnStart = Date.now();
      armed = true; graceTicks = 0;
      clickBudget = 400; // one armed turn, bounded expansion
      paintStatus();
      ensureClock();
    }

    document.addEventListener('keydown', (e) => {
      try {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        const t = e.target;
        // The composer is a ProseMirror contenteditable DIV (not a textarea).
        if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable)) armTurn();
      } catch { /* never break the guest's own handlers */ }
    }, true);

    function ensureClock() {
      if (!armed && !isActive()) return;
      if (isActive()) { if (!turnStart) turnStart = Date.now(); graceTicks = 0; }
      paintStatus();
      if (clock !== null) return;
      clock = setInterval(() => {
        try {
          if (isActive()) { graceTicks = 0; paintStatus(); return; }
          // Silent stretch: keep ticking if the turn is armed (a provider can
          // stream nothing for a while — that must NOT look frozen), and only
          // end after a calm tail with nothing armed.
          graceTicks += 1;
          if (armed && graceTicks < 15) { paintStatus(); return; }
          endTurn();
        } catch { /* cosmetic only */ }
      }, 1000);
    }

    const start = () => {
      try {
        pill = document.createElement('div');
        pill.id = 'kcd-status';
        pill.style.display = 'none';
        pill.setAttribute('role', 'status');
        document.body.appendChild(pill);

        // No boot-time expansion pass: history loads folded (see liveTurn).
        new MutationObserver((muts) => {
          // Everything is gated on an armed turn: the passive path (loading
          // history, even one saved mid-turn with stale .streaming classes)
          // must stay ~free — per-batch work here is what hard-wedged the
          // renderer on big sessions.
          if (!armed) return;
          for (const m of muts) {
            if (m.type === 'attributes' && m.target instanceof Element) {
              // Class flips are the re-collapse edges (fold closed, thinking
              // auto-collapsed, row finished) — re-run the expansion there.
              if (m.target.matches(HEADS)) expandOnce(m.target);
            } else if (m.type === 'childList' && m.target instanceof Element
                       && m.target !== document.body) {
              scan(m.target);
            } else if (m.type === 'childList') {
              // Top-level: only the new tail, never the whole document.
              const added = m.addedNodes && m.addedNodes.length
                ? m.addedNodes[m.addedNodes.length - 1] : null;
              if (added instanceof Element) scan(added);
            }
          }
          ensureClock();
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      } catch { /* body not ready — DOMContentLoaded retry below */ }
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    boot({ stage: 'tui-section-armed', pill: true, heads: HEADS });
  }
} catch {
  /* bridge unavailable — never break the guest page over a preference hint */
}
