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
    app.listen(config.port, () => log(`Request Bin is running on http://localhost:${config.port}`));
}

try {
    main();
} catch (error) {
    log(`Startup failed: ${error.stack || error}`);
    process.exit(1);
}
