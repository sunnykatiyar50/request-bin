const utf8 = new TextDecoder('utf-8', { fatal: true });

// Bodies are returned as text when they are valid UTF-8, otherwise as base64
function encodeBody(body) {
    if (!body || body.length === 0) return { body: '', bodyEncoding: 'utf8' };
    try {
        return { body: utf8.decode(body), bodyEncoding: 'utf8' };
    } catch {
        return { body: Buffer.from(body).toString('base64'), bodyEncoding: 'base64' };
    }
}

function toSummary(row) {
    return {
        id: Number(row.id),
        binId: row.bin_id,
        method: row.method,
        path: row.path,
        queryString: row.query_string,
        contentType: row.content_type,
        bodySize: Number(row.body_size),
        ip: row.ip,
        createdAt: row.created_at,
    };
}

function toDetail(row) {
    return {
        ...toSummary(row),
        headers: JSON.parse(row.headers),
        query: Object.fromEntries(new URLSearchParams(row.query_string)),
        ...encodeBody(row.body),
    };
}

const SUMMARY_COLUMNS = 'id, bin_id, method, path, query_string, content_type, body_size, ip, created_at';

class RequestModel {
    constructor(db, { maxRequestsPerBin }) {
        this.db = db;
        this.maxRequestsPerBin = maxRequestsPerBin;
    }

    // Stores a captured request and trims the bin to its newest maxRequestsPerBin entries
    insert(binId, { method, path, queryString, headers, contentType, body, ip }) {
        const createdAt = new Date().toISOString();
        const { lastInsertRowid } = this.db
            .prepare(
                `INSERT INTO requests (bin_id, method, path, query_string, headers, content_type, body, body_size, ip, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(binId, method, path, queryString, JSON.stringify(headers), contentType || null,
                body.length ? body : null, body.length, ip || null, createdAt);

        if (this.maxRequestsPerBin > 0) {
            this.db
                .prepare(
                    `DELETE FROM requests WHERE bin_id = ? AND id <= (
                        SELECT id FROM requests WHERE bin_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
                    )`
                )
                .run(binId, binId, this.maxRequestsPerBin);
        }
        return this.get(Number(lastInsertRowid));
    }

    list(binId, { method, search, limit, offset }) {
        const clauses = ['bin_id = ?'];
        const params = [binId];
        if (method) {
            clauses.push('method = ?');
            params.push(method);
        }
        if (search) {
            clauses.push(`(LOWER(path) LIKE ? OR LOWER(query_string) LIKE ? OR LOWER(headers) LIKE ?
                           OR LOWER(CAST(body AS TEXT)) LIKE ?)`);
            const like = `%${search.toLowerCase()}%`;
            params.push(like, like, like, like);
        }
        const where = clauses.join(' AND ');
        const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM requests WHERE ${where}`).get(...params);
        const rows = this.db
            .prepare(`SELECT ${SUMMARY_COLUMNS} FROM requests WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        return { total: Number(total), requests: rows.map(toSummary) };
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
        return row ? toDetail(row) : null;
    }

    delete(id) {
        return this.db.prepare('DELETE FROM requests WHERE id = ?').run(id).changes > 0;
    }

    clear(binId) {
        return Number(this.db.prepare('DELETE FROM requests WHERE bin_id = ?').run(binId).changes);
    }

    deleteOlderThan(date) {
        return Number(this.db.prepare('DELETE FROM requests WHERE created_at < ?').run(date.toISOString()).changes);
    }
}

module.exports = RequestModel;
