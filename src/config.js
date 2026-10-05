// Reads and validates configuration from environment variables.
// Throws on invalid auth configuration so the server never starts unprotected by accident.

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env = process.env) {
    const config = {
        port: toInt(env.PORT, 3007),
        databasePath: env.DATABASE_PATH || './request-bin.sqlite',
        authDisabled: env.AUTH_DISABLED === 'true',
        adminPassword: env.ADMIN_PASSWORD || '',
        adminToken: env.ADMIN_TOKEN || '',
        sessionSecret: env.SESSION_SECRET || '',
        sessionTtlHours: toInt(env.SESSION_TTL_HOURS, 12),
        trustProxy: env.TRUST_PROXY || '',
        maxBodyBytes: toInt(env.MAX_BODY_KB, 1024) * 1024,
        maxRequestsPerBin: toInt(env.MAX_REQUESTS_PER_BIN, 500),
        captureRateLimit: toInt(env.CAPTURE_RATE_LIMIT, 300),
        retentionDays: toInt(env.RETENTION_DAYS, 7),
        // Headers whose values are replaced with "[redacted]" before storing (in bins with redaction on)
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
        if ([config.adminPassword, config.sessionSecret, config.adminToken].some(s => s.startsWith('change-me'))) {
            problems.push('replace the change-me placeholder values from sample.env');
        }
        if (problems.length) {
            throw new Error(
                `Invalid auth configuration: ${problems.join('; ')}. ` +
                'Set these in .env (see sample.env), or set AUTH_DISABLED=true for local development only.'
            );
        }
    }

    return config;
}

module.exports = { loadConfig };
