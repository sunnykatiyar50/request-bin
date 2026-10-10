// Reads and validates configuration from environment variables.
// Throws on invalid auth configuration so the server never starts unprotected by accident.

// VIEWER_USERS=alice:password1,bob:password2 -> [{ username, password }]
// (passwords can contain ':' but not ',')
function parseUsers(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => {
            const sep = entry.indexOf(':');
            return sep === -1
                ? { username: entry, password: '' }
                : { username: entry.slice(0, sep).trim(), password: entry.slice(sep + 1) };
        });
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const MAX_BODY_KB_LIMIT = 16 * 1024; // the largest body column (MySQL MEDIUMBLOB) holds 16 MB

const { parseAllowedHosts } = require('./utils/outbound');

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env = process.env) {
    const config = {
        port: toInt(env.PORT, 30002),
        authDisabled: env.AUTH_DISABLED === 'true',
        adminToken: env.ADMIN_TOKEN || '',
        adminUsername: (env.ADMIN_USERNAME || 'admin').trim(),
        adminPassword: env.ADMIN_PASSWORD || '',
        // Read-only dashboard accounts: can view captured requests, can't change anything
        viewerUsers: parseUsers(env.VIEWER_USERS),
        sessionSecret: env.SESSION_SECRET || '',
        sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 12),
        trustProxy: env.TRUST_PROXY || '',
        retentionDays: toInt(env.RETENTION_DAYS, 7),
        // Capture
        maxBodyBytes: Math.min(toInt(env.MAX_BODY_KB, 1024), MAX_BODY_KB_LIMIT) * 1024,
        maxRequestsPerBin: toInt(env.MAX_REQUESTS_PER_BIN, 500),
        captureRateLimit: toInt(env.CAPTURE_RATE_LIMIT, 300),
        // Forwarding and replaying captured requests: only to these hosts (empty = switched off)
        forwardAllowedHosts: parseAllowedHosts(env.FORWARD_ALLOWED_HOSTS),
        forwardTimeoutMs: Math.min(Math.max(toInt(env.FORWARD_TIMEOUT_MS, 10000), 1000), 60000),
        // Header values replaced with "[redacted]" before storing, in bins with redaction on
        redactHeaders: (env.REDACT_HEADERS || 'authorization,proxy-authorization,cookie,x-api-key,x-bin-secret')
            .split(',')
            .map(h => h.trim().toLowerCase())
            .filter(Boolean),
    };

    if (!config.authDisabled) {
        const problems = [];
        if (!config.adminPassword) problems.push('ADMIN_PASSWORD is not set');
        if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
        if (config.adminToken && config.adminToken.length < 16) problems.push('ADMIN_TOKEN must be at least 16 characters');
        const seen = new Set([config.adminUsername.toLowerCase()]);
        for (const { username, password } of config.viewerUsers) {
            if (!USERNAME_RE.test(username)) {
                problems.push(`VIEWER_USERS: "${username}" is not a valid username (letters, digits, . _ @ -)`);
            } else if (seen.has(username.toLowerCase())) {
                problems.push(`VIEWER_USERS: "${username}" is used twice, or is the admin username`);
            }
            seen.add(username.toLowerCase());
            if (password.length < 8) problems.push(`VIEWER_USERS: the password for "${username}" must be at least 8 characters`);
        }
        const secrets = [config.adminPassword, config.sessionSecret, config.adminToken, ...config.viewerUsers.map(u => u.password)];
        if (secrets.some(s => s.startsWith('change-me'))) problems.push('replace the change-me placeholder values from sample.env');
        if (problems.length) {
            throw new Error(
                `Invalid auth configuration: ${problems.join('; ')}. ` +
                'Set these in .env (see sample.env), or set AUTH_DISABLED=true for local development only.'
            );
        }
    }

    return config;
}

module.exports = { loadConfig, parseUsers };
