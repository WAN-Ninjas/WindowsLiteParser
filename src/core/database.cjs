'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  static async open(directory) {
    directory = path.resolve(directory);
    await fs.promises.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'portal.sqlite');
    // Do not replace an unreadable or corrupt database with an empty one.
    const store = new Store(new DatabaseSync(filename), filename);
    try {
      await fs.promises.chmod(filename, 0o600);
      if (store.get('PRAGMA integrity_check').integrity_check !== 'ok') throw new Error('Database integrity check failed. Restore your data folder from backup.');
      const version = store.get('PRAGMA user_version').user_version;
      if (version > 3) throw new Error('This data folder was created by a newer Portal version.');
      store.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA secure_delete = ON;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','quick')),
          name TEXT NOT NULL, fields TEXT NOT NULL, watch_path TEXT NOT NULL DEFAULT '',
          output_path TEXT NOT NULL, export_error TEXT NOT NULL DEFAULT '',
          watch_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          collection_id TEXT NOT NULL REFERENCES collections(id), name TEXT NOT NULL,
          source_path TEXT NOT NULL, staged_path TEXT NOT NULL, sha256 TEXT NOT NULL,
          bytes INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
          error TEXT NOT NULL DEFAULT '', page_count INTEGER NOT NULL DEFAULT 0,
          values_json TEXT NOT NULL DEFAULT '{}', missing_json TEXT NOT NULL DEFAULT '[]',
          reviewed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          UNIQUE(collection_id, sha256)
        );
        CREATE TABLE IF NOT EXISTS pages (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          number INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(document_id, number)
        );
        CREATE INDEX IF NOT EXISTS document_queue ON documents(status, sequence);
        CREATE INDEX IF NOT EXISTS document_collection ON documents(collection_id, sequence);
      `);
      if (version < 2) {
        store.db.exec('ALTER TABLE collections ADD COLUMN retain_content INTEGER NOT NULL DEFAULT 1');
        store.db.exec('ALTER TABLE documents ADD COLUMN purged INTEGER NOT NULL DEFAULT 0');
        store.db.exec('PRAGMA user_version = 2');
      }
      if (version < 3) {
        store.db.exec("ALTER TABLE collections ADD COLUMN analysis_mode TEXT NOT NULL DEFAULT 'standard'");
        store.db.exec("ALTER TABLE documents ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'");
        store.db.exec('ALTER TABLE documents ADD COLUMN reprocess INTEGER NOT NULL DEFAULT 0');
        store.db.exec('PRAGMA user_version = 3');
      }
      const prior = store.get("SELECT value FROM settings WHERE key = 'data_directory'")?.value;
      if (prior && prior !== directory) {
        const normalize = value => value.replaceAll('\\', '/').replace(/\/+$/, '');
        const oldRoot = normalize(prior);
        const relocate = value => {
          const normalized = normalize(value);
          const insensitive = /^[a-z]:/i.test(oldRoot);
          const prefix = `${oldRoot}/`;
          const matches = insensitive ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix);
          if (!matches) return value;
          const parts = normalized.slice(prefix.length).split('/');
          if (parts.some(part => part === '..' || part === '.')) throw new Error('Invalid managed path in the project database.');
          return path.join(directory, ...parts);
        };
        for (const row of store.all("SELECT id, staged_path FROM documents WHERE staged_path <> ''")) {
          store.run('UPDATE documents SET staged_path = ? WHERE id = ?', [relocate(row.staged_path), row.id]);
        }
        for (const row of store.all('SELECT id, output_path FROM collections')) {
          store.run('UPDATE collections SET output_path = ? WHERE id = ?', [relocate(row.output_path), row.id]);
        }
      }
      store.run("INSERT OR REPLACE INTO settings(key, value) VALUES('data_directory', ?)", [directory]);
      store.db.exec("UPDATE documents SET status = 'queued', error = '' WHERE status = 'processing'; COMMIT;");
      await store.persist();
      return store;
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* No open transaction. */ }
      store.db.close();
      throw error;
    }
  }

  constructor(db, filename) { this.db = db; this.filename = filename; this.closed = false; }
  all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }
  get(sql, params = []) { return this.db.prepare(sql).get(...params); }
  run(sql, params = []) { return this.db.prepare(sql).run(...params); }
  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve original IO error. */ } throw error; }
  }
  persist() {
    if (this.closed) throw new Error('Database is closed.');
    // SQLite commits are already durable; this compatibility hook never copies the database.
    return Promise.resolve();
  }
  async close() { this.db.close(); this.closed = true; }
}

module.exports = { Store };
