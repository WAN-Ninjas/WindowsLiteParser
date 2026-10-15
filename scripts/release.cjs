'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function validateVersion(version, lockVersion, tag = '') {
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('package.json must contain a valid semantic version.');
  if (lockVersion !== version) throw new Error('package.json and package-lock.json versions must match.');
  if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version v${version}.`);
  return { version, tag: `v${version}`, prerelease: Boolean(versionPattern.exec(version)[4]) };
}

function assetNames(version) {
  validateVersion(version, version);
  return [
    `LiteParse-Portal-${version}-win-x64.exe`,
    `LiteParse-Portal-${version}-win-x64.zip`,
    `LiteParse-Portal-${version}-linux-x86_64.AppImage`,
    `LiteParse-Portal-${version}-linux-x64.tar.gz`
  ].sort();
}

async function prepareAssets(directory, version) {
  const names = assetNames(version);
  const lines = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || !stat.size) throw new Error(`Release asset is not a nonempty regular file: ${name}`);
    const file = await fs.open(filename, 'r');
    const header = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    const valid = name.endsWith('.exe') ? header.subarray(0, 2).equals(Buffer.from('MZ'))
      : name.endsWith('.zip') ? header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      : name.endsWith('.tar.gz') ? header.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
      : header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]));
    if (!valid) throw new Error(`Release asset has an unexpected file format: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  return [...names, 'SHA256SUMS.txt'];
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `GitHub CLI failed (${result.status}).`);
  return result.stdout;
}

function currentRelease(tag) {
  // Listing is read-only and works even when a previous attempt left a draft.
  // An existing published release is never overwritten, including on workflow reruns.
  const releases = JSON.parse(gh(['release', 'list', '--limit', '1000', '--json', 'tagName,isDraft']));
  return releases.find(release => release.tagName === tag);
}

function releaseDetails(tag) {
  return JSON.parse(gh(['release', 'view', tag, '--json', 'assets,isDraft,url']));
}

function checkRemoteAssets(release, names, sizes) {
  const assets = new Map(release.assets.map(asset => [asset.name, asset]));
  const missing = names.filter(name => !assets.has(name) || !assets.get(name).size);
  if (missing.length) throw new Error(`Release is missing required downloads: ${missing.join(', ')}`);
  if (release.isDraft && release.assets.some(asset => !names.includes(asset.name))) throw new Error('The release draft contains unexpected assets. Review it before publishing.');
  if (sizes && names.some(name => assets.get(name).size !== sizes.get(name))) throw new Error('Uploaded release asset sizes do not match the verified build files.');
}

async function publish(directory, info) {
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) throw new Error('Publishing requires GH_TOKEN and GH_REPO.');
  const names = await prepareAssets(directory, info.version);
  const existing = currentRelease(info.tag);
  if (existing && !existing.isDraft) {
    const release = releaseDetails(info.tag);
    checkRemoteAssets(release, names);
    console.log(`Release already published; keeping its original assets: ${release.url}`);
    return release.url;
  }
  if (existing) {
    const unexpected = releaseDetails(info.tag).assets.filter(asset => !names.includes(asset.name));
    if (unexpected.length) throw new Error('The existing draft contains unexpected assets. Review it before rerunning this release workflow.');
  } else {
    const notes = [
      `# LiteParse Portal ${info.version}`,
      '',
      '- **Windows 11 x64:** download the portable `.exe`, or extract the `.zip` and run **LiteParse Portal.exe**.',
      '- **Linux x64:** download the `.AppImage`, mark it executable, and launch it. An extracted `.tar.gz` is also included.',
      '- Runs locally with bundled parsing, English OCR, and SQLite. No Node.js, Python, or database installation is needed.',
      '- Keep your **LiteParse Portal Data** folder when upgrading. Close the app and back up that folder and any external CSV files first.',
      '- `SHA256SUMS.txt` contains checksums of all four application downloads.',
      '',
      'On Linux without FUSE, use `APPIMAGE_EXTRACT_AND_RUN=1 ./LiteParse-Portal-' + info.version + '-linux-x86_64.AppImage`.',
      '',
      'These builds are unsigned. See README.md and VALIDATION.md in the repository for platform requirements and validation limits.',
      ''
    ].join('\n');
    const notesFile = path.join(directory, 'RELEASE_NOTES.md');
    await fs.writeFile(notesFile, notes);
    gh(['release', 'create', info.tag, '--verify-tag', '--draft', '--title', `LiteParse Portal ${info.version}`,
      '--notes-file', notesFile, '--generate-notes', ...(info.prerelease ? ['--prerelease'] : [])]);
  }
  // Upload while still a draft, so incomplete downloads are never advertised as a release.
  gh(['release', 'upload', info.tag, ...names.map(name => path.join(directory, name)), '--clobber']);
  const sizes = new Map(await Promise.all(names.map(async name => [name, (await fs.stat(path.join(directory, name))).size])));
  const draft = releaseDetails(info.tag);
  if (!draft.isDraft) throw new Error('The release was published externally while this workflow was running.');
  checkRemoteAssets(draft, names, sizes);
  gh(['release', 'edit', info.tag, '--draft=false', `--prerelease=${info.prerelease}`, '--verify-tag', ...(info.prerelease ? ['--latest=false'] : [])]);
  const release = releaseDetails(info.tag);
  if (release.isDraft) throw new Error('The release is still a draft.');
  console.log(`Published ${release.url}`);
  return release.url;
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const tag = process.env.RELEASE_TAG || '';
  const info = validateVersion(pkg.version, lock.version, tag);
  if (lock.packages?.['']?.version !== pkg.version) throw new Error('The root lockfile package version does not match package.json.');
  if (process.argv[2] === 'validate') { console.log(`Package version verified: ${info.tag}${tag ? ' (release tag matches)' : ''}`); return; }
  if (process.argv[2] !== 'publish' || !tag) throw new Error('Use validate, or publish with RELEASE_TAG set to the existing version tag.');
  const url = await publish(path.join(root, 'release', 'publish'), info);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release downloads\n\n[LiteParse Portal ${info.version}](${url})\n`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateVersion, assetNames, prepareAssets, checkRemoteAssets };
