'use strict';

const { extractFields, discoverFields, mergeFields } = require('./core/extraction.cjs');

async function run(message, send) {
  try {
    const { LiteParse } = require('@llamaindex/liteparse');
    require('node:fs').accessSync(require('node:path').join(message.tessdataPath, 'eng.traineddata'));
    const parser = new LiteParse({ ocrEnabled: true, ocrLanguage: 'eng', tessdataPath: message.tessdataPath, outputFormat: 'json', maxPages: 2000, numWorkers: 2 });
    const result = await parser.parse(message.path);
    if (!result.pages?.length) throw new Error('No pages were extracted.');
    if (result.totalPages > result.pages.length) throw new Error('Document exceeds the 2,000 page limit. Split it before importing.');
    if (result.pageErrors?.length) throw new Error('One or more pages could not be parsed.');
    const pages = result.pages.map(page => ({ number: page.pageNum, text: page.text || '' }));
    const text = pages.map(page => page.text).join('\n\n');
    if (Buffer.byteLength(text) > 50 * 1024 * 1024) throw new Error('Extracted text exceeds the 50 MiB limit.');
    if (!text.trim()) throw new Error('No readable text found. Check the scan quality; English OCR is bundled.');
    const discovered = discoverFields(text);
    const fields = mergeFields(message.fields, discovered);
    const extracted = extractFields(text, fields);
    for (const field of discovered) if (!extracted.values[field.name]) extracted.values[field.name] = field.value;
    send({ ok: true, pages, discovered, ...extracted });
  } catch (error) { send({ ok: false, error: error.message || String(error) }); }
}

if (process.parentPort) {
  process.parentPort.once('message', event => { run(event.data, result => process.parentPort.postMessage(result)); });
} else {
  process.once('message', message => { run(message, result => process.send(result, () => process.disconnect())); });
}
