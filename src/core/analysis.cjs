'use strict';

const { discoverFields, fieldName, mergeFields, extractFields } = require('./extraction.cjs');
const { applyHints } = require('./teaching.cjs');

const PROFILES = {
  standard: { label: 'Standard', dpi: 150, timeoutMs: 120000 },
  high: { label: 'High accuracy', dpi: 300, timeoutMs: 600000 }
};

function profile(mode = 'standard') {
  if (!Object.hasOwn(PROFILES, mode)) throw new Error('Choose Standard or High accuracy analysis.');
  return { mode, ...PROFILES[mode] };
}

function rowsFor(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const center = item.y + item.height / 2;
    const row = rows.find(candidate => Math.abs(candidate.center - center) <= Math.max(3, Math.min(candidate.height, item.height) * 0.5));
    if (row) row.items.push(item);
    else rows.push({ center, height: item.height, items: [item] });
  }
  return rows.sort((a, b) => a.center - b.center).map(row => row.items.sort((a, b) => a.x - b.x));
}

function headerLabel(value) { return /^[\p{L}][\p{L}\s_.()#%/–-]{0,79}$/u.test(value.trim()); }
function inBox(item, box) {
  if (!box) return false;
  const x = item.x + item.width / 2; const y = item.y + item.height / 2;
  return x >= box.x - 2 && x <= box.x + box.width + 2 && y >= box.y - 2 && y <= box.y + box.height + 2;
}
function emailIn(text) { return text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || ''; }

function discoverLayout(pages) {
  const found = new Map();
  const warnings = [];
  const checks = [];
  let tableCount = 0; let tableRowCount = 0; let lineItemCount = 0;
  const invoice = pages.some(page => (page.textItems || []).some(item => /^(?:tax\s+)?invoice$/i.test(item.text.trim())));
  const add = (label, value, name = fieldName(label), preserveRows = false) => {
    value = String(value ?? '');
    if (!preserveRows) value = value.trim();
    const existing = found.get(name);
    if (existing) {
      if (preserveRows) existing.value += `\n${value}`;
      else if (value && !existing.value.split('\n').includes(value)) existing.value += `${existing.value ? '\n' : ''}${value}`;
    } else found.set(name, { name, label, value, pattern: '', required: false });
    if (found.size > 250) throw new Error('More than 250 fields detected. Split this document into smaller inputs.');
  };
  const canonical = (name, label) => {
    if (!invoice) return name;
    if (name === 'date') return 'invoice_date';
    if (['due', 'due_date', 'payment_due'].includes(name)) return 'due_date';
    return fieldName(label);
  };

  for (const page of pages) {
    const items = (page.textItems || []).filter(item => item.text?.trim() && [item.x, item.y, item.width, item.height].every(Number.isFinite));
    const tables = (page.blocks || []).filter(block => block.kind === 'table' && Array.isArray(block.rows) && block.rows.length);
    const plainItems = items.filter(item => !tables.some(table => inBox(item, table.bbox)));

    // Individual positioned spans avoid treating unrelated page columns as label/value pairs.
    for (const item of plainItems) {
      for (const field of discoverFields(item.text)) add(field.label, field.value, canonical(field.name, field.label));
    }
    for (const row of rowsFor(plainItems)) {
      for (let index = 0; index < row.length - 1; index++) {
        const label = row[index]; const value = row[index + 1];
        if (/^[\p{L}][^:]{0,78}:$/u.test(label.text.trim()) && value.x >= label.x + label.width && value.x - label.x - label.width < 100) {
          const clean = label.text.trim().slice(0, -1);
          add(clean, value.text, canonical(fieldName(clean), clean));
        }
      }
    }

    for (const table of tables) {
      const width = table.rows[0].length;
      if (width < 2 || width > 40) continue;
      let headers; let data = table.rows;
      if (table.header?.length === width && table.header.every(cell => headerLabel(cell.text || ''))) {
        headers = table.header.map(cell => cell.text.trim());
      } else {
        const candidates = table.bbox ? rowsFor(items.filter(item => item.y + item.height <= table.bbox.y + 2 && table.bbox.y - item.y <= 90 &&
          item.x >= table.bbox.x - 20 && item.x <= table.bbox.x + table.bbox.width + 20)) : [];
        const header = candidates.reverse().find(row => row.length === width && row.every(item => headerLabel(item.text)));
        if (header) headers = header.map(item => item.text.trim());
        else if (table.rows[0].every(cell => headerLabel(cell.text || ''))) {
          headers = table.rows[0].map(cell => cell.text.trim()); data = table.rows.slice(1);
        }
      }
      if (!data.length) continue;
      tableCount++; tableRowCount += data.length;
      if (!headers) {
        headers = Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
        warnings.push(`Table ${tableCount}: headers could not be identified confidently; check its column names.`);
      }
      const lineItems = invoice && headers.some(label => /description|item|product|service/i.test(label)) && headers.some(label => /qty|quantity|amount|price|total/i.test(label));
      const prefix = lineItems ? 'line_item' : `table_${tableCount}`;
      const seenNames = new Set();
      headers.forEach((label, column) => {
        const base = `${prefix}_${fieldName(label)}`.slice(0, 60);
        let name = base; let suffix = 2;
        while (seenNames.has(name)) name = `${base}_${suffix++}`;
        seenNames.add(name);
        add(`${lineItems ? 'Line item' : `Table ${tableCount}`} · ${label}`, data.map(row => String(row[column]?.text ?? '').trim()).join('\n'), name, true);
      });
      if (lineItems) lineItemCount += data.length;
    }

    // Labeled PDF form widgets are stronger evidence than inferred text layout.
    for (const field of page.formFields || []) {
      if (typeof field.name === 'string' && typeof field.value === 'string') add(field.name, field.value);
    }

    const invoiceTitle = plainItems.find(item => /^(?:tax\s+)?invoice$/i.test(item.text.trim()));
    if (invoiceTitle) {
      add('Document type', 'invoice', 'document_type');
      const header = plainItems.filter(item => item.y + item.height < invoiceTitle.y && !/[:@]/.test(item.text) &&
        /\p{L}/u.test(item.text) && !/\d/.test(item.text));
      const seller = header.sort((a, b) => (b.fontSize || b.height) - (a.fontSize || a.height))[0];
      if (seller) {
        add('Vendor', seller.text, 'vendor');
        const details = plainItems.filter(item => item.y > seller.y + seller.height && item.y < invoiceTitle.y &&
          item.x + item.width > seller.x && item.x < seller.x + seller.width + 20).sort((a, b) => a.y - b.y);
        const address = details.filter(item => !emailIn(item.text) && /\d/.test(item.text)).map(item => item.text.trim());
        if (address.length) add('Vendor address', address.join('\n'), 'vendor_address');
        const contact = details.map(item => item.text).join(' ');
        if (emailIn(contact)) add('Vendor email', emailIn(contact), 'vendor_email');
        const phone = contact.match(/(?:\+\d[\d ().-]{6,}\d|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/)?.[0];
        if (phone) add('Vendor phone', phone, 'vendor_phone');
      }
      const identifier = plainItems.find(item => item.y >= invoiceTitle.y && item.y < invoiceTitle.y + 130 &&
        Math.abs(item.x - invoiceTitle.x) < 30 && /^#\s*[A-Z0-9][A-Z0-9_./-]*$/i.test(item.text.trim()));
      if (identifier) add('Invoice number', identifier.text.trim().replace(/^#\s*/, ''), 'invoice_number');
    }

    // Read short blocks directly below explicit section labels, within the same column.
    for (const label of plainItems) {
      const heading = label.text.trim().replace(/:$/, '');
      if (!/^(?:bill(?:ed)?\s*to|ship(?:ped)?\s*to|sold\s*to|customer|client|vendor|supplier|payment\s+terms|terms\s*(?:&|and)?\s*conditions)$/i.test(heading)) continue;
      const below = plainItems.filter(item => item !== label && item.y >= label.y + label.height - 1 &&
        item.y - label.y < 140 && Math.abs(item.x - label.x) < 20).sort((a, b) => a.y - b.y);
      const block = []; let bottom = label.y + label.height;
      for (const item of below) {
        if (item.y - bottom > Math.max(22, (item.fontSize || item.height) * 2.5) || /:$/.test(item.text.trim())) break;
        block.push(item.text.trim()); bottom = item.y + item.height;
      }
      if (!block.length) continue;
      const key = fieldName(heading);
      const content = block.filter(line => !emailIn(line));
      if (content.length) add(heading, content.join('\n'), key);
      const contact = emailIn(block.join(' '));
      if (contact) add(`${heading} email`, contact, `${key}_email`);
    }
    for (const item of plainItems) {
      const emptyLabel = /^([\p{L}][\p{L}\s]{0,60}):$/u.exec(item.text.trim());
      if (!emptyLabel) continue;
      const key = canonical(fieldName(emptyLabel[1]), emptyLabel[1]);
      if (!found.has(key)) add(emptyLabel[1], '', key);
    }

    // A text-only fallback still handles documents whose parser provides no positioned spans.
    if (!items.length) for (const field of discoverFields(page.text || '')) add(field.label, field.value, canonical(field.name, field.label));
  }
  if (lineItemCount) add('Line item count', String(lineItemCount), 'line_item_count');
  const amount = found.get('line_item_amount'); const total = found.get('total');
  const money = value => /^\$?\s*\d[\d,]*\.\d{2}$/.test(value.trim()) ? Math.round(Number(value.replace(/[$,\s]/g, '')) * 100) : null;
  if (amount && total && ![...found.keys()].some(key => /^(?:tax|discount|shipping|freight)/.test(key))) {
    const amounts = amount.value.split('\n').map(money); const target = money(total.value);
    if (target !== null && amounts.every(value => value !== null)) {
      const matches = amounts.reduce((sum, value) => sum + value, 0) === target;
      checks.push({ label: 'Line-item amounts match the document total', passed: matches });
      if (!matches) warnings.push('Line-item amounts do not match the stated total. Check for omitted rows, taxes, discounts, or OCR errors.');
    }
  }
  if (!found.size) warnings.push('No labeled fields were identified. Add fields manually while reviewing the source text.');
  return { discovered: [...found.values()], analysis: { mode: 'high', tableCount, tableRowCount, lineItemCount, warnings, checks } };
}

function analyzeDocument(pages, existing = [], mode = 'standard') {
  profile(mode);
  const text = pages.map(page => page.text || '').join('\n\n');
  const result = mode === 'high' ? discoverLayout(pages) : {
    discovered: discoverFields(text), analysis: { mode: 'standard', tableCount: 0, tableRowCount: 0, lineItemCount: 0, warnings: [], checks: [] }
  };
  const fields = mergeFields(existing, result.discovered);
  const extracted = extractFields(text, fields);
  for (const field of result.discovered) if (!extracted.values[field.name]) extracted.values[field.name] = field.value;
  const taught = applyHints(pages, fields);
  Object.assign(extracted.values, taught.values);
  result.analysis.taughtFields = taught.results;
  for (const field of taught.results.filter(field => field.status !== 'matched')) result.analysis.warnings.push(`${field.label}: saved source label "${field.anchor}" ${field.status === 'ambiguous' ? 'has multiple matches' : 'did not find a value'}. Check this field during review.`);
  extracted.missing = fields.filter(field => field.required && !extracted.values[field.name]).map(field => field.name);
  return { ...result, ...extracted };
}

module.exports = { profile, analyzeDocument, discoverLayout };
