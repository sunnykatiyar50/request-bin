const express = require('express');
const { validateRequestQuery, validateIdParam, validateIdList, isBinId } = require('../middleware/validate');
const { subscribe } = require('../events');

// /api/requests: reading needs a Read key, a viewer or an admin; deleting needs an admin
function createRequestRoutes({ requestModel, auth }) {
    const router = express.Router();

    router.get('/', auth.requireRead, validateRequestQuery, async (req, res) => {
        const { page, pageSize, filters } = req.listQuery;
        const { total, requests } = await requestModel.list({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
        res.json({ requests, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    });

    // The newest matching request in full (e.g. the webhook a test just triggered), or 404
    router.get('/latest', auth.requireRead, validateRequestQuery, async (req, res) => {
        const request = await requestModel.latest(req.listQuery.filters);
        if (!request) return res.status(404).json({ error: 'No matching request found' });
        res.json(request);
    });

    router.get('/:id', auth.requireRead, validateIdParam, async (req, res) => {
        const request = await requestModel.get(req.validated.ids[0]);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        res.json(request);
    });

    router.delete('/', auth.requireAdmin, validateIdList, async (req, res) => {
        res.json({ deleted: await requestModel.deleteMany(req.validated.ids) });
    });

    router.delete('/:id', auth.requireAdmin, validateIdParam, async (req, res) => {
        const deleted = await requestModel.deleteMany(req.validated.ids);
        if (!deleted) return res.status(404).json({ error: 'Request not found' });
        res.json({ deleted });
    });

    return router;
}

// /api/stream: server-sent events, one "request" event per newly captured request (?bin= to filter)
function createStreamRoute({ auth }) {
    const router = express.Router();
    router.get('/', auth.requireRead, (req, res) => {
        const binId = typeof req.query.bin === 'string' && isBinId(req.query.bin) ? req.query.bin : null;
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write('retry: 3000\n\n');

        const unsubscribe = subscribe(summary => {
            if (binId && summary.binId !== binId) return;
            res.write(`event: request\ndata: ${JSON.stringify(summary)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });
    return router;
}

module.exports = { createRequestRoutes, createStreamRoute };
