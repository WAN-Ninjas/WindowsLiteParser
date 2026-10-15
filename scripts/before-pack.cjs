'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
module.exports = async context => {
  await require('./collect-notices.cjs').collect();
  if (context.electronPlatformName !== 'win32') return;
  await require('./prepare-windows-runtime.cjs').prepare();
  const root = path.join(__dirname, '..', 'node_modules', '@llamaindex');
  const native = path.join(root, 'liteparse-win32-x64-msvc');
  try { await fs.access(path.join(native, 'liteparse.win32-x64-msvc.node')); }
  catch { throw new Error('Windows x64 native LiteParse package is missing. Build on Windows, or explicitly install @llamaindex/liteparse-win32-x64-msvc@2.15.1 for a cross build.'); }
  for (const name of ['liteparse.win32-x64-msvc.node', 'pdfium.dll']) await fs.copyFile(path.join(native, name), path.join(root, 'liteparse', name));
};
