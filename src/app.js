require('dotenv').config({ quiet: true });

const { loadConfig } = require('./config');
const initializeDatabase = require('./database/initDatabase');
const BinModel = require('./models/binModel');
const RequestModel = require('./models/requestModel');
const ApiKeyModel = require('./models/apiKeyModel');
const { createApp } = require('./server');
const { logToFile } = require('./utils/logger');

const HOUR_MS = 60 * 60 * 1000;

function scheduleRetention(requestModel, retentionDays) {
    if (!retentionDays) return;
    const purge = async () => {
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * HOUR_MS);
            const deleted = await requestModel.deleteOlderThan(cutoff);
            if (deleted) logToFile(`Retention: deleted ${deleted} request(s) older than ${retentionDays} day(s)`);
        } catch (error) {
            logToFile(`Retention cleanup failed: ${error.message}`);
        }
    };
    purge();
    setInterval(purge, HOUR_MS).unref();
}

async function main() {
    const config = loadConfig();
    if (config.authDisabled) {
        logToFile('WARNING: AUTH_DISABLED=true - the API and dashboard are open to anyone who can reach this server');
    }

    const db = await initializeDatabase();
    // API keys and bin secrets are encrypted with a key derived from SESSION_SECRET
    const binModel = new BinModel(db, { encryptionSecret: config.sessionSecret });
    const requestModel = new RequestModel(db, { maxRequestsPerBin: config.maxRequestsPerBin });
    const apiKeyModel = new ApiKeyModel(db, { encryptionSecret: config.sessionSecret });
    scheduleRetention(requestModel, config.retentionDays);

    const app = createApp({ config, binModel, requestModel, apiKeyModel });
    const server = app.listen(config.port, () => {
        logToFile(`Server is running on http://localhost:${config.port}`);
    });
    handleShutdown(server, db);
}

// Stop accepting connections, let in-flight requests finish, then close the database.
// Without this, `docker stop` waits its full timeout and then kills the process.
function handleShutdown(server, db) {
    let shuttingDown = false;
    const shutdown = signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        logToFile(`${signal} received, shutting down`);
        setTimeout(() => {
            logToFile('Shutdown timed out, exiting');
            process.exit(1);
        }, 8000).unref();
        server.close(async () => {
            try {
                await db.close();
            } catch (error) {
                logToFile(`Error closing database: ${error.message}`);
            }
            process.exit(0);
        });
        server.closeIdleConnections();
        // Live-update (SSE) connections never finish on their own; give normal requests a moment, then drop them
        setTimeout(() => server.closeAllConnections(), 2000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
    logToFile(`Startup failed: ${error.stack || error}`);
    process.exit(1);
});
