'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('../src/core/files.cjs');
const destination = path.join(__dirname, '..', 'assets', 'tessdata', 'eng.traineddata');
const expected = '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba';
const url = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/eng.traineddata';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

(async () => {
  let bytes;
  try { bytes = await fs.readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && digest(bytes) === expected) { console.log('Bundled English OCR data verified.'); return; }
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`OCR asset download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error('OCR asset checksum mismatch; refusing to bundle it.');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await atomicWrite(destination, bytes);
  console.log('English OCR data downloaded and SHA-256 verified. End users do not need this download.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
