'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { BrowserWindow } = require('electron');
const { parse } = require('csv-parse/sync');
const { pdfFixture } = require('./pdf-fixture.cjs');

async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`Smoke test timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}

async function run({ service, window }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-smoke-'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  try {
    await until(() => evaluate('Boolean(document.querySelector("#new-button") && window.portal)'), 'renderer ready');
    await evaluate('document.querySelector("#new-button").click(); document.querySelector("#collection-name").value="Smoke project"; document.querySelector("#create-form").requestSubmit();');
    await until(() => service.snapshot().collections.some(row => row.name === 'Smoke project'), 'project created from UI');
    const project = service.snapshot().collections.find(row => row.name === 'Smoke project');
    await until(() => evaluate('!document.querySelector("#detail").hidden'), 'project detail');
    const first = path.join(root, 'first.pdf'); const second = path.join(root, 'second.pdf');
    await fs.writeFile(first, pdfFixture());
    await fs.writeFile(second, pdfFixture(['Vendor: New Supplier', 'Invoice Number: INV-200', 'Total: $55.00', 'Department: Research']));
    assert.equal((await service.importPaths(project.id, [first, second, first])).added, 2);
    await until(() => !service.running, 'PDF workers');
    if (service.fatalError) throw new Error(service.fatalError);
    let docs = service.snapshot(project.id).documents;
    assert.equal(docs.filter(doc => doc.status === 'completed').length, 2, JSON.stringify(docs));
    let rows = parse(await fs.readFile(service.collection(project.id).output_path, 'utf8'), { columns: true, bom: true });
    assert.equal(rows[0].vendor, 'Acme Supplies'); assert.equal(rows[0].department, ''); assert.equal(rows[1].department, 'Research');
    await until(() => evaluate('document.querySelectorAll("#documents button").length === 2'), 'documents in UI');
    await evaluate('document.querySelector("#documents button").click();');
    await until(() => evaluate('document.querySelector("#review-dialog").open'), 'review UI');
    await evaluate('document.querySelector("#review-fields input[name=vendor]").value="Corrected Supplier"; document.querySelector("#review-form").requestSubmit();');
    await until(() => evaluate('!document.querySelector("#review-dialog").open'), 'review saved through IPC');
    await service.exports;
    rows = parse(await fs.readFile(service.collection(project.id).output_path, 'utf8'), { columns: true, bom: true });
    assert.equal(rows[1].vendor, 'Corrected Supplier'); assert.equal(rows[1].review_status, 'reviewed');
    // Make an image-only input with a real browser renderer, then run bundled Tesseract.
    const scan = new BrowserWindow({ width: 1100, height: 600, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    try {
      await scan.loadURL('data:text/html,' + encodeURIComponent('<html><head><style>body{background:white;color:black;font:32px Arial;padding:40px}p{margin:22px 0}</style></head><body><p>Vendor: Optical Supplies</p><p>Invoice Number: SCAN-300</p><p>Total: $75.00</p></body></html>'));
      const image = await scan.webContents.capturePage();
      const file = path.join(root, 'scan.png'); await fs.writeFile(file, image.toPNG());
      await service.importPaths(project.id, [file]);
      await until(() => !service.running, 'bundled OCR', 90000);
      docs = service.snapshot(project.id).documents;
      const ocr = docs.find(doc => doc.name === 'scan.png');
      assert.equal(ocr?.status, 'completed', JSON.stringify(ocr)); assert.match(ocr.values.vendor || '', /Optical Supplies/i);
    } finally { scan.destroy(); }
    if (process.env.PORTAL_SMOKE_SCREENSHOT) {
      await until(() => evaluate('document.querySelectorAll("#documents tr").length === 3 && document.querySelector("#queue-status").textContent === "Ready to convert"'), 'final render');
      await fs.mkdir(path.dirname(process.env.PORTAL_SMOKE_SCREENSHOT), { recursive: true });
      await fs.writeFile(process.env.PORTAL_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    assert.equal(await evaluate('typeof window.process'), 'undefined');
    console.log('SMOKE PASSED: renderer, project creation, isolated native parsing, automatic schema expansion, CSV, review IPC, offline OCR, renderer isolation.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

module.exports = { run };
