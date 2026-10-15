'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sources = [
  ['AppImage-Runtime-LICENSE.txt', 'https://raw.githubusercontent.com/AppImage/type2-runtime/dd6cebe/LICENSE'],
  ['LiteParse-LICENSE.txt', 'https://raw.githubusercontent.com/run-llama/liteparse/main/LICENSE'],
  ['Tesseract-LICENSE.txt', 'https://raw.githubusercontent.com/tesseract-ocr/tesseract/5.5.1/LICENSE'],
  ['Leptonica-LICENSE.txt', 'https://raw.githubusercontent.com/DanBloomberg/leptonica/1.85.0/leptonica-license.txt'],
  ['Tessdata-LICENSE.txt', 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/LICENSE'],
  ['PDFium-LICENSE.txt', 'https://raw.githubusercontent.com/chromium/pdfium/main/LICENSE'],
  ['PDFium-AUTHORS.txt', 'https://raw.githubusercontent.com/chromium/pdfium/main/AUTHORS'],
  ['PDFium-Binaries-LICENSE.txt', 'https://raw.githubusercontent.com/bblanchon/pdfium-binaries/master/LICENSE']
];
async function collect() {
  const root = path.join(__dirname, '..'); const destination = path.join(root, 'assets', 'notices');
  await fs.mkdir(destination, { recursive: true });
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [location, info] of Object.entries(lock.packages)) {
    if (!location || info.dev) continue;
    let names; try { names = await fs.readdir(path.join(root, location)); } catch { continue; }
    for (const file of names.filter(name => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name))) await fs.copyFile(path.join(root, location, file), path.join(destination, `${location.replaceAll('/', '_')}-${file}`));
  }
  for (const [name, url] of sources) {
    try { await fs.access(path.join(destination, name)); continue; } catch { /* first build */ }
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Required third-party notice unavailable: ${url} (${response.status})`);
    await fs.writeFile(path.join(destination, name), await response.text());
  }
  await fs.writeFile(path.join(destination, 'SOURCES.txt'), sources.map(([name, url]) => `${name}\n${url}\n`).join('\n'));
  console.log('Third-party license notices collected.');
}
if (require.main === module) collect().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collect };
