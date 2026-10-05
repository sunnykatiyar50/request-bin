require('dotenv').config({ quiet: true });

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const BinModel = require('./models/binModel');
const RequestModel = require('./models/requestModel');
const { createApp } = require('./server');
const { log } = require('./utils/logger');

const HOUR_MS = 60 * 60 * 1000;

function scheduleRetention(requestModel, retentionDays) {
    if (!retentionDays) return;
    const purge = () => {
        try {
            const deleted = requestModel.deleteOlderThan(new Date(Date.now() - retentionDays * 24 * HOUR_MS));
            if (deleted) log(`Retention: deleted ${deleted} request(s) older than ${retentionDays} day(s)`);
        } catch (error) {
            log(`Retention cleanup failed: ${error.message}`);
        }
    };
    purge();
    setInterval(purge, HOUR_MS).unref();
}

function main() {
    const config = loadConfig();
    if (config.authDisabled) {
        log('WARNING: AUTH_DISABLED=true - the dashboard and API are open to anyone who can reach this server');
    }

    const db = openDatabase(config.databasePath);
    const binModel = new BinModel(db);
    const requestModel = new RequestModel(db, config);
    scheduleRetention(requestModel, config.retentionDays);

    const app = createApp({ config, binModel, requestModel });
    const server = app.listen(config.port, () => log(`Request Bin is running on http://localhost:${config.port}`));
    handleShutdown(server, db);
}

// Stop accepting connections, let in-flight requests finish, then close the database.
// Without this, `docker stop` waits its full timeout and then kills the process.
function handleShutdown(server, db) {
    let shuttingDown = false;
    const shutdown = signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`${signal} received, shutting down`);
        setTimeout(() => {
            log('Shutdown timed out, exiting');
            process.exit(1);
        }, 8000).unref();
        server.close(() => {
            try {
                db.close();
            } catch (error) {
                log(`Error closing database: ${error.message}`);
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

try {
    main();
} catch (error) {
    log(`Startup failed: ${error.stack || error}`);
    process.exit(1);
}
