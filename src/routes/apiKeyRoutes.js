const express = require('express');
const { SCOPES } = require('../utils/apiKeys');
const { logToFile } = require('../utils/logger');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function parseId(value) {
    return /^[1-9][0-9]{0,15}$/.test(String(value)) ? Number(value) : null;
}

// Managing API keys from the dashboard. Admin only (dashboard session or ADMIN_TOKEN); API keys
// themselves can never list, create, reveal or revoke keys.
function createApiKeyRoutes({ apiKeyModel, auth, config }) {
    const router = express.Router();
    router.use(auth.requireAdmin);
    // Responses can contain secrets: never cache them
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.get('/', async (req, res) => {
        res.json({ keys: await apiKeyModel.list(), adminTokenConfigured: Boolean(config.adminToken) });
    });

    router.post('/', async (req, res) => {
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const scope = body.scope === undefined ? 'read' : body.scope; // Read is the only scope
        const errors = {};
        if (!NAME_RE.test(name)) {
            errors.name = 'must be 1-64 characters: letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit';
        } else if (name.toLowerCase() === 'dashboard' || (await apiKeyModel.nameExists(name))) {
            errors.name = 'is already used by another key';
        }
        if (!SCOPES.includes(scope)) errors.scope = `must be one of ${SCOPES.join(', ')}`;
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', details: errors });

        const { key, secret } = await apiKeyModel.create({ name, scope });
        logToFile(`API key created: "${name}" (${scope}) from ${req.ip}`);
        res.status(201).json({ key, secret });
    });

    // POST rather than GET: cookie-authenticated POSTs need the CSRF header, so another site
    // can't trigger it, and nothing in between will cache it
    router.post('/:id/reveal', async (req, res) => {
        const id = parseId(req.params.id);
        const found = id && (await apiKeyModel.reveal(id));
        if (!found) return res.status(404).json({ error: 'Key not found' });
        if (found.key.revokedAt) return res.status(410).json({ error: 'This key has been revoked' });
        if (!found.secret) {
            return res.status(409).json({
                error: 'This key can no longer be shown because SESSION_SECRET has changed. It still works; create a new key if you need to copy it.',
            });
        }
        logToFile(`API key revealed: "${found.key.name}" from ${req.ip}`);
        res.json({ secret: found.secret });
    });

    router.delete('/:id', async (req, res) => {
        const id = parseId(req.params.id);
        const result = id && (await apiKeyModel.revoke(id));
        if (!result) return res.status(404).json({ error: 'Key not found' });
        if (result.changed) logToFile(`API key revoked: "${result.key.name}" from ${req.ip}`);
        res.json({ key: result.key });
    });

    return router;
}

module.exports = createApiKeyRoutes;
