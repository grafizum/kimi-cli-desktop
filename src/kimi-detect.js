'use strict';

// Locate the `kimi` (Kimi Code CLI) executable on this machine and read its version.
// Pure Node module — no Electron APIs — so it can be unit-tested standalone.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// The e2e suite ships a fake `kimi` (test-fixtures/bin) that prints unmistakable
// markers instead of the real TUI. If that double ever wins detection outside a
// test run, the app starts a fake agent in a real session — which is exactly
// what a stray, interrupted e2e window once did. Refuse it everywhere.
// KCD_TEST_HARNESS=1 (set by the suites themselves) is the only way it is
// accepted, and a test window additionally labels itself in the UI.
// ---------------------------------------------------------------------------
const FAKE_KIMI_PATH_RE = /(^|[\\/])test-fixtures[\\/]bin([\\/]|$)/;
const FAKE_KIMI_OUTPUT_RE = /9\.9\.9-test|KIMI-TUI-STARTED|YOU-TYPED:/;

function isTestDouble(bin, probeOutput) {
  return FAKE_KIMI_PATH_RE.test(String(bin)) || FAKE_KIMI_OUTPUT_RE.test(String(probeOutput));
}

function isWindows() {
  return process.platform === 'win32';
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A .cmd/.bat shim must be launched through cmd.exe; anything else is spawned
// directly. Returns { file, args, ptyArgs, wrapped }:
//   args    — for child_process.spawn with windowsVerbatimArguments (see run()):
//             the command line is double-wrapped so `cmd /s` strips the outer
//             pair and still parses inner quoted paths correctly.
//   ptyArgs — for node-pty, which quotes space-containing args itself, so it
//             gets the single-wrapped form and ends up with the same cmdline.
// Without this care, a space anywhere in the shim path (e.g. "Program Files",
// "OneDrive folders") makes cmd truncate the command at the space and fail.
function buildSpawn(bin, args = []) {
  bin = expandHome(bin);
  const lower = bin.toLowerCase();
  if (isWindows() && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    // `cmd /d /c call <shim> <args…>` with RAW argv: both child_process.spawn
    // and node-pty quote space-containing arguments themselves (MSVCRT rules),
    // and `call` makes cmd re-parse its argument line with normal batch rules,
    // so quoted paths/args survive intact. Two traps this avoids: a bare /c
    // strips the outer quotes of the tail when it starts with a quote, which
    // truncates the command at the first space in the shim path (e.g.
    // "Program Files", OneDrive folders), and /s forces that stripping even when
    // quoting would otherwise work.
    return { file: 'cmd.exe', args: ['/d', '/c', 'call', bin, ...args], wrapped: true };
  }
  return { file: bin, args, wrapped: false };
}

function exists(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// cmd.exe (used to run .cmd shims and npm on Windows) misbehaves when started
// on a UNC path (\\wsl.localhost\..., network shares): it prints a warning to
// stdout and can refuse to execute the script. Probe commands never need the
// project's cwd, so fall back to a safe local directory in that case.
function safeCwd() {
  try {
    const cwd = process.cwd();
    if (/^\\\\/.test(cwd)) return os.tmpdir();
    return cwd;
  } catch {
    return os.tmpdir();
  }
}

// Run a command, capturing stdout+stderr, with a timeout. Resolves
// { code, stdout, stderr } — never rejects (kills the child on timeout).
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
    child = spawn(file, args, {
      env: opts.env || process.env,
      cwd: opts.cwd || safeCwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, opts.timeout || VERSION_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

// Ask `kimi --version` to confirm a candidate and learn its version.
async function probe(bin, env) {
  if (!exists(bin)) return null;
  const { file, args } = buildSpawn(bin, ['--version']);
  const res = await run(file, args, { env });
  const combined = `${res.stdout} ${res.stderr}`.trim();
  // Require a real version-looking token: a failed cmd.exe invocation prints an
  // error line that still names the binary, which must not count as a probe hit.
  const versionMatch = combined.match(/(?:^|\s)(v?\d+\.\d+\.\d+(?:-[^\s]+)?)/);
  if (!versionMatch) return null;
  return { path: bin, version: versionMatch[1], source: 'explicit', testDouble: isTestDouble(bin, combined) };
}

function findOnPath(env) {
  return new Promise((resolve) => {
    const cmd = isWindows() ? 'where' : 'which';
    execFile(cmd, ['kimi'], { env, windowsHide: true, cwd: safeCwd() }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

function npmGlobalBin(env) {
  return new Promise((resolve) => {
    execFile('npm', ['prefix', '-g'], { env, windowsHide: true, cwd: safeCwd() }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const prefix = stdout.trim().split(/\r?\n/)[0];
      if (!prefix) return resolve(null);
      const binDir = isWindows() ? prefix : path.join(prefix, 'bin');
      const name = isWindows() ? 'kimi.cmd' : 'kimi';
      resolve(path.join(binDir, name));
    });
  });
}

function commonCandidates(env) {
  const home = os.homedir();
  const list = [];
  const win = isWindows();
  if (win) {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(
      path.join(localAppData, 'Programs', 'kimi', 'kimi.exe'),
      path.join(localAppData, 'Programs', 'Kimi', 'kimi.exe'),
      path.join(home, '.local', 'bin', 'kimi.exe'),
      path.join(home, '.kimi-code', 'bin', 'kimi.exe'),
      path.join(roaming, 'npm', 'kimi.cmd')
    );
  } else {
    list.push(
      path.join(home, '.local', 'bin', 'kimi'),
      path.join(home, '.kimi-code', 'bin', 'kimi'),
      '/usr/local/bin/kimi',
      '/opt/homebrew/bin/kimi',
      '/usr/bin/kimi'
    );
  }
  return [...new Set(list)];
}

// --------------------------------------------------------------------------
// WSL support — kimi may be installed inside a Linux distro (WSL) rather than
// on Windows itself. The Linux binary can't be executed directly from Windows,
// so we run it through `wsl.exe` and read its data directory via the UNC
// filesystem (\\wsl.localhost\<distro>\...).
// --------------------------------------------------------------------------

// wsl.exe often writes UTF-16LE to stdout. Recover the plain text.
function decodeWslOutput(str) {
  if (String(str).includes('\u0000')) {
    return Buffer.from(String(str), 'latin1').toString('utf16le').replace(/^\uFEFF/, '');
  }
  return String(str);
}

// List WSL distros ({ name }). Empty array when WSL is unavailable.
async function wslDistros(env) {
  if (!isWindows()) return [];
  const res = await run('wsl.exe', ['-l', '-q'], { env, timeout: 20000 });
  if (res.code !== 0) return [];
  const text = decodeWslOutput(res.stdout || res.stderr);
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// Run a bash command inside a WSL distro.
async function wslExec(distro, bashCmd, env, timeout) {
  const res = await run('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', bashCmd], {
    env,
    timeout: timeout || 30000,
  });
  return { code: res.code, stdout: decodeWslOutput(res.stdout), stderr: decodeWslOutput(res.stderr) };
}

// Map a Linux path inside a distro to a Windows UNC path.
function linuxToWindowsUnc(distro, linuxPath) {
  if (!linuxPath || !linuxPath.startsWith('/')) return null;
  const rel = linuxPath.replace(/^\//, '').replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}\\${rel}`;
}

// Probe one distro for a kimi binary. Returns null when not installed.
async function probeWslDistro(distro, env, allowTestDouble = false) {
  // Multiline bash so the for-loop keeps valid `do` / `done` structure.
  const cmd = [
    'kimi_path=""',
    'for c in "$(command -v kimi 2>/dev/null)" "$HOME/.kimi-code/bin/kimi" "$HOME/.local/bin/kimi" "$HOME/bin/kimi" "/usr/local/bin/kimi"; do',
    '  [ -n "$c" ] && [ -x "$c" ] && kimi_path="$c" && break',
    'done',
    'echo "KIMI_PATH=$kimi_path"',
    'echo "WSL_HOME=$HOME"',
    'echo "WSL_USER=$(id -un 2>/dev/null)"',
    'if [ -d "$HOME/.kimi-code" ]; then echo "HAS_HOME=1"; else echo "HAS_HOME=0"; fi',
  ].join('\n');

  const res = await wslExec(distro, cmd, env);
  if (res.code !== 0 && res.code !== 1) return null;

  const info = {};
  for (const line of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) {
    const m = line.match(/^(KIMI_PATH|WSL_HOME|WSL_USER|HAS_HOME)=(.*)$/);
    if (m) info[m[1]] = m[2];
  }
  if (!info.KIMI_PATH || !info.WSL_HOME) return null;

  // Confirm it really runs and read its version.
  const ver = await wslExec(distro, `'${info.KIMI_PATH}' --version`, env, 30000);
  const combined = `${ver.stdout} ${ver.stderr}`.trim();
  const version = (combined.match(/(?:^|\s)(v?\d+\.\d+\.\d+(?:-[^\s]+)?)/) || [])[1] || null;
  if (!version) return null;
  // A test double inside a distro is just as unacceptable as a native one.
  if (isTestDouble(info.KIMI_PATH, combined) && !allowTestDouble) return null;

  const kimiCodeHome = info.HAS_HOME === '1' ? `${info.WSL_HOME}/.kimi-code` : null;
  return {
    distro,
    user: info.WSL_USER || '',
    home: info.WSL_HOME,
    kimiPath: info.KIMI_PATH,
    kimiCodeHome,
    kimiCodeHomeWindows: kimiCodeHome ? linuxToWindowsUnc(distro, kimiCodeHome) : null,
    version,
  };
}

// Search all distros for kimi. Returns a detection-shaped result or null.
async function detectWsl(env, allowTestDouble = false) {
  if (!isWindows()) return null;
  const distros = await wslDistros(env);
  if (!distros.length) return null;
  // Probe distros in parallel (results keep distro order, so the first one
  // with kimi still wins) — sequentially probing each distro could take many
  // seconds on machines that have several installed.
  const probed = await Promise.all(
    distros.map((distro) => probeWslDistro(distro, env, allowTestDouble).catch(() => null))
  );
  const wsl = probed.find((r) => r && r.kimiPath);
  if (wsl) {
    return { found: true, path: wsl.kimiPath, version: wsl.version || 'unknown', source: 'wsl', wsl };
  }
  return null;
}

// Full detection flow. `opts`:
//   explicitPath  — a user-configured path that takes priority (still probed)
//   env           — environment override (tests)
// Returns { found, path, version, source, checked: [...] }
// Probe a single candidate and return a detection result, or null when the
// file is missing / not a working kimi binary.
async function probeCandidate(bin, env, source, checked) {
  checked.push(bin);
  if (!exists(bin)) return null;
  const hit = await probe(bin, env);
  if (!hit) return null;
  // A detected test double is carried through with found:false so detect() can
  // refuse it as a *decision* rather than silently falling through to other
  // candidates (falling through could mask the mistake).
  if (hit.testDouble) {
    return { found: false, testDouble: true, path: hit.path, version: hit.version, source, checked };
  }
  return { found: true, path: hit.path, version: hit.version, source, checked };
}

function refuseTestDouble(hit) {
  console.error(
    `[kimi-detect] refusing the e2e test-double kimi at ${hit.path} — ` +
    'a fake CLI must never run real sessions. Test suites opt in via KCD_TEST_HARNESS=1.'
  );
  return { found: false, path: null, version: null, source: null, checked: hit.checked };
}

async function detect(opts = {}) {
  const env = opts.env || process.env;
  const checked = [];
  // Only a real test harness (the suites set this) may accept the fake CLI.
  const testHarness = env.KCD_TEST_HARNESS === '1';
  const accept = (hit) => {
    if (!hit || !hit.testDouble) return hit;
    if (!testHarness) return refuseTestDouble(hit);
    // Harness opt-in: the suites may use the fake CLI.
    return { ...hit, found: true };
  };

  // The npm-prefix lookup spawns a whole npm process and used to sit on the
  // critical path before *any* candidate was checked. Kick it off in the
  // background instead and only await it if the faster checks miss.
  const npmBinPromise = npmGlobalBin(env).catch(() => null);

  // 1. An explicitly configured path wins, and short-circuits detection.
  if (opts.explicitPath) {
    const hit = await probeCandidate(expandHome(opts.explicitPath), env, 'configured', checked);
    if (hit) return accept(hit);
  }

  // 2. PATH — one `where`/`which` call, the common case (fast path).
  const onPath = await findOnPath(env);
  if (onPath) {
    const hit = await probeCandidate(onPath, env, 'auto', checked);
    if (hit) return accept(hit);
  }

  // 3. npm's global bin (the lookup started above).
  const npmBin = await npmBinPromise;
  if (npmBin) {
    const hit = await probeCandidate(npmBin, env, 'auto', checked);
    if (hit) return accept(hit);
  }

  // 4. Well-known install locations.
  for (const cand of commonCandidates(env)) {
    const hit = await probeCandidate(cand, env, 'auto', checked);
    if (hit) return accept(hit);
  }

  // 5. Fall back to WSL: the CLI may be installed inside a Linux distro.
  if (opts.allowWsl !== false) {
    const wslResult = await detectWsl(env, testHarness);
    if (wslResult) {
      wslResult.checked = checked;
      return wslResult;
    }
  }
  return { found: false, path: null, version: null, source: null, checked };
}

module.exports = {
  detect, probe, buildSpawn, expandHome, commonCandidates, isWindows, run,
  detectWsl, wslDistros, wslExec, linuxToWindowsUnc, decodeWslOutput, isTestDouble,
};