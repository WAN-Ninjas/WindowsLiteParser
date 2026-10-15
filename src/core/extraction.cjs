'use strict';

const DEFAULT_FIELDS = [];
const { validateHint } = require('./teaching.cjs');

const META_COLUMNS = ['document_id', 'source_file', 'sha256', 'page_count', 'imported_at', 'review_status'];

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length > 250) throw new Error('A project supports up to 250 extraction fields.');
  const names = new Set(META_COLUMNS);
  return fields.map(field => {
    if (!field || !/^[a-z][a-z0-9_]{0,63}$/.test(field.name) || names.has(field.name)) {
      throw new Error('Field names must be unique lowercase CSV names (letters, numbers, underscores), excluding reserved columns.');
    }
    names.add(field.name);
    if (typeof field.pattern !== 'string' || field.pattern.length > 2000) throw new Error('Each field needs a pattern of at most 2,000 characters.');
    try { new RegExp(field.pattern, 'im'); } catch (error) { throw new Error(`Invalid pattern for ${field.name}: ${error.message}`); }
    return { name: field.name, label: String(field.label || field.name).slice(0, 100), pattern: field.pattern, required: Boolean(field.required), ...(field.hint ? { hint: validateHint(field.hint) } : {}) };
  });
}

function fieldName(label) {
  let name = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/#/g, ' number ').replace(/\bno\.?\b/g, 'number').replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  if (!name) name = `field_${require('node:crypto').createHash('sha256').update(label).digest('hex').slice(0, 12)}`;
  if (!/^[a-z]/.test(name) || META_COLUMNS.includes(name)) name = `field_${name}`;
  return name;
}

function discoverFields(text) {
  const found = new Map();
  const add = (rawLabel, rawValue) => {
    const label = rawLabel.trim().replace(/[:=]+$/, '').trim();
    const value = rawValue.trim();
    if (!value || label.length < 2 || label.length > 80 || label.split(/\s+/).length > 10 ||
      !/^\p{L}[\p{L}\p{N}\s_.()#%/–-]*$/u.test(label) || /^(https?|ftp|www)$/i.test(label)) return;
    const name = fieldName(label);
    if (found.has(name)) {
      const prior = found.get(name);
      if (!prior.value.split('\n').includes(value)) prior.value += `\n${value}`;
    } else found.set(name, { name, label, pattern: '', required: false, value });
    if (found.size > 250) throw new Error('More than 250 fields detected. Split this document into smaller inputs.');
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Two columns or several side-by-side labeled values, as preserved by spatial text extraction.
    const columns = line.split(/\t+| {2,}/).filter(Boolean);
    // A simple aligned table becomes one field per column, with its values joined by newlines.
    const nextColumns = lines[i + 1]?.trim().split(/\t+| {2,}/).filter(Boolean) || [];
    if (columns.length >= 3 && columns.length <= 20 && columns.every(column => /^[\p{L}][\p{L}\s_.()#%/-]{1,79}$/u.test(column)) &&
        nextColumns.length === columns.length && nextColumns.some(column => /\d/.test(column))) {
      const tableRows = [];
      while (i + 1 < lines.length) {
        const row = lines[i + 1].trim().split(/\t+| {2,}/).filter(Boolean);
        if (row.length !== columns.length || row.some(value => value.includes(':'))) break;
        tableRows.push(row); i++;
      }
      columns.forEach((label, index) => add(label, tableRows.map(row => row[index]).join('\n')));
      continue;
    }
    let matched = false;
    for (const column of columns) {
      const pair = /^([^:=]{2,80})\s*[:=]\s*(.+)$/.exec(column);
      if (pair) { add(pair[1], pair[2]); matched = true; }
    }
    if (!matched && columns.length === 2) add(columns[0], columns[1]);
    if (!matched) {
      const pair = /^([^:=]{2,80})\s*[:=]\s*(.+)$/.exec(line);
      if (pair) add(pair[1], pair[2]);
      else if (/^[^:]{2,80}:$/.test(line) && lines[i + 1]?.trim() && !lines[i + 1].includes(':')) add(line.slice(0, -1), lines[++i]);
    }
  }
  return [...found.values()];
}

function mergeFields(current, discovered) {
  const union = new Map(current.map(field => [field.name, field]));
  for (const field of discovered) if (!union.has(field.name)) union.set(field.name, { name: field.name, label: field.label, pattern: '', required: false });
  return validateFields([...union.values()]);
}

function extractFields(text, fields) {
  const values = {};
  const missing = [];
  for (const field of validateFields(fields)) {
    const match = field.pattern ? new RegExp(field.pattern, 'im').exec(text) : null;
    values[field.name] = (match?.[1] ?? match?.[0] ?? '').trim();
    if (field.required && !values[field.name]) missing.push(field.name);
  }
  return { values, missing };
}

module.exports = { DEFAULT_FIELDS, META_COLUMNS, validateFields, extractFields, fieldName, discoverFields, mergeFields };
