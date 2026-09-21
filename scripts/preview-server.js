'use strict';

// Preview-tab server for Kimi Code Desktop. Serves renderer/ + assets/ +
// the bundled xterm files over HTTP so the UI can render inside the Freebuff
// Preview tab (a plain browser cannot require() Electron or node-pty).
// A small shim (window.kimiDesktop) drives the REAL app.js against demo data:
// every pixel of chrome, the session sidebar, tabs and the xterm terminal are
// the genuine app code — only the Electron bridge is faked. This file is not
// part of the shipped app; the packaged build never touches it.
//
// Run:  node scripts/preview-server.js   (port 5888, loopback only)
// Stop: GET http://127.0.0.1:5888/__shutdown

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.KCD_PREVIEW_PORT) || 5888;
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Directories the browser may read. Everything else 404s (path traversal is
// also blocked below — this list is the second gate).
const SERVE_TREES = [
  { prefix: '/renderer/', dir: path.join(ROOT, 'renderer') },
  { prefix: '/assets/', dir: path.join(ROOT, 'assets') },
  { prefix: '/node_modules/@xterm/', dir: path.join(ROOT, 'node_modules', '@xterm') },
];

function serveFile(res, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  fs.readFile(absPath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// The preview shim must exist BEFORE app.js runs (it defines the bridge
// app.js reads at module load). Injected into the served index.html.
const SHIM_SRC = `'use strict';
// Browser shim for the Electron bridge (window.kimiDesktop). Drives the real
// renderer with demo data. NEVER loaded by the packaged app — the real
// preload.js exposes the true IPC bridge there instead.
(function () {
  const HOME = 'C:\\\\Users\\\\demo';
  const demooSessions = [
    { id: 'session-demo-1', title: 'Add payment webhook', lastPrompt: 'Handle stripe refunds', cwd: 'C:\\\\code\\\\payments', gitBranch: 'feat/webhook', updatedAt: Date.now() - 42 * 60000, interactive: true },
    { id: 'session-demo-2', title: 'Explain the build system', lastPrompt: 'How does the bundler resolve entries?', cwd: 'C:\\\\code\\\\payments', gitBranch: 'main', updatedAt: Date.now() - 5 * 3600000, interactive: true },
    { id: 'session-demo-3', title: 'Refactor auth middleware', lastPrompt: 'Split the middleware into stages', cwd: 'C:\\\\code\\\\identity', gitBranch: 'refactor/auth', updatedAt: Date.now() - 3 * 86400000, interactive: true },
  ];
  const cbs = { ptyData: [], ptyExit: [], kimiDetected: [], appFocus: [], menu: [], webExit: [] };
  let seq = 0;

  function emit(list, payload) { for (const cb of list) { try { cb(payload); } catch (e) { console.error(e); } } }

  // A short fake TUI stream so the preview terminal shows the real xterm
  // rendering path (loader lift, palette, fonts) without a backend.
  const TUI = [
    '\\x1b[1m\\u25c6 Kimi Code\\x1b[0m v2.0.2 \\u2014 preview session\\r\\n',
    'Tips: type /help for commands, /plan to plan first\\r\\n\\r\\n',
    '\\x1b[2m\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\x1b[0m\\r\\n',
    '\\x1b[1m> Add a retry with backoff to the deploy poller\\x1b[0m\\r\\n\\r\\n',
    '\\x1b[36mThinking\\u2026\\x1b[0m reading src/deploy.js\\r\\n',
    '\\x1b[32m\\u25cf Edit\\x1b[0m(src/deploy.js) \\x1b[32m+12\\x1b[0m \\x1b[31m-3\\x1b[0m\\r\\n',
    '  retried = retried + 1; await sleep(backoff(retried))\\r\\n\\r\\n',
    '\\x1b[32m\\u2713 Tests: 9 passed\\x1b[0m  \\x1b[2m(4.2s)\\x1b[0m\\r\\n',
  ];

  window.kimiDesktop = {
    getBootstrap: async () => ({
      settings: {
        kimiPath: '', kimiCodeHome: '', defaultCwd: '', defaultMode: 'default',
        fontSize: 13, fontFamily: '', theme: 'dark', scrollback: 10000,
        shellPath: '', sidebarWidth: 292, sidebarCollapsed: false,
        sessionGroupBy: 'project', terminalStyle: 'panel', sessionView: 'chat',
        collapsedGroups: [],
      },
      kimi: { found: true, path: HOME + '\\\\AppData\\\\Local\\\\Programs\\\\kimi\\\\kimi.exe', version: '2.0.2', source: 'auto', checked: [] },
      kimiHome: HOME + '\\\\.kimi-code',
      kimiHomeDisplay: HOME + '\\\\.kimi-code',
      wsl: null,
      platform: 'win32',
      arch: 'x64',
      appVersion: '1.0.0-beta.3',
      homeDir: HOME,
      testHarness: false,
      sessionHomeDefault: HOME + '\\\\.kimi-code',
      kimiCliCandidates: [],
    }),
    detectKimi: async () => ({ found: true, path: 'kimi.exe', version: '2.0.2', source: 'auto', checked: [] }),
    setKimiPath: async () => ({}),
    getSettings: async () => ({}),
    setSettings: async (patch) => patch,
    reloadWindow: async () => { location.reload(); },
    listSessions: async () => ({ home: HOME + '\\\\.kimi-code', sessions: demooSessions.slice() }),
    exportSession: async () => ({ canceled: true }),
    startSession: async (opts) => {
      const tabId = 'demo-' + (++seq);
      const res = {
        tabId, pid: 4242 + seq, binary: 'kimi.exe', kimiVersion: '2.0.2',
        cwd: opts.cwd || 'C:\\\\code\\\\payments', args: [],
        mode: opts.mode || 'default', resumeId: opts.resumeId || null,
        kind: 'pty',
      };
      // Stream the demo TUI shortly after the tab exists.
      setTimeout(() => {
        let t = 120;
        for (const chunk of TUI) {
          setTimeout(() => emit(cbs.ptyData, { tabId, data: chunk }), t);
          t += 220;
        }
      }, 350);
      return res;
    },
    writeInput: () => {},
    resizeTerminal: () => {},
    killSession: async (tabId) => {
      setTimeout(() => emit(cbs.ptyExit, { tabId, exitCode: 0 }), 250);
      return true;
    },
    writeAttachment: async () => ({ ok: false, error: 'Attachments need the desktop app.' }),
    startWebSession: async () => ({ error: 'web-unavailable' }),
    stopWebSession: async () => true,
    readConfig: async () => ({ path: HOME + '\\\\.kimi-code\\\\config.toml', exists: true, content: '# Kimi Code CLI configuration (config.toml)\\n# Preview placeholder — the desktop app edits the real file.\\n', viaWsl: false }),
    writeConfig: async () => ({ ok: true, path: 'config.toml' }),
    windowControls: {
      minimize: () => {}, toggleMaximize: () => {}, close: () => {},
      isMaximized: async () => false,
      onMaximizedChanged: () => {},
    },
    pickFolder: async () => null,
    pickFile: async () => null,
    openExternal: async () => ({ ok: true }),
    openPath: async () => ({ ok: true }),
    getPath: async () => '',
    copyText: (text) => { try { navigator.clipboard.writeText(text); } catch (e) { /* preview */ } return true; },
    readText: async () => '',
    getPathForFile: () => '',
    onPtyData: (cb) => cbs.ptyData.push(cb),
    onPtyExit: (cb) => cbs.ptyExit.push(cb),
    onWebExit: (cb) => cbs.webExit.push(cb),
    onKimiDetected: (cb) => cbs.kimiDetected.push(cb),
    onAppFocus: (cb) => cbs.appFocus.push(cb),
    onMenu: (cb) => cbs.menu.push(cb),
  };
})();
`;

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/__shutdown') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('bye');
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (urlPath === '/preview-shim.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(SHIM_SRC);
    return;
  }

  // Route / → renderer/index.html with the shim injected before app.js.
  if (urlPath === '/' || urlPath === '/index.html') {
    const indexPath = path.join(ROOT, 'renderer', 'index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('preview server cannot read index.html');
        return;
      }
      const injected = html.replace(
        '<script src="app.js"></script>',
        '<script src="/preview-shim.js"></script>\n  <script src="app.js"></script>'
      );
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(injected);
    });
    return;
  }

  // index.html references scripts/styles as siblings (src="app.js"), which on
  // file:// resolves next to index.html. Over http the page sits at '/', so
  // those resolve to the server root — serve the renderer tree at BOTH / and
  // /renderer/ so every reference works no matter how the browser resolved it.
  if (urlPath === '/app.js') { serveFile(res, path.join(ROOT, 'renderer', 'app.js')); return; }
  if (urlPath === '/styles.css') { serveFile(res, path.join(ROOT, 'renderer', 'styles.css')); return; }

  for (const tree of SERVE_TREES) {
    if (urlPath.startsWith(tree.prefix)) {
      const rel = urlPath.slice(tree.prefix.length);
      const abs = path.normalize(path.join(tree.dir, rel));
      if (!abs.startsWith(tree.dir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      serveFile(res, abs);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[preview] Kimi Code Desktop preview on http://127.0.0.1:${PORT} (demo data, real UI)`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
