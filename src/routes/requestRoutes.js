const express = require('express');
const { validateRequestQuery, validateExportQuery, validateIdParam, validateIdList, isBinId } = require('../middleware/validate');
const { subscribe } = require('../events');
const { toHar } = require('../utils/har');

const EXPORT_LIMIT = 1000;

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

    // Download matching (or the listed) requests as HAR or JSON: the newest EXPORT_LIMIT, oldest first
    router.get('/export', auth.requireRead, validateRequestQuery, validateExportQuery, async (req, res) => {
        const { truncated, requests } = await requestModel.export(req.listQuery.filters, EXPORT_LIMIT);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'); // 20261009-142233
        const binPart = req.listQuery.filters.binId ? `-${req.listQuery.filters.binId}` : '';
        res.set({
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="request-bin${binPart}-${stamp}.${req.exportFormat}"`,
            ...(truncated && { 'X-Export-Truncated': 'true' }),
        });
        if (req.exportFormat === 'json') {
            return res.json({ exportedAt: new Date().toISOString(), count: requests.length, truncated, requests });
        }
        res.json(toHar(requests, { baseUrl: `${req.protocol}://${req.get('host')}`, truncated }));
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
