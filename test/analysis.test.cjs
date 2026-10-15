'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyzeDocument, profile } = require('../src/core/analysis.cjs');
const { ParserRunner } = require('../src/core/parser.cjs');
const { invoiceFixture } = require('../src/pdf-fixture.cjs');

function tablePage(rows, headers = ['DATE', 'DESCRIPTION', 'QTY', 'AMOUNT']) {
  const span = (text, x, y, fontSize = 10) => ({ text, x, y, width: 70, height: 10, fontSize });
  return {
    text: 'INVOICE                 BILL TO\nDate: 2026-10-15\n\nDATE    DESCRIPTION    QTY    AMOUNT\n\n10/15/2026    Service    1    $10.00\n\nTotal: $20.00',
    textItems: [span('Example Seller', 400, 30, 18), span('INVOICE', 30, 120, 32), span('#TEST-42', 30, 160),
      span('Date: 2026-10-15', 30, 180), span('Due:', 30, 200), span('BILL TO', 400, 130), span('Example Buyer', 400, 150),
      ...headers.map((header, index) => span(header, 30 + index * 140, 240)), span('Total: $20.00', 450, 500)],
    blocks: [{ kind: 'table', bbox: { x: 30, y: 260, width: 550, height: 100 }, rows: rows.map(row => row.map(text => ({ text }))) }]
  };
}

test('high accuracy separates headings and preserves spaced table rows and repeated values', () => {
  const row = ['10/15/2026', 'Example service', '1', '$10.00'];
  const result = analyzeDocument([tablePage([row, row])], [], 'high');
  assert.equal(result.values.invoice_number, 'TEST-42'); assert.equal(result.values.invoice_date, '2026-10-15');
  assert.equal(result.values.vendor, 'Example Seller'); assert.equal(result.values.bill_to, 'Example Buyer');
  assert.equal(result.values.invoice, undefined); assert.equal(result.values.due_date, '');
  assert.equal(result.values.line_item_qty, '1\n1'); assert.equal(result.values.line_item_amount, '$10.00\n$10.00');
  assert.equal(result.analysis.lineItemCount, 2); assert.equal(result.analysis.checks[0].passed, true);
  assert.deepEqual(result.analysis.warnings, []);
  const standard = analyzeDocument([tablePage([row, row])], [], 'standard');
  assert.equal(standard.values.invoice, 'BILL TO'); assert.equal(standard.values.line_item_count, undefined);
});

test('table columns keep empty cells at the start and end and preserve all-text first data rows', () => {
  const page = tablePage([['', 'Service', '1', '$10.00'], ['', 'Service', '1', '$10.00']]);
  const result = analyzeDocument([page], [], 'high');
  assert.equal(result.values.line_item_date, '\n');
  assert.equal(result.values.line_item_description.split('\n').length, 2);
  const generic = tablePage([['REGION', 'CITY'], ['West', 'Example City']]);
  generic.textItems = []; generic.text = '';
  const values = analyzeDocument([generic], [], 'high').values;
  assert.equal(values.table_1_region, 'West'); assert.equal(values.table_1_city, 'Example City');
  const separateHeader = tablePage([['West', 'Example City'], ['East', 'Other City']], ['REGION', 'CITY']);
  const separate = analyzeDocument([separateHeader], [], 'high').values;
  assert.equal(separate.table_1_region, 'West\nEast');
  separateHeader.blocks[0].header = [{ text: 'REGION' }, { text: 'CITY' }];
  separateHeader.textItems = []; separateHeader.text = '';
  assert.equal(analyzeDocument([separateHeader], [], 'high').values.table_1_city, 'Example City\nOther City');
});

test('high accuracy flags total mismatches and unknown headers, and manual rules retain priority', () => {
  const page = tablePage([['10/15/2026', 'Service', '1', '$8.00']]);
  const fields = [{ name: 'total', label: 'Total', pattern: 'Total: (.+)', required: true }, { name: 'account', label: 'Account', pattern: '', required: true }];
  const result = analyzeDocument([page], fields, 'high');
  assert.equal(result.values.total, '$20.00'); assert.deepEqual(result.missing, ['account']);
  assert.equal(result.analysis.checks[0].passed, false); assert.equal(result.analysis.warnings.length, 1);
  page.textItems = []; page.text = ''; const unknown = analyzeDocument([page], [], 'high');
  assert.ok(unknown.values.table_1_column_1); assert.match(unknown.analysis.warnings[0], /headers/);
  assert.equal(profile('high').dpi, 300); assert.ok(profile('high').timeoutMs > profile('standard').timeoutMs);
  assert.throws(() => profile('other'));
});

test('real high accuracy worker extracts a synthetic multi-column invoice with ten repeated line items', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'example-invoice.pdf'); await fs.writeFile(file, invoiceFixture());
  const parser = new ParserRunner(); t.after(() => parser.stop());
  const result = await parser.parse(file, [], 'high');
  assert.equal(result.values.invoice_number, 'INV-EXAMPLE-42');
  assert.equal(result.values.vendor, 'Example Supply LLC'); assert.equal(result.values.bill_to, 'Example Customer');
  assert.equal(result.values.line_item_qty, Array(10).fill('1').join('\n'));
  assert.equal(result.values.line_item_amount, Array(10).fill('$10.00').join('\n'));
  assert.equal(result.values.line_item_count, '10'); assert.equal(result.values.due_date, '');
  assert.deepEqual(result.analysis.checks, [{ label: 'Line-item amounts match the document total', passed: true }]);
});
