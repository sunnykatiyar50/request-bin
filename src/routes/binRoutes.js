const express = require('express');
const { isBinId, parseBinSettings, badRequest } = require('../middleware/validate');
const { logToFile } = require('../utils/logger');

// /api/bins: anyone who can read (admin, viewer, Read key) can list bins; only admins change them
function createBinRoutes({ binModel, requestModel, auth, outbound }) {
    const router = express.Router();

    async function loadBin(req, res, next) {
        const bin = isBinId(req.params.id) ? await binModel.get(req.params.id) : null;
        if (!bin) return res.status(404).json({ error: 'Bin not found' });
        req.bin = bin;
        next();
    }

    const noStore = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    };

    // The forward URL can carry a token, so only admins see it; others learn only that forwarding is set up
    const forAudience = (bin, req) => (req.auth && req.auth.isAdmin
        ? bin
        : { ...bin, forwardConfig: { ...bin.forwardConfig, url: bin.forwardConfig.url ? '[hidden]' : '' } });

    // Forwarding to a target the server doesn't allow is refused when it is switched on
    const forwardProblem = settings => {
        const config = settings.forwardConfig;
        if (!config || !config.enabled) return null;
        const check = outbound.checkUrl(config.url);
        return check.ok ? null : { 'forwardConfig.url': check.reason };
    };

    router.get('/', auth.requireRead, async (req, res) => {
        res.json({ bins: (await binModel.list()).map(bin => forAudience(bin, req)) });
    });

    router.get('/:id', auth.requireRead, loadBin, (req, res) => res.json(forAudience(req.bin, req)));

    router.post('/', auth.requireAdmin, noStore, async (req, res) => {
        const body = req.body || {};
        const { settings, errors } = parseBinSettings(body);
        if (errors) return badRequest(res, errors);
        const forwardErrors = forwardProblem(settings);
        if (forwardErrors) return badRequest(res, forwardErrors);
        if (body.withSecret !== undefined && typeof body.withSecret !== 'boolean') {
            return badRequest(res, { withSecret: 'must be true or false' });
        }
        const { bin, secret } = await binModel.create({ ...settings, withSecret: body.withSecret === true });
        logToFile(`Bin created: "${bin.name}" (${bin.id}) from ${req.ip}`);
        res.status(201).json({ bin, ...(secret && { secret }) });
    });

    router.patch('/:id', auth.requireAdmin, loadBin, async (req, res) => {
        const { settings, errors } = parseBinSettings(req.body || {});
        if (errors) return badRequest(res, errors);
        const forwardErrors = forwardProblem(settings);
        if (forwardErrors) return badRequest(res, forwardErrors);
        res.json(await binModel.update(req.bin.id, settings));
    });

    router.delete('/:id', auth.requireAdmin, loadBin, async (req, res) => {
        await binModel.delete(req.bin.id);
        logToFile(`Bin deleted: "${req.bin.name}" (${req.bin.id}) from ${req.ip}`);
        res.json({ success: true });
    });

    // Secret: set a new one (rotate), remove it, or show the current one again
    router.post('/:id/secret', auth.requireAdmin, noStore, loadBin, async (req, res) => {
        const secret = await binModel.setSecret(req.bin.id, true);
        logToFile(`Bin secret set: "${req.bin.name}" from ${req.ip}`);
        res.json({ secret });
    });

    router.delete('/:id/secret', auth.requireAdmin, loadBin, async (req, res) => {
        await binModel.setSecret(req.bin.id, false);
        logToFile(`Bin secret removed: "${req.bin.name}" from ${req.ip}`);
        res.json({ success: true });
    });

    router.post('/:id/secret/reveal', auth.requireAdmin, noStore, loadBin, async (req, res) => {
        const found = await binModel.revealSecret(req.bin.id);
        if (!found) return res.status(404).json({ error: 'This bin has no secret' });
        if (!found.secret) {
            return res.status(409).json({
                error: 'The secret can no longer be shown because SESSION_SECRET has changed. It still works; set a new one if you need to copy it.',
            });
        }
        logToFile(`Bin secret revealed: "${req.bin.name}" from ${req.ip}`);
        res.json({ secret: found.secret });
    });

    // Delete everything captured in the bin
    router.delete('/:id/requests', auth.requireAdmin, loadBin, async (req, res) => {
        res.json({ deleted: await requestModel.clear(req.bin.id) });
    });

    return router;
}

module.exports = createBinRoutes;
