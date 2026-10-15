'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..');
const target = process.argv[2] || process.platform;
const executable = target === 'win32' ? path.join(root, 'release', 'win-unpacked', 'LiteParse Portal.exe')
  : target === 'darwin' ? path.join(root, 'release', 'mac', 'LiteParse Portal.app', 'Contents', 'MacOS', 'LiteParse Portal')
  : path.join(root, 'release', 'linux-unpacked', 'liteparse-portal');
if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-package-'));
const args = ['--smoke-test', `--data-dir=${directory}`];
// Only CI/container verification disables Chromium's OS sandbox. Distributed launchers do not.
if (process.env.PORTAL_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
const env = { ...process.env, PORTAL_SMOKE_SCREENSHOT: path.join(root, 'release', `smoke-${target}.png`) };
delete env.ELECTRON_RUN_AS_NODE;
const child = target === 'win32' && process.platform !== 'win32'
  ? spawn('wine', [executable, ...args], { stdio: 'inherit', env })
  : spawn(executable, args, { stdio: 'inherit', env });
const timer = setTimeout(() => { console.error('Packaged smoke test timed out.'); child.kill(); }, 180000);
child.on('error', error => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); process.exitCode = code ?? 1; });
