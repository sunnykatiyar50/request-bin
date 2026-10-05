const express = require('express');
const { subscribe } = require('../events');

const BIN_ID_RE = /^[0-9a-f]{16}$/;
const CONTENT_TYPES = ['application/json', 'text/plain', 'application/xml', 'text/xml'];
const MAX_RESPONSE_BODY = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function badRequest(res, details) {
    return res.status(400).json({ error: 'Validation failed', details });
}

// Validates the optional bin settings in a create/update body; returns { settings } or { errors }
function parseBinSettings(body) {
    const errors = {};
    const settings = {};
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > 100) {
            errors.name = 'must be a non-empty string of at most 100 characters';
        } else settings.name = body.name.trim();
    }
    if (body.redactHeaders !== undefined) {
        if (typeof body.redactHeaders !== 'boolean') errors.redactHeaders = 'must be true or false';
        else settings.redactHeaders = body.redactHeaders;
    }
    if (body.responseStatus !== undefined) {
        if (!Number.isInteger(body.responseStatus) || body.responseStatus < 200 || body.responseStatus > 599) {
            errors.responseStatus = 'must be an integer between 200 and 599';
        } else settings.responseStatus = body.responseStatus;
    }
    if (body.responseContentType !== undefined) {
        if (!CONTENT_TYPES.includes(body.responseContentType)) {
            errors.responseContentType = `must be one of ${CONTENT_TYPES.join(', ')}`;
        } else settings.responseContentType = body.responseContentType;
    }
    if (body.responseBody !== undefined) {
        if (typeof body.responseBody !== 'string' || body.responseBody.length > MAX_RESPONSE_BODY) {
            errors.responseBody = `must be a string of at most ${MAX_RESPONSE_BODY} characters`;
        } else settings.responseBody = body.responseBody;
    }
    return Object.keys(errors).length ? { errors } : { settings };
}

function parseId(value) {
    return /^[1-9][0-9]{0,15}$/.test(String(value)) ? Number(value) : null;
}

function createApiRoutes({ binModel, requestModel, auth }) {
    const router = express.Router();
    router.use(auth.requireAdmin);

    function loadBin(req, res, next) {
        const bin = BIN_ID_RE.test(req.params.binId) ? binModel.get(req.params.binId) : null;
        if (!bin) return res.status(404).json({ error: 'Bin not found' });
        req.bin = bin;
        next();
    }

    // --- Bins ---

    router.get('/bins', (req, res) => res.json({ bins: binModel.list() }));

    router.post('/bins', (req, res) => {
        const body = req.body || {};
        const { settings, errors } = parseBinSettings(body);
        if (errors) return badRequest(res, errors);
        if (body.withSecret !== undefined && typeof body.withSecret !== 'boolean') {
            return badRequest(res, { withSecret: 'must be true or false' });
        }
        const { bin, secret } = binModel.create({ ...settings, withSecret: body.withSecret === true });
        res.status(201).json({ bin, ...(secret && { secret }) });
    });

    router.get('/bins/:binId', loadBin, (req, res) => res.json(req.bin));

    router.patch('/bins/:binId', loadBin, (req, res) => {
        const { settings, errors } = parseBinSettings(req.body || {});
        if (errors) return badRequest(res, errors);
        res.json(binModel.update(req.bin.id, settings));
    });

    router.delete('/bins/:binId', loadBin, (req, res) => {
        binModel.delete(req.bin.id);
        res.json({ success: true });
    });

    // --- Captured requests ---

    router.get('/bins/:binId/requests', loadBin, (req, res) => {
        const q = req.query;
        const page = q.page ? parseInt(q.page, 10) : 1;
        const pageSize = q.pageSize ? parseInt(q.pageSize, 10) : 50;
        const method = typeof q.method === 'string' ? q.method.toUpperCase() : '';
        const errors = {};
        if (!Number.isInteger(page) || page < 1) errors.page = 'must be a positive integer';
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
            errors.pageSize = `must be between 1 and ${MAX_PAGE_SIZE}`;
        }
        if (method && !METHODS.includes(method)) errors.method = `must be one of ${METHODS.join(', ')}`;
        if (Object.keys(errors).length) return badRequest(res, errors);

        const search = typeof q.search === 'string' ? q.search.trim().slice(0, 200) : '';
        const { total, requests } = requestModel.list(req.bin.id, {
            method,
            search,
            limit: pageSize,
            offset: (page - 1) * pageSize,
        });
        res.json({ requests, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    });

    router.delete('/bins/:binId/requests', loadBin, (req, res) => {
        res.json({ deleted: requestModel.clear(req.bin.id) });
    });

    // Server-sent events: one "request" event per newly captured request
    router.get('/bins/:binId/stream', loadBin, (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write('retry: 3000\n\n');

        const unsubscribe = subscribe(req.bin.id, summary => {
            res.write(`event: request\ndata: ${JSON.stringify(summary)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    router.get('/requests/:id', (req, res) => {
        const id = parseId(req.params.id);
        const request = id && requestModel.get(id);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        res.json(request);
    });

    router.delete('/requests/:id', (req, res) => {
        const id = parseId(req.params.id);
        if (!id || !requestModel.delete(id)) return res.status(404).json({ error: 'Request not found' });
        res.json({ success: true });
    });

    router.use((req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}

module.exports = createApiRoutes;
