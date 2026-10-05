const express = require('express');
const rateLimit = require('express-rate-limit');
const { safeEqual } = require('../utils/session');
const { publish } = require('../events');

const BIN_ID_RE = /^[0-9a-f]{16}$/;
const REDACTED = '[redacted]';

// Captures any request sent to /b/:binId or /b/:binId/<anything> and answers with the bin's configured response
function createCaptureRoutes({ binModel, requestModel, config }) {
    const router = express.Router();

    const limiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.captureRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests' },
    });

    function loadBin(req, res, next) {
        const bin = BIN_ID_RE.test(req.params.binId) ? binModel.getForCapture(req.params.binId) : null;
        if (!bin) return res.status(404).json({ error: 'Bin not found' });

        const url = new URL(req.originalUrl, 'http://placeholder');
        if (bin.secret) {
            const provided = req.get('x-bin-secret') || url.searchParams.get('secret') || '';
            if (!safeEqual(provided, bin.secret)) return res.status(401).json({ error: 'Invalid bin secret' });
        }
        if (url.searchParams.has('secret')) url.searchParams.set('secret', REDACTED);

        req.bin = bin;
        req.capturedUrl = {
            path: url.pathname.slice(`/b/${bin.id}`.length) || '/',
            queryString: url.searchParams.toString(),
        };
        next();
    }

    // Reads any content type as raw bytes so the body is stored exactly as sent
    const rawBody = express.raw({ type: () => true, limit: config.maxBodyBytes });

    function capture(req, res) {
        const { bin } = req;
        const headers = { ...req.headers };
        if (bin.redact_headers) {
            for (const name of config.redactHeaders) if (name in headers) headers[name] = REDACTED;
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

        const saved = requestModel.insert(bin.id, {
            method: req.method,
            path: req.capturedUrl.path,
            queryString: req.capturedUrl.queryString,
            headers,
            contentType: req.get('content-type'),
            body,
            ip: req.ip,
        });
        const { headers: _h, body: _b, bodyEncoding: _e, query: _q, ...summary } = saved;
        publish(bin.id, summary);

        // The bin's response is served from this origin, so lock it down: no scripts, no sniffing
        res.set({
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': bin.response_content_type,
        });
        res.status(bin.response_status).send(bin.response_body);
    }

    router.all(['/:binId', '/:binId/*rest'], limiter, loadBin, rawBody, capture);
    return router;
}

module.exports = createCaptureRoutes;
