'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const target = process.argv[2] || process.platform;
const appImage = target === 'appimage';
if (appImage && process.platform !== 'linux') throw new Error('AppImage smoke tests require a Linux host.');
const version = require('../package.json').version;
const appImageArch = process.arch === 'x64' ? 'x86_64' : process.arch;
let executable = appImage ? path.join(root, 'release', `LiteParse-Portal-${version}-linux-${appImageArch}.AppImage`)
  : target === 'win32' ? path.join(root, 'release', 'win-unpacked', 'LiteParse Portal.exe')
  : target === 'darwin' ? path.join(root, 'release', 'mac', 'LiteParse Portal.app', 'Contents', 'MacOS', 'LiteParse Portal')
  : path.join(root, 'release', 'linux-unpacked', 'liteparse-portal');
if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-package-'));
let expectedDatabase;
if (appImage) {
  // Exercise the real launcher and its default portable-data path, isolated from user data.
  const folder = path.join(directory, 'AppImage folder'); fs.mkdirSync(folder);
  const copy = path.join(folder, path.basename(executable)); fs.copyFileSync(executable, copy);
  fs.chmodSync(copy, 0o755); executable = copy;
  expectedDatabase = path.join(folder, 'LiteParse Portal Data', 'portal.sqlite');
}
const args = appImage ? ['--smoke-test'] : ['--smoke-test', `--data-dir=${directory}`];
// Only CI/container verification disables Chromium's OS sandbox. Distributed launchers do not.
if (process.env.PORTAL_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
const mode = appImage && process.env.PORTAL_TEST_APPIMAGE_EXTRACT === '1' ? 'appimage-extracted' : target;
const env = { ...process.env, PORTAL_SMOKE_SCREENSHOT: path.join(root, 'release', `smoke-${mode}.png`) };
delete env.ELECTRON_RUN_AS_NODE;
if (appImage) {
  delete env.APPIMAGE; delete env.APPDIR; delete env.PORTABLE_EXECUTABLE_DIR;
  env.XDG_CONFIG_HOME = path.join(directory, 'config');
  env.XDG_CACHE_HOME = path.join(directory, 'cache');
  env.APPIMAGELAUNCHER_DISABLE = '1';
  if (process.env.PORTAL_TEST_APPIMAGE_EXTRACT === '1') env.APPIMAGE_EXTRACT_AND_RUN = '1';
  else delete env.APPIMAGE_EXTRACT_AND_RUN;
}
const child = target === 'win32' && process.platform !== 'win32'
  ? spawn('wine', [executable, ...args], { stdio: 'inherit', env, detached: true })
  : spawn(executable, args, { stdio: 'inherit', env, detached: process.platform !== 'win32' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true; console.error('Packaged smoke test timed out. Terminating its process tree.');
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); } }
}, 180000);
child.on('error', error => { console.error(error.message); clearTimeout(timer); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  let result = timedOut ? 1 : code ?? 1;
  if (result === 0 && expectedDatabase) {
    if (!fs.existsSync(expectedDatabase)) { console.error('AppImage did not keep its database beside the downloaded executable.'); result = 1; }
    else console.log('APPIMAGE PORTABILITY PASSED: default database is beside the AppImage, including paths with spaces.');
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exitCode = result;
});
