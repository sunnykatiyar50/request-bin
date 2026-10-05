const crypto = require('crypto');

// Stateless session tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)

function sign(data, secret) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createSessionToken(secret, ttlMs) {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
    return `${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(token, secret) {
    if (typeof token !== 'string') return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    if (!safeEqual(signature, sign(payload, secret))) return false;
    try {
        const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return typeof exp === 'number' && exp > Date.now();
    } catch {
        return false;
    }
}

// Constant-time string comparison; hashing first makes the lengths equal
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        try {
            cookies[name] = decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
            // ignore malformed cookie values
        }
    }
    return cookies;
}

module.exports = { createSessionToken, verifySessionToken, safeEqual, parseCookies };
