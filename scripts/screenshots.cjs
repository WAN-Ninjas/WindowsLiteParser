'use strict';

// Developer-only screenshot harness. Runs the real application with a temporary
// database and generated PDFs; nothing from an existing workspace is opened.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pdfFixture, invoiceFixture } = require('../src/pdf-fixture.cjs');

const output = path.resolve(__dirname, '../docs/screenshots');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let temporary;
let picked = [];
let savePath;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath });
app.disableHardwareAcceleration();
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

async function until(predicate, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'LiteParse-Demo-'));
  const input = path.join(temporary, 'Sample documents');
  const watched = path.join(temporary, 'Invoice inbox');
  await fs.mkdir(input); await fs.mkdir(watched); await fs.mkdir(output, { recursive: true });
  // Main resolves these before requesting the instance lock or opening SQLite.
  process.argv.push(`--data-dir=${path.join(temporary, 'Portal data')}`);
  app.setAppPath(path.resolve(__dirname, '..'));
  require('../src/main.cjs');
  await app.whenReady();
  const window = await until(() => BrowserWindow.getAllWindows().find(item => !item.isDestroyed()), 'application window');
  window.setContentSize(1440, 1120);
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code, true); }
    catch (error) { throw new Error(`${error.message}\nRenderer command: ${code}`, { cause: error }); }
  };
  await until(async () => !window.webContents.isLoading() && evaluate('typeof window.portal === "object" && typeof refresh === "function"'), 'renderer');
  const portal = (method, ...args) => evaluate(`window.portal[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const idle = () => until(async () => {
    const state = await portal('state');
    if (state.fatalError) throw new Error(state.fatalError);
    if (state.counts.some(item => item.status === 'failed' && item.count)) {
      const failures = [];
      for (const collection of state.collections) {
        failures.push(...(await portal('state', collection.id)).documents.filter(item => item.status === 'failed').map(item => `${item.name}: ${item.error}`));
      }
      throw new Error(failures.join('\n'));
    }
    return !state.counts.some(item => ['queued', 'processing'].includes(item.status) && item.count);
  }, 'document conversion');
  async function importFiles(id, files, folder = false) {
    picked = files;
    const result = await portal('import', id, folder);
    if (result.errors.length || !result.added) throw new Error(JSON.stringify(result));
    await idle();
  }
  async function show(kind, id = null, theme = 'dark') {
    await portal('theme', theme);
    await evaluate(`(async () => { kind = ${JSON.stringify(kind)}; selectedId = ${JSON.stringify(id)}; currentPage = 0; await refresh(); window.scrollTo(0, 0); })()`);
  }
  async function capture(name) {
    await pause(400);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const screenshot = await Promise.race([
          window.webContents.capturePage(),
          pause(3000).then(() => { throw new Error('Screenshot compositor timeout'); })
        ]);
        if (screenshot.isEmpty()) throw new Error('Empty screenshot');
        await fs.writeFile(path.join(output, name), screenshot.toPNG());
        console.log(`Captured ${name} (${screenshot.getSize().width} × ${screenshot.getSize().height})`);
        return;
      } catch (error) { if (attempt === 4) throw error; await pause(200); }
    }
  }
  async function sample(name, lines) {
    const file = path.join(input, name);
    await fs.writeFile(file, pdfFixture(lines)); return file;
  }

  const invoices = await portal('create', { kind: 'project', name: 'Supplier invoices', analysisMode: 'high' });
  const first = await sample('Acme-invoice-1001.pdf', ['Vendor: Acme Supplies', 'Invoice Number: INV-1001', 'Invoice Date: 2026-10-15', 'Total: $125.00']);
  const second = await sample('Northwind-invoice-2042.pdf', ['Vendor: Northwind Paper', 'Invoice Number: INV-2042', 'Invoice Date: 2026-10-15', 'Total: $245.50', 'Department: Operations']);
  await importFiles(invoices, [first, second]);
  let snapshot = await portal('state', invoices);
  const reviewed = snapshot.documents.find(item => item.name === path.basename(first));
  await portal('review', reviewed.id, reviewed.values, []);
  picked = [watched]; await portal('watch', invoices, true);
  await fs.writeFile(path.join(watched, 'Contoso-invoice-3088.pdf'), pdfFixture(['Vendor: Contoso Office', 'Invoice Number: INV-3088', 'Invoice Date: 2026-10-15', 'Total: $89.00', 'Purchase Order: PO-7081']));
  await until(async () => (await portal('state', invoices)).documents.length === 3, 'watched-folder import');
  await idle();
  savePath = path.join(temporary, 'Supplier invoices.csv'); await portal('export', invoices);

  const orders = await portal('create', { kind: 'project', name: 'Purchase orders', analysisMode: 'high' });
  await importFiles(orders, [await sample('Purchase-order-7081.pdf', ['Supplier: Contoso Office', 'Purchase Order: PO-7081', 'Order Date: 2026-10-14', 'Department: Operations', 'Total: $89.00'])]);
  const receipts = await portal('create', { kind: 'project', name: 'Expense receipts', analysisMode: 'high' });
  await importFiles(receipts, [await sample('Travel-receipt-105.pdf', ['Merchant: Example Travel', 'Receipt Number: REC-105', 'Date: 2026-10-15', 'Category: Travel', 'Total: $46.80'])]);

  const quick = await portal('create', { kind: 'quick', name: 'October invoice batch', analysisMode: 'high' });
  const layout = path.join(input, 'Example-Supply-invoice.pdf');
  await fs.writeFile(layout, invoiceFixture());
  await importFiles(quick, [layout, first]);
  savePath = path.join(temporary, 'October invoice batch.csv'); await portal('export', quick);

  window.setContentSize(1440, 800);
  await show('project'); await capture('01-projects-dark.png');
  window.setContentSize(1440, 1360);
  await show('project', invoices, 'light'); await capture('02-project-light.png');
  window.setContentSize(1440, 1220);
  await show('quick', quick); await capture('03-quick-conversion-dark.png');
  window.setContentSize(1440, 1120);
  snapshot = await portal('state', quick);
  const document = snapshot.documents.find(item => item.name === path.basename(layout));
  await evaluate(`(async () => { await openReview(${JSON.stringify(document.id)}); document.querySelector('#review-dialog').scrollTop = 0; })()`);
  await capture('04-review-dark.png');
  await evaluate(`(async () => {
    const source = document.querySelector('#source-text');
    const phrase = 'Payment due upon receipt';
    const start = source.firstChild.textContent.indexOf(phrase);
    if (start < 0) throw new Error('Example not present in extracted source');
    const range = document.createRange();
    range.setStart(source.firstChild, start); range.setEnd(source.firstChild, start + phrase.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.querySelector('#use-selection').click();
    document.querySelector('#teach-label').value = 'Payment policy';
    document.querySelector('#teach-anchor').value = 'Terms & Conditions';
    document.querySelector('#teach-reuse').checked = true;
    await previewField();
    document.querySelector('#review-dialog').scrollTop = 0;
    source.scrollTop = source.scrollHeight;
  })()`);
  await capture('05-teach-missing-field-dark.png');
  window.close();
}

const watchdog = setTimeout(() => { console.error('Screenshot run exceeded three minutes'); app.exit(1); }, 180000);
watchdog.unref();
app.on('will-quit', () => {
  // Cleanup after the application's close handler has stopped its parser/store.
  if (temporary) require('node:fs').rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
});
run().catch(error => { console.error(error); app.exit(1); });
