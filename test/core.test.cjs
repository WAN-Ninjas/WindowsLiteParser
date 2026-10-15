'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('csv-parse/sync');
const { EventEmitter } = require('node:events');
const { Store } = require('../src/core/database.cjs');
const { PortalService } = require('../src/core/service.cjs');
const { ParserRunner } = require('../src/core/parser.cjs');
const { discoverFields, mergeFields, extractFields, validateFields, fieldName } = require('../src/core/extraction.cjs');
const { cell, csvFor } = require('../src/core/csv.cjs');
const { stageFile, walk } = require('../src/core/files.cjs');
const { pdfFixture } = require('../src/pdf-fixture.cjs');

async function waitFor(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for processing'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function fixture(t, parser) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-test-'));
  const data = path.join(root, 'data'); const input = path.join(root, 'input'); await fs.mkdir(input);
  const store = await Store.open(data);
  const service = new PortalService(store, data, parser || { parse: async file => {
    const text = await fs.readFile(file, 'utf8');
    if (text === 'BROKEN') throw new Error('Invalid document');
    const discovered = discoverFields(text);
    return { pages: [{ number: 1, text }], discovered, values: Object.fromEntries(discovered.map(field => [field.name, field.value])), missing: [] };
  }, stop() {} });
  await service.start(); clearInterval(service.timer);
  await waitFor(() => !service.polling);
  t.after(async () => { if (!store.closed) await service.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, data, input, store, service };
}
async function complete(service) {
  await waitFor(() => !service.running && !service.store.get("SELECT id FROM documents WHERE status IN ('queued','processing')"));
  await service.exports;
  assert.equal(service.fatalError, '');
}

test('discovers a document-defined schema, repeated values, aligned pairs and safe column names', () => {
  const found = discoverFields('Vendor: Acme\nInvoice #: INV-1\nTotal    $125\nRegion: West\nRegion: East\nhttps://example.com\nReference:\nABC123\nsource_file: custom');
  const values = Object.fromEntries(found.map(field => [field.name, field.value]));
  assert.equal(values.vendor, 'Acme'); assert.equal(values.invoice_number, 'INV-1');
  assert.equal(values.total, '$125'); assert.equal(values.region, 'West\nEast');
  assert.equal(values.reference, 'ABC123'); assert.equal(values.field_source_file, 'custom');
  assert.equal(values.https, undefined); assert.equal(fieldName('Tax (%)'), 'tax_percent');
  const next = mergeFields(found.map(({ value, ...field }) => field), discoverFields('Discount: $5'));
  assert.ok(next.find(field => field.name === 'discount')); assert.equal(next.length, found.length + 1);
});

test('validates manual rules and extracts optional and required values', () => {
  assert.deepEqual(validateFields([]), []);
  assert.throws(() => validateFields([{ name: 'source_file', pattern: '' }]));
  assert.throws(() => validateFields([{ name: 'bad', pattern: '(' }]));
  const result = extractFields('Code: ABC', [{ name: 'code', pattern: 'Code: (\\w+)', required: true }, { name: 'missing', pattern: '', required: true }]);
  assert.equal(result.values.code, 'ABC'); assert.deepEqual(result.missing, ['missing']);
});

test('simple aligned tables contribute dynamic fields with all row values', () => {
  const found = discoverFields('Item    Quantity    Price\nPens    2    $5\nPaper    3    $9\n\nReference: PO-1');
  const values = Object.fromEntries(found.map(field => [field.name, field.value]));
  assert.equal(values.item, 'Pens\nPaper'); assert.equal(values.quantity, '2\n3'); assert.equal(values.price, '$5\n$9'); assert.equal(values.reference, 'PO-1');
});

test('consecutive aligned label/value pairs are not mistaken for table headings', () => {
  const found = discoverFields('Vendor    Acme\nTotal    $125');
  assert.deepEqual(Object.fromEntries(found.map(field => [field.name, field.value])), { vendor: 'Acme', total: '$125' });
});

test('CSV protects formulas and quotes multiline and comma-containing text', () => {
  for (const text of ['=1+1', ' @SUM(A1)', '\t=2', '-2+3']) assert.ok(cell(text).startsWith('"\''));
  assert.equal(cell('a,"b"\nc'), '"a,""b""\nc"');
});

test('stages independent copies, rejects links and unsupported types, and walks recursive folders', async t => {
  const { root, input } = await fixture(t);
  const source = path.join(input, 'one.PDF'); await fs.writeFile(source, 'first');
  const destination = path.join(root, 'copy.pdf'); const staged = await stageFile(source, destination);
  await fs.writeFile(source, 'changed'); assert.equal(await fs.readFile(destination, 'utf8'), 'first'); assert.equal(staged.hash.length, 64);
  await fs.mkdir(path.join(input, 'nested')); await fs.writeFile(path.join(input, 'nested', 'two.png'), 'image');
  await fs.writeFile(path.join(input, 'ignore.docx'), 'office');
  if (process.platform !== 'win32') { const link = path.join(input, 'link.pdf'); await fs.symlink(source, link); await assert.rejects(stageFile(link, path.join(root, 'link-copy.pdf'))); }
  const files = []; for await (const item of walk(input)) files.push(path.basename(item.path));
  assert.deepEqual(files.sort(), ['one.PDF', 'two.png']);
});

test('imports incrementally, deduplicates per project, and expands CSV without losing earlier rows', async t => {
  const { service, store, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Dynamic project' });
  const first = path.join(input, 'one.pdf'); await fs.writeFile(first, 'Vendor: Acme\nTotal: $125');
  assert.equal((await service.importPaths(id, [first])).added, 1); await complete(service);
  assert.equal((await service.importPaths(id, [first])).duplicates, 1);
  const second = path.join(input, 'two.pdf'); await fs.writeFile(second, 'Vendor: Another\nTotal: $90\nDiscount: $5');
  await service.importPaths(id, [second]); await complete(service);
  const collection = service.collection(id); const csv = parse(csvFor(store, collection), { columns: true, bom: true });
  assert.equal(csv.length, 2); assert.equal(csv[0].vendor, 'Acme'); assert.equal(csv[0].discount, ''); assert.equal(csv[1].discount, '$5');
  const quick = await service.createCollection({ kind: 'quick', name: 'One off' });
  assert.equal((await service.importPaths(quick, [first])).added, 1); await complete(service);
  const doc = service.snapshot(id).documents[0];
  await service.review(doc.id, { ...doc.values, total: '$95' }, [{ label: 'Cost center', value: 'OPS' }]);
  assert.equal(JSON.parse(service.collection(id).fields).at(-1).name, 'cost_center');
  assert.equal(parse(csvFor(store, service.collection(id)), { columns: true, bom: true })[1].total, '$95');
});

test('retention purges reviewed content only after durable export, preserving old rows as schema grows', async t => {
  const { service, store, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Export only', retainContent: false });
  const first = path.join(input, 'first.pdf'); await fs.writeFile(first, 'Vendor: =Untrusted\nTotal: $20');
  await service.importPaths(id, [first]); await complete(service);
  let doc = service.snapshot(id).documents[0];
  assert.equal(doc.purged, 0); const staged = store.get('SELECT staged_path FROM documents WHERE id = ?', [doc.id]).staged_path;
  await service.review(doc.id, doc.values);
  doc = service.snapshot(id).documents[0]; assert.equal(doc.purged, 1); assert.deepEqual(doc.values, {});
  assert.equal(store.all('SELECT * FROM pages').length, 0); await assert.rejects(fs.access(staged));
  assert.throws(() => service.document(doc.id), /removed/);
  const second = path.join(input, 'second.pdf'); await fs.writeFile(second, 'Vendor: New\nTax: $2');
  await service.importPaths(id, [second]); await complete(service);
  const rows = parse(await fs.readFile(service.collection(id).output_path, 'utf8'), { columns: true, bom: true });
  assert.equal(rows.length, 2); assert.equal(rows[0].vendor, "'=Untrusted"); assert.equal(rows[0].total, '$20'); assert.equal(rows[0].tax, ''); assert.equal(rows[1].tax, '$2');
  const copy = path.join(input, 'another-output.csv'); await service.updateExport(id, copy);
  assert.equal(parse(await fs.readFile(copy, 'utf8'), { columns: true, bom: true }).length, 2);
  await fs.rm(copy); await service.updateExport(id);
  assert.match(service.collection(id).export_error, /missing/);
  assert.equal(service.snapshot(id).documents.find(item => !item.purged).status, 'completed');
});

test('locked or unavailable CSV keeps content in SQLite and does not purge it', async t => {
  const { service, store, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Blocked CSV', retainContent: false });
  const output = service.collection(id).output_path; await fs.rm(output); await fs.mkdir(output);
  const file = path.join(input, 'one.pdf'); await fs.writeFile(file, 'Name: Saved');
  await service.importPaths(id, [file]); await complete(service);
  const doc = service.snapshot(id).documents[0]; await service.review(doc.id, doc.values);
  assert.equal(service.snapshot(id).documents[0].purged, 0); assert.ok(service.collection(id).export_error);
  assert.equal(store.all('SELECT * FROM pages').length, 1);
  await fs.rmdir(output); await service.updateExport(id);
  assert.equal(service.snapshot(id).documents[0].purged, 1); assert.equal(service.collection(id).export_error, '');
});

test('watching waits for two stable scans and detects replacements without duplicate rows', async t => {
  const { service, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Watch', watchPath: input });
  const file = path.join(input, 'arriving.pdf'); await fs.writeFile(file, 'Name: First');
  await service.poll(); assert.equal(service.snapshot(id).documents.length, 0);
  await service.poll(); await complete(service); assert.equal(service.snapshot(id).documents.length, 1);
  await service.poll(); assert.equal(service.snapshot(id).documents.length, 1);
  await fs.writeFile(file, 'Name: Changed document\nExtra: Field');
  await service.poll(); await service.poll(); await complete(service);
  assert.equal(service.snapshot(id).documents.length, 2);
  assert.ok(JSON.parse(service.collection(id).fields).some(field => field.name === 'extra'));
});

test('failed documents are retryable and remain outside the successful CSV rows', async t => {
  const { service, input, store } = await fixture(t);
  const id = await service.createCollection({ name: 'Failure' }); const file = path.join(input, 'bad.pdf'); await fs.writeFile(file, 'BROKEN');
  await service.importPaths(id, [file]); await complete(service);
  const doc = service.snapshot(id).documents[0]; assert.equal(doc.status, 'failed');
  assert.equal(parse(csvFor(store, service.collection(id)), { columns: true, bom: true }).length, 0);
  await fs.writeFile(store.get('SELECT staged_path FROM documents WHERE id = ?', [doc.id]).staged_path, 'Name: Fixed');
  await service.retry(doc.id); await complete(service); assert.equal(service.snapshot(id).documents[0].status, 'completed');
});

test('SQLite persists data and recovers an interrupted job after restart', async t => {
  const { service, store, data, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Restart' }); service.paused = true;
  const file = path.join(input, 'one.pdf'); await fs.writeFile(file, 'Name: Persistent'); await service.importPaths(id, [file]);
  const doc = service.snapshot(id).documents[0];
  await store.transaction(() => store.run("UPDATE documents SET status = 'processing' WHERE id = ?", [doc.id]));
  await service.stop(); const reopened = await Store.open(data);
  assert.equal(reopened.get('SELECT status FROM documents WHERE id = ?', [doc.id]).status, 'queued');
  assert.equal(reopened.get('SELECT name FROM collections WHERE id = ?', [id]).name, 'Restart'); await reopened.close();
});

test('corrupt SQLite is never replaced with an empty database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-corrupt-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'portal.sqlite'); await fs.writeFile(file, 'bad database');
  await assert.rejects(Store.open(root)); assert.equal(await fs.readFile(file, 'utf8'), 'bad database');
});

test('moving the portable data folder preserves queued sources and the managed CSV location', async t => {
  const { service, store, root, data, input } = await fixture(t);
  service.paused = true;
  const id = await service.createCollection({ name: 'Portable project' });
  const file = path.join(input, 'portable.pdf'); await fs.writeFile(file, 'Name: Portable data');
  await service.importPaths(id, [file]); await service.stop();
  const moved = path.join(root, 'moved data'); await fs.rename(data, moved);
  const reopened = await Store.open(moved);
  const next = new PortalService(reopened, moved, service.parser);
  try {
    assert.ok(reopened.get('SELECT staged_path FROM documents').staged_path.startsWith(moved));
    assert.ok(next.collection(id).output_path.startsWith(moved));
    await next.start(); clearInterval(next.timer); await complete(next);
    const rows = parse(await fs.readFile(next.collection(id).output_path, 'utf8'), { columns: true, bom: true });
    assert.equal(rows[0].name, 'Portable data');
  } finally { await next.stop(); }
  assert.equal(store.closed, true);
});

test('SQLite keeps foreign keys and content deletion enabled after durable writes', async t => {
  const { service, store } = await fixture(t);
  await service.createCollection({ name: 'Pragma check' });
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.get('PRAGMA secure_delete').secure_delete, 1);
  assert.throws(() => store.run('INSERT INTO pages(document_id, number, text) VALUES(?,?,?)', ['missing', 1, 'orphan']), /FOREIGN KEY/);
  await store.persist(); assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
});

test('bulk history pagination and filters can reach older documents', async t => {
  const { service, store } = await fixture(t);
  service.paused = true;
  const id = await service.createCollection({ name: 'Paged history' });
  await store.transaction(() => {
    for (let index = 0; index < 105; index++) store.run(`INSERT INTO documents
      (id, collection_id, name, source_path, staged_path, sha256, bytes, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [`doc-${index}`, id, `File ${index}`, '', '', `hash-${index}`, 0, index === 0 ? 'failed' : 'completed', new Date().toISOString()]);
  });
  assert.equal(service.snapshot(id).documents.length, 100);
  const older = service.snapshot(id, { page: 1 }); assert.equal(older.documents.length, 5); assert.equal(older.documents.at(-1).id, 'doc-0');
  const failed = service.snapshot(id, { filter: 'failed' }); assert.equal(failed.documentTotal, 1); assert.equal(failed.documents[0].id, 'doc-0');
});

test('parser worker enforces a hard timeout', async () => {
  let killed = false;
  const parser = new ParserRunner(() => { const worker = new EventEmitter(); worker.send = () => {}; worker.kill = () => { killed = true; worker.emit('exit', 1); }; return worker; }, 30);
  await assert.rejects(parser.parse('ignored.pdf', []), /exceeded/); assert.equal(killed, true);
});

test('analysis settings reach workers and failed reanalysis preserves reviewed values and CSV rows', async t => {
  let fail = false; let seenMode;
  const parser = { stop() {}, async parse(file, fields, mode) {
    seenMode = mode;
    if (fail) throw new Error('Example parse failure');
    return { pages: [{ number: 1, text: 'Total: $10.00' }], discovered: discoverFields('Total: $10.00'), values: { total: '$10.00' }, missing: [], analysis: { mode, warnings: [] } };
  } };
  const { service, store, input } = await fixture(t, parser);
  const id = await service.createCollection({ kind: 'quick', name: 'Quality' });
  assert.equal(service.collection(id).analysis_mode, 'high');
  const file = path.join(input, 'example.pdf'); await fs.writeFile(file, 'example');
  await service.importPaths(id, [file]); await complete(service); assert.equal(seenMode, 'high');
  const doc = service.snapshot(id).documents[0];
  await service.review(doc.id, { total: '$12.00' });
  await service.setAnalysisMode(id, 'standard');
  service.paused = true; await service.reanalyze(doc.id);
  assert.equal(parse(csvFor(store, service.collection(id)), { columns: true, bom: true })[0].total, '$12.00');
  fail = true; service.togglePause(); await complete(service);
  assert.equal(seenMode, 'standard');
  let retained = service.document(doc.id); assert.equal(retained.values.total, '$12.00'); assert.equal(retained.reviewed, true);
  assert.equal(retained.analysis.mode, 'high'); assert.match(service.snapshot(id).documents[0].error, /previous result kept/);
  fail = false; await service.reanalyze(doc.id); await complete(service);
  retained = service.document(doc.id); assert.equal(retained.values.total, '$10.00'); assert.equal(retained.reviewed, false); assert.equal(retained.analysis.mode, 'standard');
  assert.equal(service.snapshot(id).documents.length, 1);
  await assert.rejects(service.setAnalysisMode(id, 'invalid'));
});

test('review preserves blank table cells and removal retention cannot purge active reanalysis', async t => {
  const { service, store, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Table review' });
  const file = path.join(input, 'table.pdf'); await fs.writeFile(file, 'Vendor: Example');
  await service.importPaths(id, [file]); await complete(service);
  const doc = service.snapshot(id).documents[0];
  await service.review(doc.id, doc.values, [{ label: 'Line item date', value: 'placeholder' }]);
  await service.review(doc.id, { ...service.document(doc.id).values, line_item_date: '\n2026-10-15\n' });
  assert.equal(service.document(doc.id).values.line_item_date, '\n2026-10-15\n');
  service.paused = true; await service.reanalyze(doc.id);
  await service.setRetention(id, false);
  assert.equal(store.get('SELECT purged FROM documents WHERE id = ?', [doc.id]).purged, 0);
  service.togglePause(); await complete(service);
  const next = service.document(doc.id); await service.review(doc.id, next.values);
  assert.equal(service.snapshot(id).documents[0].purged, 1);
  await assert.rejects(service.reanalyze(doc.id), /retained source/);
});

test('v2 data migrates to Standard analysis and keeps existing values', async t => {
  const { service, store, data, input } = await fixture(t);
  const id = await service.createCollection({ name: 'Previous version' });
  const file = path.join(input, 'previous.pdf'); await fs.writeFile(file, 'Vendor: Example Existing Seller');
  await service.importPaths(id, [file]); await complete(service);
  await store.transaction(() => {
    store.db.exec('ALTER TABLE collections DROP COLUMN analysis_mode');
    store.db.exec('ALTER TABLE documents DROP COLUMN analysis_json');
    store.db.exec('ALTER TABLE documents DROP COLUMN reprocess');
    store.db.exec('PRAGMA user_version = 2');
  });
  await service.stop();
  const reopened = await Store.open(data);
  try {
    assert.equal(reopened.get('PRAGMA user_version').user_version, 3);
    const collection = reopened.get('SELECT * FROM collections WHERE id = ?', [id]);
    assert.equal(collection.name, 'Previous version'); assert.equal(collection.analysis_mode, 'standard');
    assert.equal(JSON.parse(reopened.get('SELECT values_json FROM documents WHERE collection_id = ?', [id]).values_json).vendor, 'Example Existing Seller');
  } finally { await reopened.close(); }
});

test('real native LiteParse worker extracts a PDF using bundled assets', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-real-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'invoice.pdf'); await fs.writeFile(file, pdfFixture());
  const result = await new ParserRunner().parse(file, []);
  assert.equal(result.pages.length, 1); assert.equal(result.values.vendor, 'Acme Supplies'); assert.equal(result.values.invoice_number, 'INV-100'); assert.equal(result.values.total, '$125.00');
});
