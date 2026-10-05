const crypto = require('crypto');

const FIELDS = {
    name: 'name',
    redactHeaders: 'redact_headers',
    responseStatus: 'response_status',
    responseContentType: 'response_content_type',
    responseBody: 'response_body',
};

function toBin(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        hasSecret: Boolean(row.secret),
        redactHeaders: Boolean(row.redact_headers),
        responseStatus: row.response_status,
        responseContentType: row.response_content_type,
        responseBody: row.response_body,
        createdAt: row.created_at,
        ...(row.request_count !== undefined && { requestCount: Number(row.request_count) }),
    };
}

class BinModel {
    constructor(db) {
        this.db = db;
    }

    // Returns the new bin and, if requested, its generated secret (shown only once)
    create({ name, withSecret = false, ...settings }) {
        const id = crypto.randomBytes(8).toString('hex');
        const secret = withSecret ? crypto.randomBytes(24).toString('base64url') : null;
        this.db
            .prepare('INSERT INTO bins (id, name, secret, created_at) VALUES (?, ?, ?, ?)')
            .run(id, name || `Bin ${id.slice(0, 6)}`, secret, new Date().toISOString());
        if (Object.keys(settings).length) this.update(id, settings);
        return { bin: this.get(id), secret };
    }

    list() {
        const rows = this.db
            .prepare(
                `SELECT b.*, (SELECT COUNT(*) FROM requests r WHERE r.bin_id = b.id) AS request_count
                 FROM bins b ORDER BY b.created_at DESC`
            )
            .all();
        return rows.map(toBin);
    }

    get(id) {
        return toBin(this.db.prepare('SELECT * FROM bins WHERE id = ?').get(id));
    }

    // Raw row including the secret; used only by the capture route
    getForCapture(id) {
        return this.db.prepare('SELECT * FROM bins WHERE id = ?').get(id) || null;
    }

    update(id, settings) {
        const sets = [];
        const params = [];
        for (const [key, column] of Object.entries(FIELDS)) {
            if (settings[key] === undefined) continue;
            sets.push(`${column} = ?`);
            params.push(typeof settings[key] === 'boolean' ? Number(settings[key]) : settings[key]);
        }
        if (sets.length) {
            this.db.prepare(`UPDATE bins SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
        }
        return this.get(id);
    }

    delete(id) {
        return this.db.prepare('DELETE FROM bins WHERE id = ?').run(id).changes > 0;
    }
}

module.exports = BinModel;
