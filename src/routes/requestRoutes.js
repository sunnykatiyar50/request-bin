const express = require('express');
const { validateRequestQuery, validateExportQuery, validateIdParam, validateIdList, isBinId, badRequest, METHODS } = require('../middleware/validate');
const { subscribe } = require('../events');
const { toHar } = require('../utils/har');
const { forwardHeaders } = require('../utils/outbound');
const { logToFile } = require('../utils/logger');
const { describeTarget } = require('../utils/forward');

const EXPORT_LIMIT = 1000;

// /api/requests: reading needs a Read key, a viewer or an admin; deleting needs an admin
function createRequestRoutes({ requestModel, auth, outbound }) {
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

    // Sends a captured request again, to a target on the server's allowlist (FORWARD_ALLOWED_HOSTS).
    // Body: { url, method? } (the method defaults to the original). Answers with what the target replied.
    router.post('/:id/replay', auth.requireAdmin, validateIdParam, async (req, res) => {
        if (!outbound.enabled) {
            return res.status(400).json({ error: 'Replay is switched off. Set FORWARD_ALLOWED_HOSTS to the hosts requests may be sent to.' });
        }
        const { url, method } = req.body || {};
        const errors = {};
        if (typeof url !== 'string' || url === '') errors.url = 'must be a URL';
        else {
            const check = outbound.checkUrl(url);
            if (!check.ok) errors.url = check.reason;
        }
        if (method !== undefined && !METHODS.includes(typeof method === 'string' ? method.toUpperCase() : '')) {
            errors.method = `must be one of ${METHODS.join(', ')}`;
        }
        if (Object.keys(errors).length) return badRequest(res, errors);

        const original = await requestModel.getRaw(req.validated.ids[0]);
        if (!original) return res.status(404).json({ error: 'Request not found' });
        const target = describeTarget(url);
        try {
            const response = await outbound.send(url, {
                method: method ? method.toUpperCase() : original.method,
                headers: forwardHeaders(original.headers, { binId: original.binId }),
                body: original.body,
            });
            logToFile(`Request ${req.validated.ids[0]} replayed to ${target} from ${req.ip}: ${response.status}`);
            res.set('Cache-Control', 'no-store').json({
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body.toString('utf8'),
                truncated: response.truncated,
                durationMs: response.durationMs,
            });
        } catch (err) {
            logToFile(`Replaying request ${req.validated.ids[0]} to ${target} from ${req.ip} failed: ${err.message}`);
            res.status(502).json({ error: `Could not reach the target: ${err.message}` });
        }
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
