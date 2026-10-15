'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DEFAULT_FIELDS, validateFields, mergeFields, fieldName } = require('./extraction.cjs');
const { walk, stageFile, supported, inside } = require('./files.cjs');
const { exportCsv } = require('./csv.cjs');
const { profile } = require('./analysis.cjs');
const { previewTeaching } = require('./teaching.cjs');

class PortalService extends EventEmitter {
  constructor(store, directory, parser) {
    super();
    this.store = store; this.directory = directory; this.parser = parser;
    this.running = false; this.stopping = false; this.paused = false;
    this.imports = Promise.resolve(); this.exports = Promise.resolve();
    this.seen = new Map(); this.polling = false; this.fatalError = '';
    this.purging = new Set();
  }
  async start() {
    await fs.mkdir(path.join(this.directory, 'sources'), { recursive: true });
    await fs.mkdir(path.join(this.directory, 'exports'), { recursive: true });
    // Remove interrupted staging files, keeping every database-owned source.
    const owned = new Set(this.store.all('SELECT staged_path FROM documents').map(row => path.basename(row.staged_path)));
    for (const name of await fs.readdir(path.join(this.directory, 'sources'))) {
      if (!owned.has(name)) await fs.rm(path.join(this.directory, 'sources', name), { force: true });
    }
    await this.refreshExports();
    this.timer = setInterval(() => this.poll().catch(error => this.fail(error)), 4000);
    this.pump();
    this.poll().catch(error => this.fail(error));
  }
  fail(error) { this.fatalError = error.message || String(error); this.paused = true; this.emit('change'); }
  guard() { if (this.stopping) throw new Error('Portal is closing.'); if (this.fatalError) throw new Error(this.fatalError); }
  collection(id) {
    const row = this.store.get('SELECT * FROM collections WHERE id = ?', [String(id)]);
    if (!row) throw new Error('Project or conversion not found.');
    return row;
  }
  async createCollection({ kind = 'project', name, fields = DEFAULT_FIELDS, watchPath = '', retainContent = true, analysisMode = 'high' }) {
    this.guard();
    if (!['project', 'quick'].includes(kind)) throw new Error('Invalid conversion type.');
    name = String(name || '').trim();
    if (!name || name.length > 100) throw new Error('Enter a name of at most 100 characters.');
    fields = validateFields(fields);
    profile(analysisMode);
    if (watchPath) {
      watchPath = path.resolve(watchPath);
      if (inside(watchPath, this.directory) || inside(this.directory, watchPath)) throw new Error('Choose a watched folder separate from the Portal data folder.');
      if (!(await fs.stat(watchPath)).isDirectory()) throw new Error('The watched path must be a folder.');
    }
    const id = randomUUID();
    const output = path.join(this.directory, 'exports', `${id}.csv`);
    await this.store.transaction(() => this.store.run(
      'INSERT INTO collections(id, kind, name, fields, watch_path, output_path, created_at, retain_content, analysis_mode) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, kind, name, JSON.stringify(fields), watchPath, output, new Date().toISOString(), retainContent ? 1 : 0, analysisMode]));
    await this.updateExport(id);
    this.emit('change');
    return id;
  }
  snapshot(id, options = {}) {
    const collections = this.store.all(`SELECT c.*, COUNT(d.id) AS total,
      SUM(CASE WHEN d.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN d.status = 'completed' AND d.reviewed = 0 AND d.purged = 0 THEN 1 ELSE 0 END) AS needs_review
      FROM collections c LEFT JOIN documents d ON c.id = d.collection_id GROUP BY c.id ORDER BY c.created_at DESC`)
      .map(row => ({ ...row, fields: JSON.parse(row.fields) }));
    const predicates = { all: '', needs_review: " AND status = 'completed' AND reviewed = 0 AND purged = 0", completed: " AND status = 'completed'", failed: " AND status = 'failed'", queued: " AND status IN ('queued','processing')" };
    const predicate = predicates[options.filter] ?? '';
    const documentTotal = id ? this.store.get(`SELECT COUNT(*) AS count FROM documents WHERE collection_id = ?${predicate}`, [String(id)]).count : 0;
    const page = Math.min(Math.max(0, Math.floor(Number(options.page) || 0)), Math.max(0, Math.ceil(documentTotal / 100) - 1));
    const documents = id ? this.store.all(`SELECT id, name, status, error, page_count, bytes, values_json, missing_json, reviewed, created_at, purged, reprocess, analysis_json, feedback_json
      FROM documents WHERE collection_id = ?${predicate} ORDER BY sequence DESC LIMIT 100 OFFSET ?`, [String(id), page * 100])
      .map(row => ({ ...row, values: JSON.parse(row.values_json), missing: JSON.parse(row.missing_json), analysis: JSON.parse(row.analysis_json), feedback: JSON.parse(row.feedback_json) })) : [];
    const counts = this.store.all('SELECT status, COUNT(*) AS count FROM documents GROUP BY status');
    return { collections, documents, counts, page, documentTotal, pageSize: 100, paused: this.paused, fatalError: this.fatalError, dataDirectory: this.directory, defaultFields: DEFAULT_FIELDS, theme: this.theme() };
  }
  theme() {
    const value = this.store.get("SELECT value FROM settings WHERE key = 'theme'")?.value;
    return ['light', 'dark'].includes(value) ? value : 'system';
  }
  async setTheme(value) {
    this.guard();
    if (!['light', 'dark'].includes(value)) throw new Error('Choose light or dark mode.');
    await this.store.transaction(() => this.store.run("INSERT OR REPLACE INTO settings(key, value) VALUES('theme', ?)", [value]));
    this.emit('change');
  }
  importPaths(id, inputs) {
    const operation = this.imports.then(() => this._importPaths(id, inputs));
    this.imports = operation.catch(() => {});
    return operation;
  }
  async _importPaths(id, inputs) {
    this.guard(); this.collection(id);
    const report = { added: 0, duplicates: 0, errors: [], unsupported: 0 };
    for (const input of inputs) {
      try {
        const stat = await fs.lstat(input);
        if (stat.isFile() && !supported(input)) { report.unsupported++; continue; }
        for await (const file of walk(input, this.directory)) {
          if (this.stopping) break;
          const docId = randomUUID();
          const staged = path.join(this.directory, 'sources', `${docId}${path.extname(file.path).toLowerCase()}`);
          let owned = false;
          try {
            const { hash, bytes } = await stageFile(file.path, staged);
            if (this.store.get('SELECT id FROM documents WHERE collection_id = ? AND sha256 = ?', [id, hash])) { report.duplicates++; continue; }
            await this.store.transaction(() => this.store.run(`INSERT INTO documents
              (id, collection_id, name, source_path, staged_path, sha256, bytes, status, created_at) VALUES(?,?,?,?,?,?,?,'queued',?)`,
            [docId, id, path.basename(file.path), file.path, staged, hash, bytes, new Date().toISOString()]));
            owned = true; report.added++;
            this.emit('change'); this.pump();
          } catch (error) {
            // A disk write error must not leave the in-memory DB pointing at a deleted source.
            owned = Boolean(this.store.get('SELECT id FROM documents WHERE id = ?', [docId]));
            if (owned) this.fail(error);
            report.errors.push(`${path.basename(file.path)}: ${error.message}`);
          } finally { if (!owned) await fs.rm(staged, { force: true }); }
          if (this.fatalError) break;
        }
      } catch (error) { report.errors.push(`${path.basename(input)}: ${error.message}`); }
      if (this.fatalError) break;
    }
    return report;
  }
  async pump() {
    if (this.running || this.stopping || this.paused) return;
    this.running = true;
    this.pumping = (async () => {
      while (!this.stopping && !this.paused) {
        const doc = this.store.get("SELECT * FROM documents WHERE status = 'queued' ORDER BY sequence LIMIT 1");
        if (!doc) break;
        await this.store.transaction(() => this.store.run("UPDATE documents SET status = 'processing', error = '' WHERE id = ?", [doc.id]));
        this.emit('change');
        let parsed;
        try {
          const collection = this.collection(doc.collection_id);
          parsed = await this.parser.parse(doc.staged_path, JSON.parse(collection.fields), collection.analysis_mode);
        }
        catch (error) {
          await this.store.transaction(() => this.store.run('UPDATE documents SET status = ?, error = ?, reprocess = ? WHERE id = ?',
            [this.stopping ? 'queued' : doc.reprocess ? 'completed' : 'failed', this.stopping ? '' : `${doc.reprocess ? 'Reanalysis failed; previous result kept. ' : ''}${error.message}`.slice(0, 4000), this.stopping ? doc.reprocess : 0, doc.id]));
          this.emit('change'); continue;
        }
        // This persistence error is fatal; do not mislabel a successful parse as a bad document.
        await this.store.transaction(() => {
          const fields = mergeFields(JSON.parse(this.collection(doc.collection_id).fields), parsed.discovered || []);
          const previous = JSON.parse(doc.values_json);
          const corrected = JSON.parse(doc.feedback_json).filter(item => item.status === 'corrected');
          for (const item of corrected) parsed.values[item.field] = previous[item.field] ?? '';
          parsed.missing = fields.filter(field => field.required && !parsed.values[field.name]).map(field => field.name);
          parsed.analysis = { ...parsed.analysis, manualCorrectionsKept: corrected.length };
          this.store.run('UPDATE collections SET fields = ? WHERE id = ?', [JSON.stringify(fields), doc.collection_id]);
          this.store.run('DELETE FROM pages WHERE document_id = ?', [doc.id]);
          for (const page of parsed.pages) this.store.run('INSERT INTO pages(document_id, number, text) VALUES(?,?,?)', [doc.id, page.number, page.text]);
          this.store.run("UPDATE documents SET status = 'completed', page_count = ?, values_json = ?, missing_json = ?, analysis_json = ?, reprocess = 0, reviewed = 0, error = '' WHERE id = ?",
            [parsed.pages.length, JSON.stringify(parsed.values), JSON.stringify(parsed.missing), JSON.stringify(parsed.analysis || {}), doc.id]);
        });
        await this.updateExport(doc.collection_id);
        this.emit('change');
      }
    })().catch(error => this.fail(error)).finally(() => { this.running = false; });
    await this.pumping;
  }
  async retry(id) {
    this.guard();
    const doc = this.store.get("SELECT * FROM documents WHERE id = ? AND status = 'failed'", [String(id)]);
    if (!doc) throw new Error('Only failed documents can be retried.');
    await this.store.transaction(() => this.store.run("UPDATE documents SET status = 'queued', error = '' WHERE id = ?", [doc.id]));
    this.emit('change'); this.pump();
  }
  async setAnalysisMode(id, mode) {
    this.guard(); this.collection(id); profile(mode);
    await this.store.transaction(() => this.store.run('UPDATE collections SET analysis_mode = ? WHERE id = ?', [mode, id]));
    this.emit('change');
  }
  async reanalyze(id) {
    this.guard();
    const doc = this.store.get("SELECT * FROM documents WHERE id = ? AND status = 'completed' AND purged = 0", [String(id)]);
    if (!doc) throw new Error('Only completed documents with retained source content can be reanalyzed.');
    await fs.access(doc.staged_path);
    await this.store.transaction(() => {
      const current = this.store.get('SELECT status, purged FROM documents WHERE id = ?', [doc.id]);
      if (current.status !== 'completed' || current.purged || this.purging.has(doc.id)) throw new Error('Document content is being removed or processed.');
      this.store.run("UPDATE documents SET status = 'queued', reprocess = 1, error = '' WHERE id = ?", [doc.id]);
    });
    this.emit('change'); this.pump();
  }
  document(id) {
    const row = this.store.get("SELECT * FROM documents WHERE id = ? AND status = 'completed'", [String(id)]);
    if (!row) throw new Error('The document has not finished processing.');
    if (row.purged) throw new Error('Local document content was removed by your retention setting. This record is retained in the project CSV.');
    const collection = this.collection(row.collection_id);
    const pages = this.store.all('SELECT number, text FROM pages WHERE document_id = ? ORDER BY number', [row.id]);
    let remaining = 200000;
    return { id: row.id, name: row.name, values: JSON.parse(row.values_json), missing: JSON.parse(row.missing_json),
      fields: JSON.parse(collection.fields), reviewed: Boolean(row.reviewed), analysis: JSON.parse(row.analysis_json),
      collectionId: collection.id, analysisMode: collection.analysis_mode, feedback: JSON.parse(row.feedback_json),
      text: pages.map(page => { const text = `--- Page ${page.number} ---\n${page.text}\n`; const part = text.slice(0, Math.max(0, remaining)); remaining -= text.length; return part; }).join('\n'),
      truncated: remaining < 0 };
  }
  previewTeaching(id, config) {
    this.guard(); this.document(id);
    const pages = this.store.all('SELECT number, text FROM pages WHERE document_id = ? ORDER BY number', [String(id)]);
    return previewTeaching(pages, config.example, config.anchor || '');
  }
  async feedback(id, name, flagged) {
    this.guard(); const doc = this.document(id);
    if (!doc.fields.some(field => field.name === name)) throw new Error('Choose an existing field.');
    if (this.purging.has(doc.id)) throw new Error('Document content is being removed.');
    const feedback = doc.feedback.filter(item => item.field !== name);
    if (flagged) feedback.push({ field: name, status: 'missed', updatedAt: new Date().toISOString() });
    await this.store.transaction(() => this.store.run('UPDATE documents SET feedback_json = ?, reviewed = 0 WHERE id = ?', [JSON.stringify(feedback), doc.id]));
    await this.updateExport(doc.collectionId); this.emit('change');
    return feedback;
  }
  async teach(id, config, values, additional = []) {
    this.guard(); const doc = this.document(id);
    const labelLimit = config?.field ? 100 : 80;
    if (!config || typeof config.label !== 'string' || !config.label.trim() || config.label.trim().length > labelLimit) throw new Error(`Enter a field name of at most ${labelLimit} characters.`);
    if (typeof config.example !== 'string' || config.example.length > 1000000) throw new Error('Enter an example of at most 1,000,000 characters, or leave it blank to flag the field.');
    const name = config.field || fieldName(config.label.trim());
    if (config.field && !doc.fields.some(field => field.name === name)) throw new Error('Choose an existing field.');
    if (!config.field && doc.fields.some(field => field.name === name)) throw new Error('This column already exists. Select it under Existing field.');
    let hint;
    if (config.reuse) {
      const preview = this.previewTeaching(id, config);
      if (!preview.usable) throw new Error(preview.message);
      hint = preview.hint;
    }
    await this.saveReview(id, values, additional, false, { name, label: config.label.trim(), example: config.example, hint });
  }
  async review(id, values, additional = []) { return this.saveReview(id, values, additional, true); }
  async saveReview(id, values, additional = [], reviewed = false, teaching = null) {
    this.guard();
    const doc = this.document(id);
    if (this.purging.has(doc.id)) throw new Error('Document content is being removed.');
    if (!Array.isArray(additional) || additional.length > 250) throw new Error('A document supports at most 250 additional fields.');
    const names = new Set(doc.fields.map(field => field.name));
    const newFields = additional.map(field => {
      if (typeof field?.label !== 'string' || !field.label.trim() || field.label.trim().length > 80) throw new Error('Each additional field needs a name of at most 80 characters.');
      if (typeof field.value !== 'string' || field.value.length > 1000000) throw new Error('Each field value must be text of at most 1,000,000 characters.');
      const name = fieldName(field.label.trim());
      if (names.has(name)) throw new Error('This column already exists. Use its value box or Teach / fix.');
      names.add(name);
      return { name, label: field.label.trim(), value: field.value };
    });
    const fields = mergeFields(doc.fields, newFields);
    const feedback = new Map(doc.feedback.map(item => [item.field, item]));
    if (teaching) {
      if (!fields.some(field => field.name === teaching.name)) fields.push({ name: teaching.name, label: teaching.label, pattern: '', required: false });
      const field = fields.find(field => field.name === teaching.name);
      if (teaching.hint) { field.hint = teaching.hint; field.pattern = ''; }
      else delete field.hint;
    }
    validateFields(fields);
    const clean = {};
    for (const field of fields) {
      const value = teaching?.name === field.name ? teaching.example : newFields.find(item => item.name === field.name)?.value ?? values?.[field.name] ?? doc.values[field.name] ?? '';
      if (typeof value !== 'string' || value.length > 1000000) throw new Error('Each field value must be text of at most 1,000,000 characters.');
      clean[field.name] = /^(?:line_item_|table_\d+_)/.test(field.name) ? value : value.trim();
      if (teaching?.name === field.name || clean[field.name] !== (doc.values[field.name] ?? '')) {
        const stillMissed = !clean[field.name].trim() && (teaching?.name === field.name || feedback.get(field.name)?.status === 'missed');
        const status = stillMissed ? 'missed' : 'corrected';
        feedback.set(field.name, { field: field.name, status, updatedAt: new Date().toISOString() });
      }
    }
    const missing = fields.filter(field => field.required && !clean[field.name]).map(field => field.name);
    if (reviewed && missing.length) throw new Error(`Fill the required fields before marking reviewed: ${missing.join(', ')}`);
    const unresolved = [...feedback.values()].filter(item => item.status === 'missed');
    if (reviewed && unresolved.length) throw new Error(`Resolve or clear missed-field flags before marking reviewed: ${unresolved.map(item => item.field).join(', ')}`);
    await this.store.transaction(() => {
      this.store.run('UPDATE collections SET fields = ? WHERE id = ?', [JSON.stringify(fields), doc.collectionId]);
      this.store.run('UPDATE documents SET values_json = ?, missing_json = ?, feedback_json = ?, reviewed = ? WHERE id = ?', [JSON.stringify(clean), JSON.stringify(missing), JSON.stringify([...feedback.values()]), reviewed ? 1 : 0, doc.id]);
    });
    await this.updateExport(doc.collectionId);
    this.emit('change');
  }
  async updateExport(id, destination) {
    const task = this.exports.then(async () => {
      const collection = this.collection(id);
      let exported;
      if (destination) {
        // Never allow choosing the SQLite DB, an imported source, or a non-CSV file.
        if (path.extname(destination).toLowerCase() !== '.csv' || inside(destination, path.join(this.directory, 'sources'))) throw new Error('Choose a CSV output file outside the source storage folder.');
        exported = await exportCsv(this.store, collection, destination);
        await this.store.transaction(() => this.store.run("UPDATE collections SET output_path = ?, export_error = '' WHERE id = ?", [destination, id]));
      } else {
        let exportError = '';
        try { exported = await exportCsv(this.store, collection); }
        catch (error) { exportError = `CSV could not be updated: ${error.message}. Close it in Excel or choose another location.`; }
        if (exportError !== collection.export_error) await this.store.transaction(() => this.store.run('UPDATE collections SET export_error = ? WHERE id = ?', [exportError, id]));
      }
      if (exported && !collection.retain_content) await this.purgeExported(exported);
      this.emit('change');
    });
    this.exports = task.catch(() => {});
    return task;
  }
  async refreshExports() { for (const row of this.store.all('SELECT id FROM collections')) await this.updateExport(row.id); }
  async purgeExported(exported) {
    for (const row of exported.filter(doc => doc.reviewed && !doc.purged)) {
      const current = this.store.get('SELECT * FROM documents WHERE id = ?', [row.id]);
      if (!current || current.purged || current.reprocess || current.values_json !== row.values_json || !current.reviewed) continue;
      this.purging.add(row.id);
      try { await fs.rm(current.staged_path, { force: true }); }
      catch (error) {
        await this.store.transaction(() => this.store.run('UPDATE collections SET export_error = ? WHERE id = ?', [`CSV saved, but local source cleanup failed: ${error.message}`, row.collection_id]));
        continue;
      } finally { this.purging.delete(row.id); }
      await this.store.transaction(() => {
        const latest = this.store.get('SELECT values_json, reviewed, purged, reprocess FROM documents WHERE id = ?', [row.id]);
        if (latest.purged || latest.reprocess || !latest.reviewed || latest.values_json !== row.values_json) return;
        this.store.run('DELETE FROM pages WHERE document_id = ?', [row.id]);
        this.store.run("UPDATE documents SET purged = 1, values_json = '{}', missing_json = '[]', analysis_json = '{}', feedback_json = '[]', name = 'Exported document', source_path = '', staged_path = '' WHERE id = ?", [row.id]);
      });
    }
  }
  async setRetention(id, retainContent) {
    this.guard(); this.collection(id);
    await this.store.transaction(() => this.store.run('UPDATE collections SET retain_content = ? WHERE id = ?', [retainContent ? 1 : 0, id]));
    await this.updateExport(id); this.emit('change');
  }
  async setWatch(id, watchPath) {
    this.guard(); const collection = this.collection(id);
    if (collection.kind !== 'project') throw new Error('Quick conversions do not watch folders.');
    if (watchPath && (inside(watchPath, this.directory) || inside(this.directory, watchPath))) throw new Error('Choose a watched folder separate from the data folder.');
    if (watchPath && !(await fs.stat(watchPath)).isDirectory()) throw new Error('Choose an existing folder.');
    await this.store.transaction(() => this.store.run("UPDATE collections SET watch_path = ?, watch_error = '' WHERE id = ?", [watchPath, id]));
    this.seen.delete(id); this.emit('change');
  }
  async poll() {
    if (this.polling || this.stopping || this.paused) return;
    this.polling = true;
    try {
      for (const collection of this.store.all("SELECT * FROM collections WHERE kind = 'project' AND watch_path <> ''")) {
        if (this.stopping || this.paused) break;
        let errorMessage = '';
        const previous = this.seen.get(collection.id) || new Map();
        const next = new Map();
        try {
          for await (const file of walk(collection.watch_path, this.directory)) {
            if (this.stopping) break;
            const signature = `${file.size}:${file.mtimeMs}`;
            const prior = previous.get(file.path);
            let imported = prior?.signature === signature && prior.imported;
            if (!imported && prior?.signature === signature) {
              const report = await this.importPaths(collection.id, [file.path]);
              imported = report.added > 0 || report.duplicates > 0;
              if (report.errors.length) errorMessage = report.errors.slice(0, 3).join('\n');
            }
            next.set(file.path, { signature, imported });
          }
          this.seen.set(collection.id, next);
        } catch (error) { errorMessage = `Watched folder: ${error.message}`; }
        if (errorMessage !== collection.watch_error) {
          await this.store.transaction(() => this.store.run('UPDATE collections SET watch_error = ? WHERE id = ?', [errorMessage, collection.id]));
          this.emit('change');
        }
      }
      for (const collection of this.store.all("SELECT id FROM collections WHERE export_error <> ''")) await this.updateExport(collection.id);
    } finally { this.polling = false; }
  }
  togglePause() { this.guard(); this.paused = !this.paused; this.emit('change'); if (!this.paused) this.pump(); return this.paused; }
  async stop() {
    this.stopping = true; clearInterval(this.timer); this.parser.stop();
    await this.imports; await this.pumping; await this.exports;
    // poll() can be awaiting an import or an export; let it observe stopping before closing SQLite.
    while (this.polling) await new Promise(resolve => setTimeout(resolve, 10));
    await this.store.close();
  }
}

module.exports = { PortalService };
