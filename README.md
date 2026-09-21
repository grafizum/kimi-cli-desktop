<div align="center">

<img src="assets/icon.png" width="96" alt="Kimi Code Desktop (Web edition) logo" />

# Kimi Code Desktop — Web edition

**A desktop app that embeds the Kimi Code CLI's own web chat — `kimi web` — fullscreen. Not a terminal app, not a reimplementation: the real CLI interface, in a native window.**

[![CI](https://github.com/grafizum/kimi-cli-desktop/actions/workflows/ci.yml/badge.svg?branch=kimi-web-desktop)](https://github.com/grafizum/kimi-cli-desktop/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-orange)](#-install)
![Edition](https://img.shields.io/badge/edition-kimi%20web%20wrapper-blue)
![Status](https://img.shields.io/badge/status-beta-yellow)
[![Unofficial](https://img.shields.io/badge/status-unofficial%20project-red)](#-legal-notice)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

> [!WARNING]
> **This is NOT the terminal edition.** This release is a **wrapper around the Kimi Code CLI's own web chat interface** inside a desktop app — there is no terminal, no session tabs, no TUI here. If you want the classic Kimi Code Desktop (tabs, session-history sidebar, terminal), install the **[CLI edition instead](https://github.com/grafizum/kimi-cli-desktop)** (branch `main`, released as plain `v*` tags). Both can be installed side by side.

> [!IMPORTANT]
> **Unofficial project — not associated with the official Kimi developers.**
> This app is an independent, community-built desktop window around the publicly available `kimi` CLI's `kimi web` server. It is **not associated with, affiliated with, authorized by, endorsed by, sponsored by, or in any way officially connected with Moonshot AI (the official Kimi developers)**. "Kimi" and related names are trademarks of their respective owners; any use here is purely descriptive. No official code, assets, or credentials are included or redistributed. See [Legal notice](#-legal-notice).

## What this is

This branch (`kimi-web-desktop`) is the **web edition** of Kimi Code Desktop: the whole app is the chat interface that the `kimi` CLI itself ships (`kimi web`), loaded into a native window and given desktop chrome — title bar, dock/taskbar icon, installer, auto-restart.

**It is not a rebuild.** The UI you see is served byte-for-byte by the CLI's own web server on `127.0.0.1` — thinking blocks, tool-call cards, file diffs, attachment uploads, approval prompts, background tasks, Mermaid rendering, all of it exactly as Moonshot ships it, and automatically up to date whenever you update the CLI.

> **The reasoning you see is the real thing.** Nothing sits between the CLI's output and your eyes to re-style, truncate, or lag behind CLI updates.

## The two editions — pick the right one

| | **Web edition** (this branch) | **CLI edition** (branch `main`) |
|---|---|---|
| **What you see** | the CLI's own **chat UI**, fullscreen | tabs + sidebar + the **terminal TUI** (and chat) |
| **Terminal inside?** | ❌ none — it is a web chat wrapper | ✅ the classic kimi TUI |
| **Sessions** | one live chat window; history lives in the web UI's own sidebar | full session-history sidebar with resume/fork/export |
| **Best for** | a clean, chat-first desktop client | power users who live in tabs and the TUI |
| **Released as** | tags `web-v*` → `Kimi-Code-Desktop-Web-*` artifacts | tags `v*` → `Kimi-Code-Desktop-*` artifacts |

Both editions can be installed side by side — they share only your `~/.kimi-code` data, which belongs to the CLI, not to either app.

## Requirements

- **The Kimi Code CLI v2.0+** (`kimi`) installed and on `PATH` — [instructions](https://www.kimi.com/code/docs/en/). The app **detects it automatically**, including inside WSL on Windows; while it is missing the window shows the install hint and lights up the moment the CLI appears (no restart needed).

## Install

Grab the newest `Web` assets from the [releases](https://github.com/grafizum/kimi-cli-desktop/releases) page (artifacts named `Kimi-Code-Desktop-Web-…`), or:

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/grafizum/kimi-cli-desktop/kimi-web-desktop/install-web.ps1 | iex
```

**Linux / macOS (bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/grafizum/kimi-cli-desktop/kimi-web-desktop/install-web.sh | bash
```

> [!NOTE]
> The web edition is young: if the install scripts or `Web` assets are not on the latest release yet, build from source below or use the CLI edition meanwhile.

## How it works

```
┌────────────────────────────────────────────────┐
│  Kimi Code Desktop (Web edition)               │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │  Kimi chat UI                            │  │
│  │  (served by the CLI, rendered unmodified)│  │
│  └──────────────────────────────────────────┘  │
│   ▲ sandboxed webview · loopback only          │
└──────┼─────────────────────────────────────────┘
       │ spawns & supervises
       ▼
  `kimi web --no-open`   ← the real CLI, on your machine
       │
       ▼
  your ~/.kimi-code      ← your sessions, config, credentials (untouched)
```

- One `kimi web` server per app run, bound to `127.0.0.1` with a random token. The server never leaves your machine.
- The webview may load **only** that CLI-served loopback URL — enforced in the main process, not the page.
- The shell seeds its color scheme to match the app theme (light/dark) and skips the web UI's own first-run introduction — after that, every setting lives in the web UI itself, exactly as in a browser.
- If the server crashes or the CLI is updated, the app restarts it; the web UI re-opens where you were.

## Build from source

```bash
git clone -b kimi-web-desktop https://github.com/grafizum/kimi-cli-desktop.git
cd kimi-cli-desktop
npm install
npm start        # dev run (npm run dev adds DevTools + console forwarding)
npm run smoke    # dependency-free test suite
npm run dist     # build the installers for this OS
```

## Releasing

```bash
git tag web-v1.0.0 && git push origin web-v1.0.0
```
GitHub Actions builds Windows (NSIS + portable), Linux (AppImage x64/arm64) and macOS (dmg x64/arm64) artifacts — all prefixed `Kimi-Code-Desktop-Web-` — and attaches them to the tag's release. The CLI edition (`main` branch) releases with plain `v*` tags and never collides.

## Troubleshooting

- **"Kimi Code CLI not found"** — install the CLI (button in the window copies the command), or point Settings-free style: the app re-checks every few seconds and also honors an explicit path via `~/.config`-style settings file (`settings.json` → `kimiPath`).
- **The chat never loads** — make sure `kimi web --no-open` works in a terminal; the app only embeds what the CLI serves. A corporate proxy that intercepts `127.0.0.1` can break the webview.
- **Two apps installed** — they are separate programs; the CLI edition installs to its own folder. Uninstall either one from "Add or Remove Programs" without touching the other.

## Legal notice

This project is an independent, unofficial desktop shell around the publicly available, freely distributed `kimi` CLI. It contains no Moonshot code, assets, models or credentials, and it is not endorsed by or affiliated with Moonshot AI in any way. All product names, trademarks and registered trademarks are property of their respective owners. Use of the CLI through this shell is subject to the CLI's own terms; the shell itself is MIT-licensed.

## License

[MIT](LICENSE)
