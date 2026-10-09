// Test database setup, shared by the test files that need one. Require it before anything from src/.
//
// SQLite by default: a fresh temporary file per test file. To run against a server instead, set
// TEST_DB_TYPE=postgres or mysql plus the usual PG_* / MYSQL_* variables. Its tables are emptied
// first, so the database name must contain "test", and test files must run one at a time:
//
//   TEST_DB_TYPE=postgres PG_HOST=localhost PG_USER=... PG_PASSWORD=... PG_DATABASE=requestbin_test \
//     npm run test:serial
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbType = (process.env.TEST_DB_TYPE || 'sqlite').toLowerCase();

function setupTestEnv(name) {
    process.env.NODE_ENV = 'test';
    process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `rb-${name}-logs-`));
    process.env.DB_TYPE = dbType;
    if (dbType === 'sqlite') {
        process.env.SQLITE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `rb-${name}-db-`)), 'test.sqlite');
    } else {
        const database = dbType === 'postgres' ? process.env.PG_DATABASE : process.env.MYSQL_DATABASE;
        if (!/test/i.test(database || '')) {
            throw new Error(`TEST_DB_TYPE=${dbType}: the database name ("${database || ''}") must contain "test", because the tests empty its tables`);
        }
    }
}

// Connects (creating or upgrading the tables) and starts from empty tables
async function openTestDatabase() {
    const initializeDatabase = require('../../src/database/initDatabase');
    const db = await initializeDatabase();
    for (const table of ['requests', 'bins', 'api_keys']) await db.run(`DELETE FROM ${table}`);
    return db;
}

module.exports = { dbType, setupTestEnv, openTestDatabase };
