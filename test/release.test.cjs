'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateVersion, assetNames, prepareAssets, checkRemoteAssets } = require('../scripts/release.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of assetNames('1.2.3')) {
    const header = Buffer.alloc(16);
    if (name.endsWith('.exe')) header.write('MZ');
    else if (name.endsWith('.zip')) Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(header);
    else if (name.endsWith('.tar.gz')) Buffer.from([0x1f, 0x8b]).copy(header);
    else { Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header); Buffer.from([0x41, 0x49, 0x02]).copy(header, 8); }
    await fs.writeFile(path.join(directory, name), header);
  }
  return directory;
}

test('release tags must match package and lock versions, including prerelease versions', () => {
  assert.deepEqual(validateVersion('1.2.3', '1.2.3', 'v1.2.3'), { version: '1.2.3', tag: 'v1.2.3', prerelease: false });
  assert.equal(validateVersion('1.2.3-rc.1', '1.2.3-rc.1', 'v1.2.3-rc.1').prerelease, true);
  assert.equal(validateVersion('1.2.3+build.2', '1.2.3+build.2').prerelease, false);
  assert.throws(() => validateVersion('1.2.3', '1.2.4', 'v1.2.3'), /must match/);
  assert.throws(() => validateVersion('1.2.3', '1.2.3', 'v2.0.0'), /does not match/);
  for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3;echo bad']) assert.throws(() => validateVersion(version, version));
});

test('release preparation hashes exactly the four expected downloads and excludes debug/source files', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'smoke-review.png'), 'debug screenshot');
  const names = await prepareAssets(directory, '1.2.3');
  assert.equal(names.length, 5); assert.equal(names.at(-1), 'SHA256SUMS.txt');
  const lines = (await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const [hash, name] = line.split(/\s+/);
    assert.ok(assetNames('1.2.3').includes(name));
    assert.equal(hash, createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex'));
  }
});

test('incomplete or incorrect-format release downloads cannot be published', async t => {
  const directory = await fixture(t);
  const name = assetNames('1.2.3')[0];
  await fs.rm(path.join(directory, name));
  await assert.rejects(prepareAssets(directory, '1.2.3'), /ENOENT/);
  await fs.writeFile(path.join(directory, name), '<html>download failed</html>');
  await assert.rejects(prepareAssets(directory, '1.2.3'), /unexpected file format/);
  await fs.writeFile(path.join(directory, name), '');
  await assert.rejects(prepareAssets(directory, '1.2.3'), /nonempty regular file/);
});

test('publication verifies every uploaded filename and size before making a draft public', () => {
  const names = [...assetNames('1.2.3'), 'SHA256SUMS.txt'];
  const release = { assets: names.map(name => ({ name, size: 16 })) };
  const sizes = new Map(names.map(name => [name, 16]));
  assert.doesNotThrow(() => checkRemoteAssets(release, names, sizes));
  assert.throws(() => checkRemoteAssets({ assets: release.assets.slice(1) }, names, sizes), /missing required/);
  assert.throws(() => checkRemoteAssets({ isDraft: true, assets: [...release.assets, { name: 'unexpected.pdf', size: 12 }] }, names, sizes), /unexpected assets/);
  sizes.set(names[0], 17);
  assert.throws(() => checkRemoteAssets(release, names, sizes), /sizes do not match/);
});
