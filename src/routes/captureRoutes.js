const express = require('express');
const rateLimit = require('express-rate-limit');
const { isBinId } = require('../middleware/validate');
const { publish } = require('../events');
const { renderTemplate } = require('../utils/template');
const { pickResponse } = require('../utils/rules');
const { bodyAsText } = require('../models/requestModel');
const { parseBearer } = require('../utils/session');

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
        // Headers that carried the bin secret, redacted before storing even in bins with redaction off
        req.secretHeaders = [];
        if (bin.secret_hash) {
            // X-Bin-Secret or Authorization: Bearer for senders that can set a header, ?secret= for
            // those that can't. Any one of them will do: a sender may use Authorization for its own
            // token and send the secret in X-Bin-Secret.
            const presented = [
                ['x-bin-secret', req.get('x-bin-secret')],
                ['authorization', parseBearer(req.get('authorization'))],
                [null, url.searchParams.get('secret')],
            ];
            const match = presented.find(([, value]) => value && binModel.checkSecret(bin, value));
            if (!match) return res.status(401).json({ error: 'Invalid bin secret' });
            if (match[0]) req.secretHeaders.push(match[0]);
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
        for (const name of req.secretHeaders) headers[name] = REDACTED;
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

        // The response comes from the first matching rule, else from the bin itself
        const requestInfo = {
            id: summary.id,
            binId: bin.id,
            method: req.method,
            path: req.capturedUrl.path,
            queryString: req.capturedUrl.queryString,
            headers,
            contentType: req.get('content-type'),
            bodyText: bodyAsText(body),
            ip: req.ip,
        };
        const response = pickResponse(bin, requestInfo);
        const responseBody = response.template
            ? renderTemplate(response.body, requestInfo, response.contentType)
            : response.body;

        // Simulates a slow endpoint. The request is already stored, so it shows up in the dashboard
        // straight away; a sender that gives up early just closes the connection.
        if (response.delayMs > 0) {
            await new Promise(resolve => {
                const timer = setTimeout(resolve, response.delayMs);
                res.on('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            if (res.destroyed) return;
        }

        // The bin's response is served from this origin, so lock it down: no scripts, no sniffing
        res.set({
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': response.contentType,
        });
        res.status(response.status).send(responseBody);
    }

    router.all(['/:binId', '/:binId/*rest'], limiter, loadBin, rawBody, capture);
    return router;
}

module.exports = createCaptureRoutes;
