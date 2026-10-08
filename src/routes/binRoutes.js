const express = require('express');
const { isBinId, parseBinSettings, badRequest } = require('../middleware/validate');
const { logToFile } = require('../utils/logger');

// /api/bins: anyone who can read (admin, viewer, Read key) can list bins; only admins change them
function createBinRoutes({ binModel, requestModel, auth }) {
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

    router.get('/', auth.requireRead, async (req, res) => {
        res.json({ bins: await binModel.list() });
    });

    router.get('/:id', auth.requireRead, loadBin, (req, res) => res.json(req.bin));

    router.post('/', auth.requireAdmin, noStore, async (req, res) => {
        const body = req.body || {};
        const { settings, errors } = parseBinSettings(body);
        if (errors) return badRequest(res, errors);
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
