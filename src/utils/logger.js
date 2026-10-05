const fs = require('fs');
const path = require('path');

const logDir = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const logFile = path.join(logDir, 'app.log');
const logToConsole = process.env.NODE_ENV !== 'test';

fs.mkdirSync(logDir, { recursive: true });

// Rotate daily: move the previous day's log to logs/app-YYYY-MM-DD.log
function rotateIfNeeded() {
    if (!fs.existsSync(logFile)) return;
    const lastDate = fs.statSync(logFile).mtime.toISOString().slice(0, 10);
    if (lastDate !== new Date().toISOString().slice(0, 10)) {
        fs.renameSync(logFile, path.join(logDir, `app-${lastDate}.log`));
    }
}

// Newlines are escaped so a value cannot forge extra log entries
function log(message) {
    const line = `[${new Date().toISOString()}] ${String(message).replace(/[\r\n]+/g, '\\n')}`;
    if (logToConsole) console.log(line);
    try {
        rotateIfNeeded();
        fs.appendFileSync(logFile, `${line}\n`);
    } catch (error) {
        console.error('Failed to write log file:', error.message);
    }
}

module.exports = { log };
