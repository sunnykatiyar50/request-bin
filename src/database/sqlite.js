const { DatabaseSync } = require('node:sqlite');
const { logToFile } = require('../utils/logger');

// Uses Node's built-in SQLite driver, so there is no native module to compile and the same
// node_modules works on Windows, WSL/Linux and in Docker.
//
// SQLite stores timestamps as ISO-8601 text, which sorts and compares correctly as strings.
// node:sqlite rejects undefined and booleans, so they become NULL and 0/1.
const toParam = value => {
    if (value instanceof Date) return value.toISOString();
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
};

async function connect() {
    logToFile('Initializing SQLite database connection...');
    const db = new DatabaseSync(process.env.SQLITE_PATH || './request-bin.sqlite');

    db.exec(`
        CREATE TABLE IF NOT EXISTS bins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            secret_hash TEXT,
            secret_encrypted TEXT,
            redact_headers INTEGER NOT NULL DEFAULT 1,
            response_status INTEGER NOT NULL DEFAULT 200,
            response_content_type TEXT NOT NULL DEFAULT 'application/json',
            response_body TEXT NOT NULL DEFAULT '{"ok":true}',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bin_id TEXT NOT NULL,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            query_string TEXT NOT NULL,
            headers TEXT NOT NULL,
            content_type TEXT,
            body BLOB,
            body_text TEXT,
            body_size INTEGER NOT NULL,
            ip TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_requests_bin ON requests (bin_id, id);
        CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);

        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            key_prefix TEXT NOT NULL,
            key_encrypted TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'dashboard',
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            revoked_at TEXT
        );
    `);

    const run = (sql, params) => db.prepare(sql).run(...params.map(toParam));

    return {
        dialect: 'sqlite',
        all: async (sql, params = []) => db.prepare(sql).all(...params.map(toParam)),
        run: async (sql, params = []) => Number(run(sql, params).changes),
        insert: async (sql, params = []) => Number(run(sql, params).lastInsertRowid),
        close: async () => db.close(),
    };
}

module.exports = connect;
