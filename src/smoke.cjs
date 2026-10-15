'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { BrowserWindow } = require('electron');
const { parse } = require('csv-parse/sync');
const { pdfFixture, invoiceFixture } = require('./pdf-fixture.cjs');

async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`Smoke test timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}

async function capture(window) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    let timer;
    try {
      const image = await Promise.race([
        window.webContents.capturePage(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Compositor capture did not respond within two seconds.')), 2000); })
      ]);
      if (!image.isEmpty()) return image;
      last = new Error('The compositor returned an empty image.');
    } catch (error) { last = error; }
    finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Screenshot capture failed after five attempts: ${last?.message || last}`);
}

async function run({ service, window }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-smoke-'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  try {
    await until(() => evaluate('Boolean(document.querySelector("#new-button") && window.portal)'), 'renderer ready');
    // Exercise the real toggle, its SQLite preference, and restoration after a reload.
    if (await evaluate('document.documentElement.dataset.theme === "dark"')) {
      await evaluate('document.querySelector("#theme-toggle").click();');
      await until(() => evaluate('document.documentElement.dataset.theme === "light" && !document.querySelector("#theme-toggle").disabled'), 'light mode');
    }
    await evaluate('document.querySelector("#theme-toggle").click();');
    await until(() => evaluate('document.documentElement.dataset.theme === "dark" && !document.querySelector("#theme-toggle").disabled'), 'dark mode');
    assert.equal(service.theme(), 'dark');
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await until(() => evaluate('Boolean(document.querySelector("#theme-toggle")?.textContent.includes("Light mode")) && document.documentElement.dataset.theme === "dark"'), 'saved dark mode after reload');
    await evaluate('document.querySelector("#new-button").click(); document.querySelector("#collection-name").value="Smoke project"; document.querySelector("#create-form").requestSubmit();');
    await until(() => service.snapshot().collections.some(row => row.name === 'Smoke project'), 'project created from UI');
    const project = service.snapshot().collections.find(row => row.name === 'Smoke project');
    assert.equal(project.analysis_mode, 'high');
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
    await until(() => evaluate('document.querySelectorAll("#documents button").length === 4'), 'documents in UI');
    await evaluate('document.querySelector("#analysis-select").value="standard"; document.querySelector("#analysis-select").dispatchEvent(new Event("change"));');
    await until(() => service.collection(project.id).analysis_mode === 'standard', 'quality setting through IPC');
    await evaluate('document.querySelectorAll("#documents button")[1].click();');
    await until(() => !service.running && service.snapshot(project.id).documents.find(doc => doc.name === 'second.pdf')?.analysis.mode === 'standard', 'reanalyze through IPC');
    await until(() => evaluate('document.querySelectorAll("#documents button").length === 4'), 'reanalysis result');
    await evaluate('document.querySelector("#analysis-select").value="high"; document.querySelector("#analysis-select").dispatchEvent(new Event("change"));');
    await until(() => service.collection(project.id).analysis_mode === 'high', 'restore high accuracy');
    await evaluate('document.querySelector("#documents button").click();');
    await until(() => evaluate('document.querySelector("#review-dialog").open'), 'review UI');
    await evaluate('document.querySelector("#review-fields input[name=vendor]").value="Corrected Supplier"; document.querySelector("#review-form").requestSubmit();');
    await until(() => evaluate('!document.querySelector("#review-dialog").open'), 'review saved through IPC');
    await service.exports;
    rows = parse(await fs.readFile(service.collection(project.id).output_path, 'utf8'), { columns: true, bom: true });
    assert.equal(rows[1].vendor, 'Corrected Supplier'); assert.equal(rows[1].review_status, 'reviewed');
    // Exercise quick conversion and saving repeated, multiline table values in the actual UI.
    await evaluate('document.querySelector("#nav-quick").click();');
    await until(() => evaluate('document.querySelector("#new-button").textContent.includes("conversion")'), 'quick navigation');
    await evaluate('document.querySelector("#new-button").click(); document.querySelector("#collection-name").value="Layout quick conversion"; document.querySelector("#create-form").requestSubmit();');
    await until(() => service.snapshot().collections.some(row => row.name === 'Layout quick conversion'), 'quick creation');
    const quick = service.snapshot().collections.find(row => row.name === 'Layout quick conversion');
    const invoice = path.join(root, 'example-invoice.pdf'); await fs.writeFile(invoice, invoiceFixture());
    await service.importPaths(quick.id, [invoice]); await until(() => !service.running, 'layout invoice');
    await until(() => evaluate('document.querySelectorAll("#documents button").length === 2'), 'quick result');
    await evaluate('document.querySelector("#documents button").click();');
    await until(() => evaluate('document.querySelector("#review-dialog").open'), 'layout review');
    assert.equal(await evaluate('document.querySelector("#review-fields textarea[name=line_item_qty]").value'), Array(10).fill('1').join('\n'));
    assert.match(await evaluate('document.querySelector("#analysis-summary").textContent'), /10 data row/);
    const quickDoc = service.snapshot(quick.id).documents[0];
    // Select actual source text, name it, preview its label, and save a reusable rule through IPC.
    await evaluate(`{
      const node = document.querySelector('#source-text').firstChild;
      const start = node.textContent.indexOf('Payment due upon receipt');
      if (start < 0) throw new Error('Example source text missing');
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'Payment due upon receipt'.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }`);
    await until(() => evaluate('!document.querySelector("#use-selection").disabled'), 'source selection');
    await evaluate('document.querySelector("#use-selection").click();');
    await until(() => evaluate('!document.querySelector("#teach-panel").hidden && !document.querySelector("#teach-save").disabled'), 'teaching helper');
    assert.equal(await evaluate('document.querySelector("#teach-example").value'), 'Payment due upon receipt');
    await evaluate('document.querySelector("#teach-label").value="Payment policy"; document.querySelector("#teach-anchor").value="Terms & Conditions"; document.querySelector("#teach-preview").click();');
    await until(() => evaluate('document.querySelector("#teach-preview-result").textContent.includes("One source match")'), 'verified teaching preview');
    if (process.env.PORTAL_SMOKE_SCREENSHOT) {
      await fs.mkdir(path.dirname(process.env.PORTAL_SMOKE_SCREENSHOT), { recursive: true });
      const screenshot = process.env.PORTAL_SMOKE_SCREENSHOT.replace(/\.png$/i, '-review.png');
      await fs.writeFile(screenshot, (await capture(window)).toPNG());
    }
    await evaluate('document.querySelector("#teach-reuse").checked=true; document.querySelector("#teach-save").click();');
    await until(() => evaluate('Boolean(document.querySelector("#review-fields input[name=payment_policy]"))'), 'taught field in review');
    assert.equal(service.document(quickDoc.id).reviewed, false);
    await evaluate('document.querySelector("[data-field=invoice_number] [data-action=flag]").click();');
    await until(() => evaluate('document.querySelector("[data-field=invoice_number]").classList.contains("flagged")'), 'missed field tagged');
    await evaluate('document.querySelector("#review-reanalyze").click();');
    await until(() => evaluate('!document.querySelector("#review-dialog").open'), 'reanalyze inside review');
    await until(() => !service.running && service.document(quickDoc.id).analysis.manualCorrectionsKept === 1, 'correction kept in reanalysis');
    await until(() => evaluate('document.querySelectorAll("#documents button").length === 2'), 'reanalyzed quick conversion');
    await evaluate('document.querySelector("#documents button").click();');
    await until(() => evaluate('document.querySelector("#review-dialog").open'), 'reopen flagged review');
    assert.equal(await evaluate('document.querySelector("#review-fields input[name=payment_policy]").value'), 'Payment due upon receipt');
    await evaluate('document.querySelector("#review-form").requestSubmit();');
    await until(() => evaluate('!document.querySelector("#review-error").hidden'), 'unresolved flag blocks reviewed status');
    assert.match(await evaluate('document.querySelector("#review-error").textContent'), /Resolve or clear/);
    await evaluate('document.querySelector("[data-field=invoice_number] [data-action=clear-feedback]").click();');
    await until(() => evaluate('!document.querySelector("[data-field=invoice_number]").classList.contains("flagged")'), 'flag cleared');
    await evaluate('document.querySelector("#review-form").requestSubmit();');
    await until(() => evaluate('!document.querySelector("#review-dialog").open'), 'multiline review saved');
    await service.exports;
    const quickRows = parse(await fs.readFile(service.collection(quick.id).output_path, 'utf8'), { columns: true, bom: true });
    assert.equal(quickRows[0].line_item_qty, Array(10).fill('1').join('\n')); assert.equal(quickRows[0].line_item_count, '10');
    const later = path.join(root, 'later-invoice.pdf'); await fs.writeFile(later, pdfFixture(['Vendor: Example Later Supplier', 'Terms & Conditions', 'Net 30']));
    await service.importPaths(quick.id, [later]); await until(() => !service.running, 'future document with taught rule');
    const laterDoc = service.snapshot(quick.id).documents.find(doc => doc.name === 'later-invoice.pdf');
    assert.equal(laterDoc.values.payment_policy, 'Net 30'); assert.equal(laterDoc.analysis.taughtFields[0].status, 'matched');
    await evaluate('document.querySelector("#nav-projects").click();');
    await until(() => evaluate('document.querySelectorAll("#sidebar-collections button").length === 1'), 'project navigation');
    await evaluate('document.querySelector("#sidebar-collections button").click();');
    // Make an image-only input with a real browser renderer, then run bundled Tesseract.
    const scan = new BrowserWindow({ width: 1100, height: 600, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    try {
      await scan.loadURL('data:text/html,' + encodeURIComponent('<html><head><style>body{background:white;color:black;font:32px Arial;padding:40px}p{margin:22px 0}</style></head><body><p>Vendor: Optical Supplies</p><p>Invoice Number: SCAN-300</p><p>Total: $75.00</p></body></html>'));
      scan.showInactive();
      const image = await capture(scan);
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
      await fs.writeFile(process.env.PORTAL_SMOKE_SCREENSHOT, (await capture(window)).toPNG());
    }
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    assert.equal(await evaluate('typeof window.process'), 'undefined');
    console.log('SMOKE PASSED: dark mode toggle and persistence, source selection, verified field teaching, future-document extraction, persistent missed-field flags, protected corrections, review reanalysis, multiline CSV review, project and quick creation, native parsing, offline OCR, renderer isolation.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

module.exports = { run };
