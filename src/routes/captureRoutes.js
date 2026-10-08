const express = require('express');
const rateLimit = require('express-rate-limit');
const { isBinId } = require('../middleware/validate');
const { publish } = require('../events');

const REDACTED = '[redacted]';

// Captures any request sent to /b/:binId or /b/:binId/<anything> and answers with the bin's
// configured response. Public by design (webhook senders can't log in); a bin can require a secret.
function createCaptureRoutes({ binModel, requestModel, config }) {
    const router = express.Router();

    const limiter = rateLimit({
        windowMs: 60 * 1000,
        limit: config.captureRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests' },
    });

    // Looks up the bin and checks its secret before the body is read, so unauthorised callers
    // can't make the server buffer large uploads
    async function loadBin(req, res, next) {
        const bin = isBinId(req.params.binId) ? await binModel.getForCapture(req.params.binId) : null;
        if (!bin) return res.status(404).json({ error: 'Bin not found' });

        const url = new URL(req.originalUrl, 'http://placeholder');
        if (bin.secret_hash) {
            // Header for senders that can set one, ?secret= for those that can't
            const presented = req.get('x-bin-secret') || url.searchParams.get('secret') || '';
            if (!binModel.checkSecret(bin, presented)) return res.status(401).json({ error: 'Invalid bin secret' });
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

    async function capture(req, res) {
        const { bin } = req;
        const headers = { ...req.headers };
        if (Number(bin.redact_headers)) {
            for (const name of config.redactHeaders) if (name in headers) headers[name] = REDACTED;
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

        const summary = await requestModel.insert(bin.id, {
            method: req.method,
            path: req.capturedUrl.path,
            queryString: req.capturedUrl.queryString,
            headers,
            contentType: req.get('content-type'),
            body,
            ip: req.ip,
        });
        publish(summary);

        // The bin's response is served from this origin, so lock it down: no scripts, no sniffing
        res.set({
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': bin.response_content_type,
        });
        res.status(Number(bin.response_status)).send(bin.response_body);
    }

    router.all(['/:binId', '/:binId/*rest'], limiter, loadBin, rawBody, capture);
    return router;
}

module.exports = createCaptureRoutes;
