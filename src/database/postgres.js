const { Pool } = require('pg');
const { logToFile } = require('../utils/logger');
const { sslOptions } = require('./ssl');

// The models write SQL with "?" placeholders; Postgres expects $1, $2, ...
function toPgPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}

async function connect() {
    logToFile('Initializing PostgreSQL database connection...');
    const pool = new Pool({
        host: process.env.PG_HOST,
        port: process.env.PG_PORT,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
        ssl: sslOptions(process.env.PG_SSL, process.env.PG_SSL_CA),
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bins (
            id VARCHAR(16) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            secret_hash CHAR(64),
            secret_encrypted TEXT,
            redact_headers BOOLEAN NOT NULL DEFAULT TRUE,
            response_status INTEGER NOT NULL DEFAULT 200,
            response_content_type VARCHAR(64) NOT NULL DEFAULT 'application/json',
            response_body TEXT NOT NULL DEFAULT '{"ok":true}',
            response_template BOOLEAN NOT NULL DEFAULT FALSE,
            response_delay_ms INTEGER NOT NULL DEFAULT 0,
            response_rules TEXT,
            created_at TIMESTAMPTZ NOT NULL
        )
    `);
    // Columns added after the first release, for databases created before them
    await pool.query('ALTER TABLE bins ADD COLUMN IF NOT EXISTS response_template BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE bins ADD COLUMN IF NOT EXISTS response_delay_ms INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE bins ADD COLUMN IF NOT EXISTS response_rules TEXT');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS requests (
            id SERIAL PRIMARY KEY,
            bin_id VARCHAR(16) NOT NULL,
            method VARCHAR(16) NOT NULL,
            path TEXT NOT NULL,
            query_string TEXT NOT NULL,
            headers TEXT NOT NULL,
            content_type VARCHAR(255),
            body BYTEA,
            body_text TEXT,
            body_size INTEGER NOT NULL,
            ip VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_requests_bin ON requests (bin_id, id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id SERIAL PRIMARY KEY,
            name VARCHAR(64) NOT NULL UNIQUE,
            scope VARCHAR(16) NOT NULL,
            key_hash CHAR(64) NOT NULL UNIQUE,
            key_prefix VARCHAR(32) NOT NULL,
            key_encrypted TEXT NOT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'dashboard',
            created_at TIMESTAMPTZ NOT NULL,
            last_used_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ
        )
    `);

    return {
        dialect: 'postgres',
        all: async (sql, params = []) => (await pool.query(toPgPlaceholders(sql), params)).rows,
        run: async (sql, params = []) => (await pool.query(toPgPlaceholders(sql), params)).rowCount,
        insert: async (sql, params = []) =>
            (await pool.query(`${toPgPlaceholders(sql)} RETURNING id`, params)).rows[0].id,
        close: () => pool.end(),
    };
}

module.exports = connect;
