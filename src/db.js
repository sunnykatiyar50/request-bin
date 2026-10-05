const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Opens (and if needed creates) the SQLite database using Node's built-in driver
function openDatabase(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS bins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            secret TEXT,
            redact_headers INTEGER NOT NULL DEFAULT 1,
            response_status INTEGER NOT NULL DEFAULT 200,
            response_content_type TEXT NOT NULL DEFAULT 'application/json',
            response_body TEXT NOT NULL DEFAULT '{"ok":true}',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bin_id TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            query_string TEXT NOT NULL,
            headers TEXT NOT NULL,
            content_type TEXT,
            body BLOB,
            body_size INTEGER NOT NULL,
            ip TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_requests_bin ON requests (bin_id, id);
        CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);
    `);
    return db;
}

module.exports = { openDatabase };
