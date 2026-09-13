'use strict';
// Probe WSL mechanics used by the app (temporary diagnostic, kept for tests)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function wslList() {
  const raw = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
  return raw.toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function wslExec(distro, cmd) {
  try {
    return execFileSync('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', cmd], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '__ERR__:' + (e.stderr ? e.stderr.toString().trim() : e.message);
  }
}

const distros = wslList();
console.log('distros:', JSON.stringify(distros));

for (const d of distros) {
  const home = wslExec(d, 'echo $HOME');
  const user = wslExec(d, 'id -un');
  console.log(`\n[${d}] home=${home} user=${user}`);

  // UNC variants
  const uncs = [
    `\\\\wsl.localhost\\${d}${home}\\.kimi-code`,
    `\\\\wsl$\\${d}${home}\\.kimi-code`,
  ];
  for (const unc of uncs) {
    const sessions = path.join(unc, 'sessions');
    console.log('  UNC', unc, '-> exists:', fs.existsSync(unc), '| sessions:', fs.existsSync(sessions));
    if (fs.existsSync(sessions)) {
      try {
        const dirs = fs.readdirSync(sessions);
        console.log('    session buckets:', dirs.slice(0, 3).join(', '));
        if (dirs.length) {
          const inner = fs.readdirSync(path.join(sessions, dirs[0]));
          const first = path.join(sessions, dirs[0], inner[0], 'state.json');
          const state = JSON.parse(fs.readFileSync(first, 'utf8'));
          console.log('    state keys:', Object.keys(state).join(','));
          console.log('    title:', JSON.stringify(state.title), 'cwd:', JSON.stringify(state.cwd));
        }
      } catch (e) { console.log('    read err:', e.message); }
    }
  }
}