'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
let count = 0;
for (const file of ['src', 'scripts', 'test'].flatMap(directory => fs.existsSync(directory) ? files(directory) : [])) {
  if (!/\.(c?js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exitCode = 1; } count++;
}
if (!process.exitCode) console.log(`Syntax checked ${count} JavaScript files.`);
