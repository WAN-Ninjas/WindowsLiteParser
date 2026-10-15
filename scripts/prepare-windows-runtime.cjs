'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { path7za } = require('7zip-bin');
const URL = 'https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe';
const SHA256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b';
const NAMES = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll', 'concrt140.dll'];
async function prepare() {
  const destination = path.join(__dirname, '..', 'assets', 'windows-runtime');
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'checksums.json'), 'utf8'));
    const valid = await Promise.all([...NAMES, 'LICENSE.rtf'].map(async name => createHash('sha256').update(await fs.readFile(path.join(destination, name))).digest('hex') === manifest[name]));
    if (valid.every(Boolean)) { console.log('Application-local Microsoft C++ runtime verified.'); return; }
  } catch { /* Populate from the pinned Microsoft distribution. */ }
  const cache = path.join(os.tmpdir(), `liteparse-vcredist-${SHA256}.exe`);
  let bytes;
  try { bytes = await fs.readFile(cache); } catch { /* Download on first build. */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== SHA256) {
    const response = await fetch(URL, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Microsoft runtime download failed (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== SHA256) throw new Error('Microsoft runtime checksum mismatch.');
    await fs.writeFile(cache, bytes);
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-vcrt-'));
  try {
    if (process.platform !== 'win32') await fs.chmod(path7za, 0o755);
    const cabinets = [];
    for (let offset = bytes.indexOf('MSCF'); offset !== -1; offset = bytes.indexOf('MSCF', offset + 4)) {
      if (offset + 36 > bytes.length || bytes.readUInt32LE(offset + 4) !== 0) continue;
      const size = bytes.readUInt32LE(offset + 8);
      if (size > 36 && offset + size <= bytes.length) cabinets.push(bytes.subarray(offset, offset + size));
    }
    if (cabinets.length !== 2) throw new Error('Unexpected Microsoft runtime cabinet layout.');
    const extract = (file, target) => execFileSync(path7za, ['x', '-y', `-o${target}`, file], { stdio: 'pipe' });
    for (let index = 0; index < cabinets.length; index++) {
      const file = path.join(temporary, `${index}.cab`); await fs.writeFile(file, cabinets[index]); extract(file, path.join(temporary, String(index)));
    }
    const minimum = path.join(temporary, 'minimum');
    extract(path.join(temporary, '1', 'a12'), minimum);
    await fs.mkdir(destination, { recursive: true });
    for (const name of NAMES) await fs.copyFile(path.join(minimum, `${name}_amd64`), path.join(destination, name));
    await fs.copyFile(path.join(temporary, '0', 'u4'), path.join(destination, 'LICENSE.rtf'));
    const checksums = {};
    for (const name of [...NAMES, 'LICENSE.rtf']) checksums[name] = createHash('sha256').update(await fs.readFile(path.join(destination, name))).digest('hex');
    await fs.writeFile(path.join(destination, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n');
    console.log('Bundled application-local Microsoft C++ runtime (14.44.35211). No installer is run.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, NAMES };
