const { toIso } = require('../utils/time');

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_SEARCH_TEXT = 256 * 1024; // body text kept for searching, per request

// The body as text when it's valid UTF-8, otherwise null
function bodyAsText(body) {
    if (!body || body.length === 0) return '';
    try {
        return utf8.decode(body);
    } catch {
        return null;
    }
}

// Bodies are returned as text when they're valid UTF-8, otherwise as base64
function encodeBody(raw) {
    const body = raw ? Buffer.from(raw) : Buffer.alloc(0);
    const text = bodyAsText(body);
    return text === null
        ? { body: body.toString('base64'), bodyEncoding: 'base64' }
        : { body: text, bodyEncoding: 'utf8' };
}

const SUMMARY_COLUMNS =
    'r.id, r.bin_id, r.method, r.path, r.query_string, r.content_type, r.body_size, r.ip, r.created_at, b.name AS bin_name';

function toSummary(row) {
    return {
        id: Number(row.id),
        binId: row.bin_id,
        binName: row.bin_name || null,
        method: row.method,
        path: row.path,
        queryString: row.query_string,
        contentType: row.content_type || null,
        bodySize: Number(row.body_size),
        ip: row.ip || null,
        createdAt: toIso(row.created_at),
    };
}

function toDetail(row) {
    return {
        ...toSummary(row),
        headers: JSON.parse(row.headers),
        query: [...new URLSearchParams(row.query_string)].map(([name, value]) => ({ name, value })),
        ...encodeBody(row.body),
    };
}

class RequestModel {
    constructor(db, { maxRequestsPerBin = 500 } = {}) {
        this.db = db;
        this.maxRequestsPerBin = maxRequestsPerBin;
    }

    // Stores a captured request, trims the bin to its newest maxRequestsPerBin, returns the summary
    async insert(binId, { method, path, queryString, headers, contentType, body, ip }) {
        const text = bodyAsText(body);
        const id = await this.db.insert(
            `INSERT INTO requests (bin_id, method, path, query_string, headers, content_type, body, body_text, body_size, ip, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                binId, method, path, queryString, JSON.stringify(headers), contentType || null,
                body.length ? body : null,
                text === null ? null : text.slice(0, MAX_SEARCH_TEXT),
                body.length, ip || null, new Date(),
            ]
        );
        if (this.maxRequestsPerBin > 0) {
            // Two steps (find the cut-off, then delete) because MySQL can't delete from a table
            // while selecting from it in a subquery
            const [cutoff] = await this.db.all(
                `SELECT id FROM requests WHERE bin_id = ? ORDER BY id DESC LIMIT 1 OFFSET ${Number(this.maxRequestsPerBin)}`,
                [binId]
            );
            if (cutoff) await this.db.run('DELETE FROM requests WHERE bin_id = ? AND id <= ?', [binId, cutoff.id]);
        }
        return this.summary(Number(id));
    }

    buildFilters({ binId, method, search, from, to } = {}) {
        const clauses = [];
        const params = [];
        if (binId) {
            clauses.push('r.bin_id = ?');
            params.push(binId);
        }
        if (method) {
            clauses.push('r.method = ?');
            params.push(method);
        }
        if (search) {
            clauses.push('(LOWER(r.path) LIKE ? OR LOWER(r.query_string) LIKE ? OR LOWER(r.headers) LIKE ? OR LOWER(r.body_text) LIKE ?)');
            const like = `%${search.toLowerCase()}%`;
            params.push(like, like, like, like);
        }
        if (from) {
            clauses.push('r.created_at >= ?');
            params.push(from);
        }
        if (to) {
            clauses.push('r.created_at < ?');
            params.push(to);
        }
        return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    }

    // One page of request summaries (newest first) plus the total number of matches
    async list({ limit, offset, ...filters }) {
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new TypeError('limit and offset must be integers');
        const { where, params } = this.buildFilters(filters);
        const [countRow] = await this.db.all(`SELECT COUNT(*) AS total FROM requests r ${where}`, params);
        // limit/offset are validated integers, so they are safe to inline (MySQL rejects them as bound params)
        const rows = await this.db.all(
            `SELECT ${SUMMARY_COLUMNS} FROM requests r LEFT JOIN bins b ON b.id = r.bin_id ${where}
             ORDER BY r.id DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        return { total: Number(countRow.total), requests: rows.map(toSummary) };
    }

    // The newest matching request in full, or null
    async latest(filters) {
        const { requests } = await this.list({ ...filters, limit: 1, offset: 0 });
        return requests.length ? this.get(requests[0].id) : null;
    }

    async summary(id) {
        const [row] = await this.db.all(`SELECT ${SUMMARY_COLUMNS} FROM requests r LEFT JOIN bins b ON b.id = r.bin_id WHERE r.id = ?`, [id]);
        return row ? toSummary(row) : null;
    }

    async get(id) {
        const [row] = await this.db.all('SELECT r.*, b.name AS bin_name FROM requests r LEFT JOIN bins b ON b.id = r.bin_id WHERE r.id = ?', [id]);
        return row ? toDetail(row) : null;
    }

    async deleteMany(ids) {
        if (ids.length === 0) return 0;
        return this.db.run(`DELETE FROM requests WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
    }

    async clear(binId) {
        return this.db.run('DELETE FROM requests WHERE bin_id = ?', [binId]);
    }

    async deleteOlderThan(date) {
        return this.db.run('DELETE FROM requests WHERE created_at < ?', [date]);
    }

    async ping() {
        await this.db.all('SELECT 1 AS ok');
    }
}

module.exports = RequestModel;
