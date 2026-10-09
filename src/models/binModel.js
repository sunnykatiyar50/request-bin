const crypto = require('crypto');
const { toIso } = require('../utils/time');
const { hashApiKey, createKeyCipher } = require('../utils/apiKeys');
const { safeEqual } = require('../utils/session');

const SETTINGS = {
    name: 'name',
    redactHeaders: 'redact_headers',
    responseStatus: 'response_status',
    responseContentType: 'response_content_type',
    responseBody: 'response_body',
    responseTemplate: 'response_template',
    responseDelayMs: 'response_delay_ms',
};

function toBin(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        hasSecret: Boolean(row.secret_hash),
        redactHeaders: Boolean(Number(row.redact_headers)),
        responseStatus: Number(row.response_status),
        responseContentType: row.response_content_type,
        responseBody: row.response_body,
        responseTemplate: Boolean(Number(row.response_template)),
        responseDelayMs: Number(row.response_delay_ms),
        createdAt: toIso(row.created_at),
        ...(row.request_count !== undefined && { requestCount: Number(row.request_count) }),
        ...(row.last_request_at !== undefined && { lastRequestAt: toIso(row.last_request_at) }),
    };
}

// Bins: each has its own capture URL (/b/<id>/...), a configurable response (optionally templated
// and delayed), an optional secret and header redaction. The secret is stored like API keys: a hash to check requests, and an
// encrypted copy (key derived from SESSION_SECRET) so the dashboard can show it again.
class BinModel {
    constructor(db, { encryptionSecret } = {}) {
        this.db = db;
        this.cipher = createKeyCipher(encryptionSecret);
    }

    static newSecret() {
        return crypto.randomBytes(24).toString('base64url');
    }

    // Returns { bin, secret } (secret only when one was requested)
    async create({ name, withSecret = false, ...settings }) {
        const id = crypto.randomBytes(8).toString('hex');
        const secret = withSecret ? BinModel.newSecret() : null;
        await this.db.run(
            `INSERT INTO bins (id, name, secret_hash, secret_encrypted, redact_headers, response_status,
                               response_content_type, response_body, response_template, response_delay_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                name || `Bin ${id.slice(0, 6)}`,
                secret ? hashApiKey(secret) : null,
                secret ? this.cipher.encrypt(secret) : null,
                settings.redactHeaders ?? true,
                settings.responseStatus ?? 200,
                settings.responseContentType ?? 'application/json',
                settings.responseBody ?? '{"ok":true}',
                settings.responseTemplate ?? false,
                settings.responseDelayMs ?? 0,
                new Date(),
            ]
        );
        return { bin: await this.get(id), secret };
    }

    // All bins with their request counts and the time of their latest request, newest bin first
    async list() {
        const rows = await this.db.all(
            `SELECT b.*, COALESCE(s.request_count, 0) AS request_count, s.last_request_at
             FROM bins b
             LEFT JOIN (SELECT bin_id, COUNT(*) AS request_count, MAX(created_at) AS last_request_at
                        FROM requests GROUP BY bin_id) s ON s.bin_id = b.id
             ORDER BY b.created_at DESC`
        );
        return rows.map(toBin);
    }

    async get(id) {
        const [row] = await this.db.all('SELECT * FROM bins WHERE id = ?', [id]);
        return toBin(row);
    }

    // Raw row, including the secret hash; only for the capture route
    async getForCapture(id) {
        const [row] = await this.db.all('SELECT * FROM bins WHERE id = ?', [id]);
        return row || null;
    }

    checkSecret(row, presented) {
        if (!row.secret_hash) return true;
        return typeof presented === 'string' && presented !== '' && safeEqual(hashApiKey(presented), row.secret_hash);
    }

    async update(id, settings) {
        const sets = [];
        const params = [];
        for (const [key, column] of Object.entries(SETTINGS)) {
            if (settings[key] === undefined) continue;
            sets.push(`${column} = ?`);
            params.push(settings[key]);
        }
        if (sets.length) await this.db.run(`UPDATE bins SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        return this.get(id);
    }

    // Sets a new secret (returned) or removes it (enabled = false)
    async setSecret(id, enabled) {
        const secret = enabled ? BinModel.newSecret() : null;
        await this.db.run('UPDATE bins SET secret_hash = ?, secret_encrypted = ? WHERE id = ?', [
            secret ? hashApiKey(secret) : null,
            secret ? this.cipher.encrypt(secret) : null,
            id,
        ]);
        return secret;
    }

    // { secret } (null when it can't be decrypted because SESSION_SECRET changed), or undefined without one
    async revealSecret(id) {
        const [row] = await this.db.all('SELECT secret_encrypted FROM bins WHERE id = ?', [id]);
        if (!row || !row.secret_encrypted) return undefined;
        return { secret: this.cipher.decrypt(row.secret_encrypted) };
    }

    // Deletes the bin and everything captured in it
    async delete(id) {
        await this.db.run('DELETE FROM requests WHERE bin_id = ?', [id]);
        return (await this.db.run('DELETE FROM bins WHERE id = ?', [id])) > 0;
    }
}

module.exports = BinModel;
