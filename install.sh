#!/usr/bin/env bash
#
# Kimi Code Desktop — one-command installer (Linux / macOS)
#
#   curl -fsSL https://raw.githubusercontent.com/grafizum/kimi-cli-desktop/main/install.sh | bash
#
# Downloads the latest release from GitHub and installs it:
#   • Linux  → ~/.local/bin/Kimi-Code-Desktop-<version>-<arch>.AppImage
#              (plus a desktop entry so it shows up in your app launcher)
#   • macOS  → ~/Downloads/Kimi-Code-Desktop-<version>-<arch>.dmg (opened for you)
#
# Requirements: curl (or wget) and, on Linux, FUSE for AppImages (Ubuntu ≥ 22.04
# ships it). If FUSE is unavailable the script falls back to extracting the
# AppImage into ~/.local/share/kimi-cli-desktop/ and runs it from there.
#
set -euo pipefail

REPO="grafizum/kimi-cli-desktop"
API="https://api.github.com/repos/${REPO}/releases/latest"
RAW="https://raw.githubusercontent.com/${REPO}/main"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
info() { printf '\033[2m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m\342\234\224 %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

# The app is a shell around the 'kimi' CLI - without it there is nothing to
# drive. Detection also covers stale-PATH situations after a fresh install.
have_kimi() {
  command -v kimi >/dev/null 2>&1 && return 0
  # Known install locations (covers shells with a stale PATH).
  [ -x "$HOME/.kimi-code/bin/kimi" ] && return 0
  [ -x "$HOME/.local/bin/kimi" ] && return 0
  return 1
}

ensure_kimi_cli() {
  if have_kimi; then ok "Kimi CLI found - the app is ready to use."; return; fi

  warn "The 'kimi' CLI (the engine this app runs) is not installed yet."
  ANSWER="n"
  if   [ "${KCD_INSTALL_CLI:-}" = "1" ]; then ANSWER="y"
  elif [ "${KCD_INSTALL_CLI:-}" = "0" ]; then ANSWER="n"
  elif [ -r /dev/tty ]; then
    # Ask on the TTY, not stdin - 'curl | bash' owns stdin.
    printf 'Install it now? [Y/n] ' >/dev/tty
    IFS= read -r ANSWER </dev/tty || ANSWER="n"
    ANSWER="${ANSWER%\r}"
    [ -z "$ANSWER" ] && ANSWER="y"
  fi
  case "$ANSWER" in
    n*|N*)
      say "Skipping for now. Install it any time with:"
      say "  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
      return ;;
  esac

  say "Installing the Kimi CLI ..."
  # Run the official installer from a file so its stdin reads never touch
  # this script's pipe, and so it can prompt freely on the TTY.
  TMP_CLI="$(mktemp)"
  if download "https://code.kimi.com/kimi-code/install.sh" "$TMP_CLI" \
     && sh "$TMP_CLI" </dev/null; then
    # stdin=/dev/null so the installer never consumes this script's pipe
    # ('curl | bash'); its output flows to the user's console.
    rm -f "$TMP_CLI"
  else
    rm -f "$TMP_CLI"
    warn "Could not run the CLI installer - do it manually:"
    warn "  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
    return
  fi
  if have_kimi; then ok "Kimi CLI installed - everything is ready."
  else info "CLI installed. Open a NEW terminal (or just launch the app) so PATH changes take effect."; fi
}

download() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "Need curl or wget to download the release."
  fi
}

# ---------------------------------------------------------------------------
# Detect OS + arch
# ---------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="macos" ;;
  *) die "Unsupported OS: $OS (install manually from GitHub Releases)." ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="x86_64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $(uname -m) (install manually from GitHub Releases)." ;;
esac

# ---------------------------------------------------------------------------
# Resolve the latest release asset
# ---------------------------------------------------------------------------
say "Resolving the latest release of ${REPO} ($OS/$ARCH)…"
TMP_JSON="$(mktemp)"
download "$API" "$TMP_JSON"
RELEASE_JSON="$(cat "$TMP_JSON")"
rm -f "$TMP_JSON"

# No jq dependency: pull every browser_download_url, keep the ones for this OS.
ASSET_URLS="$(printf '%s\n' "$RELEASE_JSON" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\(.*\)"/\1/')"

case "$OS" in
  # electron-builder spells the arch differently per OS: Linux x64 assets are
  # named "x86_64", macOS/Windows ones are named "x64". Anchored to
  # CLI-EDITION assets (NO "Web-"): the repo also publishes a Web edition
  # (Kimi-Code-Desktop-Web-*) and releases/latest points at the newest tag of
  # EITHER edition, so a bare match could install the wrong app.
  linux) ASSET="$(printf '%s\n' "$ASSET_URLS" | grep -v "Web-" | grep -F ".AppImage" | grep -F "$ARCH" | head -n 1 || true)" ;;
  macos)
    MAC_ARCH="x64"; [ "$ARCH" = "arm64" ] && MAC_ARCH="arm64"
    ASSET="$(printf '%s\n' "$ASSET_URLS" | grep -v "Web-" | grep -F ".dmg" | grep -F "$MAC_ARCH" | head -n 1 || true)" ;;
esac

[ -n "$ASSET" ] || die "No release asset for ${OS}/${ARCH} yet. Publish a release first, or install from source (see the README)."

ASSET_NAME="$(basename "$ASSET")"
VERSION="$(printf '%s\n' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\(.*\)"/\1/' || true)"

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
if [ "$OS" = "macos" ]; then
  DEST="$HOME/Downloads/$ASSET_NAME"
  say "Downloading $ASSET_NAME…"
  download "$ASSET" "$DEST"
  say "Opening the DMG — drag the app into your Applications folder to install."
  open "$DEST" 2>/dev/null || warn "Could not auto-open; the DMG is at: $DEST"
  exit 0
fi

# --- Linux ---------------------------------------------------------------
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPIMAGE="$BIN_DIR/Kimi-Code-Desktop.AppImage"
mkdir -p "$BIN_DIR"

say "Downloading $ASSET_NAME…"
download "$ASSET" "$APPIMAGE"
chmod +x "$APPIMAGE"

# AppImages need FUSE; fall back to extracting when it is unavailable.
if ! "$APPIMAGE" --appimage-version >/dev/null 2>&1; then
  warn "FUSE not available — extracting the AppImage instead."
  EXTRACT_DIR="$HOME/.local/share/kimi-cli-desktop"
  mkdir -p "$EXTRACT_DIR"
  ( cd "$EXTRACT_DIR" && "$APPIMAGE" --appimage-extract >/dev/null 2>&1 )
  cat > "$BIN_DIR/Kimi-Code-Desktop" <<EOF
#!/usr/bin/env bash
exec "$EXTRACT_DIR/squashfs-root/AppRun" "\$@"
EOF
  chmod +x "$BIN_DIR/Kimi-Code-Desktop"
  APPIMAGE="$BIN_DIR/Kimi-Code-Desktop"
fi

# Desktop entry so it appears in the app launcher.
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"
download "$RAW/assets/icon.png" "$DESKTOP_DIR/kimi-cli-desktop.png" 2>/dev/null || true
cat > "$DESKTOP_DIR/kimi-cli-desktop.desktop" <<EOF
[Desktop Entry]
Name=Kimi Code Desktop
Comment=Desktop shell for the Kimi Code CLI
Exec=$APPIMAGE %F
Icon=$DESKTOP_DIR/kimi-cli-desktop.png
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=Kimi Code Desktop
EOF
chmod +x "$DESKTOP_DIR/kimi-cli-desktop.desktop"

say "Installed: $APPIMAGE${VERSION:+ (release $VERSION)}"
ensure_kimi_cli
printf '\n'
ok "Kimi Code Desktop was installed successfully."
info "Launch it from your app menu, or run: $APPIMAGE"