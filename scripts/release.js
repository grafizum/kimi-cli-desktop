'use strict';

// One-command release:  node scripts/release.js [--yes] [--skip-e2e] [version]
//
// Replaces the manual dance (bump package.json → commit → tag → push → wait →
// hope the assets appear) that once shipped a tag built from the wrong tree:
// the tests ran green on main, but the tagged commit predated the fix.
// This script makes that structurally impossible:
//   1. refuses a dirty tree (content-wise; a mode-only diff is tolerated),
//   2. runs the smoke suite, and the e2e suite unless --skip-e2e,
//   3. commits the version bump, tags it, pushes main + tag,
//   4. watches the Release workflow until it finishes,
//   5. verifies releases/latest carries every installer and that the
//      releases/latest/download/<asset> URLs the install scripts use respond.
//
// No commit it makes ever carries contributor/attribution trailers.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'grafizum/kimi-cli-desktop';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const YES = args.includes('--yes');
const SKIP_E2E = args.includes('--skip-e2e');
const versionArg = args.find((a) => !a.startsWith('--'));

const say = (m) => console.log(`==> ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);
const die = (m) => {
  console.error(`\n!! ${m}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sh(cmd, cmdArgs, opts = {}) {
  // stdio: 'inherit' makes execFileSync return null — callers rely on a string.
  const out = execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts });
  return out == null ? '' : String(out).trim();
}

function git(argv, opts) {
  return sh('git', argv, opts);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'kcd-release-script' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1.0.0-beta.2 → 1.0.0-beta.3 · 1.2.3 → 1.2.4 · 1.2 → 1.3
function bumpVersion(v) {
  return v.replace(/(\d+)(?!.*\d)/, (n) => String(Number(n) + 1));
}

// Asset names the Release workflow must attach (electron-builder artifactName
// patterns in package.json; the install scripts match on exactly these).
function expectedAssets(v) {
  return [
    `Kimi-Code-Desktop-${v}-x64-portable.exe`,
    `Kimi-Code-Desktop-Setup-${v}-x64.exe`,
    `Kimi-Code-Desktop-${v}-x86_64.AppImage`,
    `Kimi-Code-Desktop-${v}-arm64.AppImage`,
    `Kimi-Code-Desktop-${v}-x64.dmg`,
    `Kimi-Code-Desktop-${v}-arm64.dmg`,
  ];
}

function askProceed() {
  if (YES) return;
  if (!process.stdin.isTTY) die('Non-interactive shell: pass --yes to proceed.');
  fs.writeSync(1, 'Proceed? [y/N] ');
  const buf = Buffer.alloc(16);
  const n = fs.readSync(0, buf, 0, 16, null);
  if (!/^y(es)?$/i.test(buf.slice(0, n).toString().trim())) {
    die('Aborted — nothing was changed.');
  }
}

// ---------------------------------------------------------------------------
// Main (async: steps 4–6 poll the GitHub API)
// ---------------------------------------------------------------------------
async function main() {
  // -- 1. Preflight ---------------------------------------------------------
  say('Checking the working tree …');

  // -z: NUL-separated so paths with spaces survive, and XY is always exactly
  // 2 columns + one space before the path.
  const porcelain = git(['status', '--porcelain', '-z']).split('\0').filter(Boolean);
  const dirty = [];
  for (const entry of porcelain) {
    // Renames emit a second NUL field (the original path) with no XY prefix.
    if (!/^..\s/.test(entry.slice(0, 3))) continue;
    const file = entry.slice(3);
    // "M " (staged column) or " M " (worktree column) — the WSL/Windows shared
    // checkout reports the mode-only flip in either form.
    if (/^ ?M /.test(entry)) {
      // A mode-only change (0 added / 0 deleted) has no content: on Windows
      // checkouts of Linux-shared repos the executable bit flips like this and
      // is not a real modification. Anything else aborts the release.
      const numstat = git(['diff', '--numstat', '--', file]).trim();
      if (/^0\t0\t/.test(numstat)) continue;
    }
    dirty.push(entry);
  }
  if (dirty.length) {
    die(`Working tree is not clean:\n${dirty.join('\n')}\nCommit or stash first — a release tag must point at a committed, pushed tree.`);
  }
  ok('working tree clean (content-wise)');

  git(['fetch', 'origin', 'main']);
  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'origin/main']);
  if (local !== remote) {
    die(`Local main (${local.slice(0, 8)}) and origin/main (${remote.slice(0, 8)}) differ.\nPush or pull first — the release must go out from a tree everyone can see.`);
  }
  ok('main is in sync with origin/main');

  const pkgPath = path.join(ROOT, 'package.json');
  const rawPkg = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawPkg);
  const version = versionArg ? versionArg.replace(/^v/, '') : bumpVersion(pkg.version);
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die(`Invalid version: ${version}`);
  const tag = `v${version}`;
  if (git(['tag', '-l']).split('\n').includes(tag)) {
    die(`Tag ${tag} already exists. Bump again or pass a different version.`);
  }
  say(`Version: ${pkg.version} → ${version}  (tag ${tag})`);

  // -- 2. Tests: the gate that would have caught the wrong-tree release -----
  say('Running the smoke suite …');
  sh(process.execPath, ['scripts/smoke-test.js'], { stdio: 'inherit' });
  ok('smoke suite passed');

  if (SKIP_E2E) {
    console.log('  – skipping e2e (--skip-e2e) — NOT recommended for a release');
  } else {
    say('Running the e2e suite (real Electron window, fake kimi) …');
    sh(process.execPath, ['scripts/e2e-test.js'], { stdio: 'inherit' });
    ok('e2e suite passed');
  }

  // -- 3. Confirm -----------------------------------------------------------
  console.log(`\nAbout to release ${tag}:
  • commit the package.json version bump,
  • tag it, push main + tag,
  • wait for the Release workflow (all 3 OSes), then verify the assets
    and the installer download URLs.\n`);
  askProceed();

  // -- 4. Commit the bump, tag, push ---------------------------------------
  const bumped = rawPkg.replace(
    new RegExp(`("version":\\s*)"${pkg.version.replace(/\./g, '\\.')}"`),
    `$1"${version}"`
  );
  if (!bumped.includes(`"version": "${version}"`)) {
    die(`Could not bump the version in package.json — unexpected formatting.`);
  }
  fs.writeFileSync(pkgPath, bumped);

  git(['add', 'package.json']);
  // Deliberately plain: no generated-by / co-author trailers, ever.
  git(['commit', '-m', `Release ${version}`]);
  git(['tag', '-a', tag, '-m', `Kimi Code Desktop ${version}`]);

  say('Pushing main and the tag …');
  git(['push', 'origin', 'main']);
  git(['push', 'origin', tag]);
  ok(`pushed ${tag} (${git(['rev-parse', 'HEAD']).slice(0, 8)})`);

  // -- 5. Watch the Release run --------------------------------------------
  say('Waiting for the Release workflow to appear …');
  const sha = git(['rev-parse', 'HEAD']);
  let run = null;
  for (let i = 0; i < 60 && !run; i++) {
    await sleep(10_000);
    const data = await fetchJson(
      `https://api.github.com/repos/${REPO}/actions/runs?branch=${tag}&per_page=5`
    ).catch(() => null);
    run = data && data.workflow_runs && data.workflow_runs.find((r) => r.head_sha === sha);
  }
  if (!run) {
    die(`No Release run appeared for ${tag} within 10 minutes.\nCheck https://github.com/${REPO}/actions`);
  }
  ok(`Release run started: ${run.html_url}`);

  const deadline = Date.now() + 40 * 60 * 1000;
  while (run.status !== 'completed') {
    if (Date.now() > deadline) {
      die(`Release run is still running after 40 minutes: ${run.html_url}`);
    }
    await sleep(20_000);
    const fresh = await fetchJson(
      `https://api.github.com/repos/${REPO}/actions/runs/${run.id}`
    ).catch(() => null);
    if (fresh) run = { ...run, ...fresh };
  }
  if (run.conclusion !== 'success') {
    die(`Release run ${run.conclusion}: ${run.html_url}\nFix, then re-point the tag:\n  git tag -d ${tag} && git push origin :refs/tags/${tag}\n… commit the fix … and run this script again.`);
  }
  ok('Release run succeeded');

  // -- 6. Verify the published release + the URLs the install scripts use --
  say('Verifying the published release …');
  const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (rel.tag_name !== tag) {
    die(`releases/latest is ${rel.tag_name}, expected ${tag}`);
  }
  ok(`releases/latest → ${rel.tag_name} (draft: ${rel.draft}, prerelease: ${rel.prerelease})`);

  const missing = expectedAssets(version).filter(
    (name) => !rel.assets.some((a) => a.name === name)
  );
  if (missing.length) {
    die(`Release is missing assets:\n  ${missing.join('\n  ')}`);
  }
  ok(`all ${expectedAssets(version).length} installers attached`);

  const bad = [];
  for (const name of expectedAssets(version)) {
    const res = await fetch(
      `https://github.com/${REPO}/releases/latest/download/${name}`,
      { method: 'HEAD' }
    ).catch(() => ({ status: 0 }));
    if (res.status !== 200) bad.push(`${name} → HTTP ${res.status}`);
  }
  if (bad.length) die(`Download URLs broken:\n  ${bad.join('\n  ')}`);
  ok('every releases/latest/download URL answers 200');

  console.log(`
${tag} is live. Users get it through:
  irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
`);
}

main().catch((err) => die(err.stack || err.message || String(err)));
