'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);
const MAX_BYTES = 100 * 1024 * 1024;

function supported(file) { return EXTENSIONS.has(path.extname(file).toLowerCase()); }
function inside(file, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function* walk(input, excludedDirectory) {
  if (excludedDirectory && inside(input, excludedDirectory)) return;
  const stat = await fsp.lstat(input);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) { if (supported(input)) yield { path: path.resolve(input), size: stat.size, mtimeMs: stat.mtimeMs }; return; }
  if (!stat.isDirectory()) return;
  const dir = await fsp.opendir(input);
  for await (const entry of dir) {
    if (entry.isSymbolicLink()) continue;
    yield* walk(path.join(input, entry.name), excludedDirectory);
  }
}

async function stageFile(source, destination) {
  if (!supported(source)) throw new Error('Supported files: PDF, PNG, JPEG, TIFF, BMP, WebP.');
  const before = await fsp.lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Import a regular file, not a shortcut or symbolic link.');
  if (before.size > MAX_BYTES) throw new Error('File exceeds the 100 MiB limit.');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, encoding, next) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return next(new Error('File exceeds the 100 MiB limit.'));
      hash.update(chunk); next(null, chunk);
    } }), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    const after = await fsp.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) throw new Error('File changed during import; wait for copying to finish and try again.');
    return { hash: hash.digest('hex'), bytes };
  } catch (error) {
    await fsp.rm(destination, { force: true });
    throw error;
  }
}

async function atomicWrite(destination, contents) {
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close(); handle = null;
    await fsp.rename(temp, destination);
  } finally {
    await handle?.close();
    await fsp.rm(temp, { force: true });
  }
}

module.exports = { EXTENSIONS, MAX_BYTES, supported, inside, walk, stageFile, atomicWrite };
