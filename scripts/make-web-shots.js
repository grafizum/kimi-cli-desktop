'use strict';
// Screenshot generator for the Web edition README.
// Boots the REAL renderer (index.html + styles.css, no preload bridge so
// nothing spawns) in an Electron window, injects demo content into the stage,
// and captures PNGs into docs/screenshots/. Run on a machine with a display:
//   node scripts/make-web-shots.js
// The chat conversation shown in the shots is DEMO CONTENT rendered with the
// shell's real chrome — it is not a live kimi session.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const CHAT_DEMO = `
<div style="position:absolute;inset:0;background:#050505;color:#e7e9ea;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;display:flex;flex-direction:column">
  <div style="flex:1;overflow:hidden;padding:34px 60px 8px;display:flex;flex-direction:column;gap:22px;max-width:900px">
    <div style="display:flex;gap:12px;align-items:flex-start">
      <div style="width:26px;height:26px;border-radius:7px;background:#1c1d21;display:flex;align-items:center;justify-content:center;font-size:13px">🐱</div>
      <div style="max-width:70%;line-height:1.6;font-size:14px">I'll add the payment webhook handler. Let me check the existing routes first.</div>
    </div>
    <div style="margin-left:38px;display:flex;flex-direction:column;gap:10px">
      <div style="border:1px solid #232428;border-radius:10px;padding:12px 14px;background:#0d0e10">
        <div style="font-size:11px;color:#8a8f98;margin-bottom:8px;letter-spacing:.04em">READING FILE</div>
        <div style="font-family:Consolas,monospace;font-size:12px;color:#c8ccd2">src/routes/webhooks.ts <span style="color:#46d186">+18 −2</span></div>
      </div>
      <div style="border:1px solid #232428;border-radius:10px;padding:12px 14px;background:#0d0e10">
        <div style="font-size:11px;color:#8a8f98;margin-bottom:8px;letter-spacing:.04em">THINKING</div>
        <div style="font-size:12.5px;color:#8a8f98;line-height:1.55">The Stripe signature check lives in middleware — reuse it and idempotency-key the handler on the event id…</div>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start">
      <div style="width:26px;height:26px;border-radius:50%;background:#175cd3;display:flex;align-items:center;justify-content:center;font-size:12px">🧑</div>
      <div style="max-width:70%;line-height:1.6;font-size:14px">Great — run the test suite before you finish.</div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start">
      <div style="width:26px;height:26px;border-radius:7px;background:#1c1d21;display:flex;align-items:center;justify-content:center;font-size:13px">🐱</div>
      <div style="max-width:70%;line-height:1.6;font-size:14px">Done — <span style="color:#46d186">9 passed</span>, 0 failed. Changes are in <span style="font-family:Consolas,monospace;background:#121316;border:1px solid #232428;border-radius:4px;padding:1px 5px;font-size:12px">feature/webhooks</span>.</div>
    </div>
  </div>
  <div style="padding:0 60px 26px">
    <div style="border:1px solid #2a2b30;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:10px;background:#0d0e10">
      <span style="color:#8a8f98;font-size:13px">Ask Kimi anything…</span>
      <span style="flex:1"></span>
      <span style="border:1px solid #2a2b30;border-radius:8px;padding:3px 10px;font-size:11.5px;color:#c8ccd2">🚫 Never Ask ▾</span>
      <span style="width:26px;height:26px;border-radius:50%;background:#175cd3;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px">↑</span>
    </div>
  </div>
</div>`;

const DEMO_CSS = `
.tb-badge { display:inline-flex !important; }
#no-kimi, #starting, #error-state { display:none !important; }
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await win.webContents.insertCSS(DEMO_CSS);
  await win.webContents.executeJavaScript(`document.body.dataset.theme='dark'; document.body.classList.remove('maximized'); ''`);
  await win.webContents.executeJavaScript(`
    document.getElementById('stage').insertAdjacentHTML('beforeend', ${JSON.stringify(CHAT_DEMO)});
    document.getElementById('tb-badge').textContent = 'demo';
    document.getElementById('status-left').textContent = 'kimi 2.0.2';
    document.getElementById('status-right').textContent = 'chat · localhost';
    ''`);
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'web-main.png'), img.toPNG());

  // Shot 2: the Models & providers modal over a dimmed chat.
  await win.webContents.executeJavaScript(`
    document.getElementById('modal-models').classList.remove('hidden');
    document.getElementById('mp-config').value = [
      '[providers.ollama-local]',
      'type = "openai_legacy"   # Ollama / llama.cpp / LM Studio',
      'base_url = "http://localhost:11434/v1"',
      '',
      '[models."llama3.1:8b"]',
      'provider = "ollama-local"',
      'model = "llama3.1:8b"',
      'max_context_size = 32768',
      'capabilities = ["thinking"]',
      '',
      '# remove a model by deleting its block, then /model in the chat',
    ].join('\\n');
    ''`);
  await new Promise((r) => setTimeout(r, 700));
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'web-models.png'), img2.toPNG());

  // Shot 3: the "CLI not found" card (light theme for contrast).
  await win.webContents.executeJavaScript(`
    document.getElementById('modal-models').classList.add('hidden');
    document.querySelectorAll('#stage > div').forEach((n) => n.remove());
    const nk = document.getElementById('no-kimi');
    nk.hidden = false;
    // The demo stylesheet force-hides the cards; an inline !important beats it.
    nk.style.setProperty('display', 'flex', 'important');
    document.body.dataset.theme = 'light';
    document.getElementById('tb-badge').textContent = 'demo';
    document.getElementById('status-left').textContent = 'Kimi Code CLI not found';
    document.getElementById('status-right').textContent = 'waiting for the CLI';
    document.getElementById('detect-hint').textContent = 'Looked in 7 locations on PATH, npm and WSL.';
    ''`);
  await new Promise((r) => setTimeout(r, 700));
  const img3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'web-setup.png'), img3.toPNG());

  console.log('SHOTS-OK ' + OUT);
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('SHOTS-FAIL', e); app.exit(1); });
