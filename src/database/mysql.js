const mysql = require('mysql2/promise');
const { logToFile } = require('../utils/logger');
const { sslOptions } = require('./ssl');

async function connect() {
    logToFile('Initializing MySQL database connection...');
    const pool = mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        timezone: 'Z', // store and read DATETIME values as UTC
        ssl: sslOptions(process.env.MYSQL_SSL, process.env.MYSQL_SSL_CA),
    });

    // TEXT/BLOB columns have no defaults (older MySQL versions don't allow them); the models
    // always provide every value. MEDIUMBLOB / MEDIUMTEXT hold up to 16 MB (see MAX_BODY_KB).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bins (
            id VARCHAR(16) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            secret_hash CHAR(64),
            secret_encrypted TEXT,
            redact_headers TINYINT(1) NOT NULL DEFAULT 1,
            response_status INT NOT NULL DEFAULT 200,
            response_content_type VARCHAR(64) NOT NULL DEFAULT 'application/json',
            response_body TEXT NOT NULL,
            created_at DATETIME(3) NOT NULL
        ) DEFAULT CHARSET = utf8mb4
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            bin_id VARCHAR(16) NOT NULL,
            method VARCHAR(16) NOT NULL,
            path TEXT NOT NULL,
            query_string TEXT NOT NULL,
            headers MEDIUMTEXT NOT NULL,
            content_type VARCHAR(255),
            body MEDIUMBLOB,
            body_text MEDIUMTEXT,
            body_size INT NOT NULL,
            ip VARCHAR(64),
            created_at DATETIME(3) NOT NULL,
            INDEX idx_requests_bin (bin_id, id),
            INDEX idx_requests_created (created_at)
        ) DEFAULT CHARSET = utf8mb4
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(64) NOT NULL UNIQUE,
            scope VARCHAR(16) NOT NULL,
            key_hash CHAR(64) NOT NULL UNIQUE,
            key_prefix VARCHAR(32) NOT NULL,
            key_encrypted TEXT NOT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'dashboard',
            created_at DATETIME(3) NOT NULL,
            last_used_at DATETIME(3),
            revoked_at DATETIME(3)
        ) DEFAULT CHARSET = utf8mb4
    `);

    return {
        dialect: 'mysql',
        all: async (sql, params = []) => (await pool.query(sql, params))[0],
        run: async (sql, params = []) => (await pool.query(sql, params))[0].affectedRows,
        insert: async (sql, params = []) => (await pool.query(sql, params))[0].insertId,
        close: () => pool.end(),
    };
}

module.exports = connect;
