'use strict';

const { META_COLUMNS } = require('./extraction.cjs');
const { atomicWrite } = require('./files.cjs');
const fs = require('node:fs');
const { parse } = require('csv-parse/sync');

function cell(value) {
  let text = String(value ?? '').replace(/\0/g, '');
  // Prevent spreadsheet formula execution, including formulas after whitespace.
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvData(store, collection) {
  const fields = JSON.parse(collection.fields);
  const columns = [...META_COLUMNS, ...fields.map(field => field.name)];
  const rows = new Map();
  const purged = store.all('SELECT id FROM documents WHERE collection_id = ? AND purged = 1', [collection.id]);
  if (purged.length) {
    if (!fs.existsSync(collection.output_path)) throw new Error('The CSV containing previously exported-only records is missing. Restore it to its saved location before exporting again.');
    const previous = parse(fs.readFileSync(collection.output_path, 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
    for (const row of previous) {
      if (!row.document_id || rows.has(row.document_id) || !META_COLUMNS.every(key => Object.hasOwn(row, key))) throw new Error('The existing CSV has invalid or duplicate record IDs. Restore the last unmodified CSV.');
      rows.set(row.document_id, row);
    }
    if (purged.some(row => !rows.has(row.id))) throw new Error('The CSV is missing previously exported-only records. Restore the complete CSV before exporting again.');
  }
  const exported = store.all("SELECT * FROM documents WHERE collection_id = ? AND (status = 'completed' OR reprocess = 1) AND purged = 0 ORDER BY sequence", [collection.id]);
  for (const row of exported) {
    const values = JSON.parse(row.values_json);
    rows.set(row.id, { document_id: row.id, source_file: row.name, sha256: row.sha256, page_count: row.page_count,
      imported_at: row.created_at, review_status: row.reviewed ? 'reviewed' : 'needs_review', ...values });
  }
  const lines = [columns.map(cell).join(',')];
  for (const row of rows.values()) lines.push(columns.map(column => cell(row[column] ?? '')).join(','));
  return { text: '\uFEFF' + lines.join('\r\n') + '\r\n', exported };
}

function csvFor(store, collection) { return csvData(store, collection).text; }

async function exportCsv(store, collection, destination = collection.output_path) {
  const data = csvData(store, collection);
  await atomicWrite(destination, data.text);
  return data.exported;
}

module.exports = { cell, csvFor, exportCsv };
