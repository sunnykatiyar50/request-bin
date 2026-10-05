const { createSessionToken, verifySessionToken, safeEqual, parseCookies } = require('../utils/session');
const { log } = require('../utils/logger');

const SESSION_COOKIE = 'rb_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createAuth(config) {
    const ttlMs = config.sessionTtlHours * 60 * 60 * 1000;

    // Returns how the request is authenticated as admin: 'disabled', 'bearer', 'cookie' or null
    function adminAuthMethod(req) {
        if (config.authDisabled) return 'disabled';
        const header = req.get('authorization') || '';
        if (config.adminToken && header.startsWith('Bearer ') && safeEqual(header.slice(7), config.adminToken)) {
            return 'bearer';
        }
        const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
        if (token && verifySessionToken(token, config.sessionSecret)) return 'cookie';
        return null;
    }

    // Cookie-authenticated writes must carry a custom header. Browsers cannot add it to a
    // cross-site request without a CORS preflight (which the API never approves), so this blocks CSRF.
    function requireAdmin(req, res, next) {
        const method = adminAuthMethod(req);
        if (!method) return res.status(401).json({ error: 'Authentication required' });
        if (method === 'cookie' && !SAFE_METHODS.has(req.method) && req.get('x-requested-with') !== 'fetch') {
            return res.status(403).json({ error: 'Missing X-Requested-With header' });
        }
        next();
    }

    function cookieOptions(req) {
        return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' };
    }

    function login(req, res) {
        if (config.authDisabled) return res.json({ success: true });
        const password = req.body && req.body.password;
        if (typeof password !== 'string' || !safeEqual(password, config.adminPassword)) {
            log(`Failed dashboard login from ${req.ip}`);
            return res.status(401).json({ error: 'Invalid password' });
        }
        res.cookie(SESSION_COOKIE, createSessionToken(config.sessionSecret, ttlMs), {
            ...cookieOptions(req),
            maxAge: ttlMs,
        });
        log(`Dashboard login from ${req.ip}`);
        res.json({ success: true });
    }

    function logout(req, res) {
        res.clearCookie(SESSION_COOKIE, cookieOptions(req));
        res.json({ success: true });
    }

    return { adminAuthMethod, requireAdmin, login, logout };
}

module.exports = { createAuth, SESSION_COOKIE };
