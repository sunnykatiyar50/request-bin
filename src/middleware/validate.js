// Request validation. Each helper either returns the cleaned values or an { errors } object.

const BIN_ID_RE = /^[0-9a-f]{16}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const RESPONSE_CONTENT_TYPES = ['application/json', 'text/plain', 'application/xml', 'text/xml', 'text/html'];
const MAX_PAGE_SIZE = 100;
const MAX_BULK_DELETE = 500;
const MAX_RESPONSE_BODY = 64 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(res, details) {
    return res.status(400).json({ error: 'Validation failed', details });
}

function parseId(value) {
    const s = String(value);
    if (!/^[1-9][0-9]{0,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

const isBinId = value => BIN_ID_RE.test(String(value));

function parseDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Parses a date-only value as the start of that day in UTC
function parseDay(value) {
    if (!DATE_RE.test(value)) return null;
    return parseDateTime(`${value}T00:00:00.000Z`);
}

// Filters for listing captured requests:
//   bin, method, search, from/to (ISO date-times) or startDate/endDate (YYYY-MM-DD, UTC, inclusive),
//   page, pageSize
function validateRequestQuery(req, res, next) {
    const q = req.query;
    const str = name => (typeof q[name] === 'string' ? q[name].trim() : '');
    const errors = {};

    const page = str('page') ? parseInt(str('page'), 10) : 1;
    if (!Number.isInteger(page) || page < 1) errors.page = 'must be a positive integer';
    const pageSize = str('pageSize') ? parseInt(str('pageSize'), 10) : 25;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) errors.pageSize = `must be between 1 and ${MAX_PAGE_SIZE}`;

    const binId = str('bin');
    if (binId && !isBinId(binId)) errors.bin = 'must be a bin id';
    const method = str('method').toUpperCase();
    if (method && !METHODS.includes(method)) errors.method = `must be one of ${METHODS.join(', ')}`;

    let from = null;
    let to = null;
    if (str('from')) {
        from = parseDateTime(str('from'));
        if (!from) errors.from = 'must be an ISO date-time';
    } else if (str('startDate')) {
        from = parseDay(str('startDate'));
        if (!from) errors.startDate = 'must be YYYY-MM-DD';
    }
    if (str('to')) {
        to = parseDateTime(str('to'));
        if (!to) errors.to = 'must be an ISO date-time';
    } else if (str('endDate')) {
        to = parseDay(str('endDate'));
        if (!to) errors.endDate = 'must be YYYY-MM-DD';
        else to = new Date(to.getTime() + 24 * 60 * 60 * 1000); // inclusive end day
    }

    if (Object.keys(errors).length) return badRequest(res, errors);
    req.listQuery = { page, pageSize, filters: { binId, method, search: str('search').slice(0, 200), from, to } };
    next();
}

function validateIdParam(req, res, next) {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(res, { id: 'must be a positive integer' });
    req.validated = { ids: [id] };
    next();
}

function validateIdList(req, res, next) {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE) {
        return badRequest(res, { ids: `must be an array of 1-${MAX_BULK_DELETE} ids` });
    }
    const parsed = ids.map(parseId);
    if (parsed.includes(null)) return badRequest(res, { ids: 'must contain only positive integers' });
    req.validated = { ids: [...new Set(parsed)] };
    next();
}

// Bin settings in a create/update body; returns { settings } or { errors }
function parseBinSettings(body = {}) {
    const errors = {};
    const settings = {};
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 100) {
            errors.name = 'must be 1-100 characters';
        } else settings.name = body.name.trim();
    }
    if (body.redactHeaders !== undefined) {
        if (typeof body.redactHeaders !== 'boolean') errors.redactHeaders = 'must be true or false';
        else settings.redactHeaders = body.redactHeaders;
    }
    if (body.responseStatus !== undefined) {
        if (!Number.isInteger(body.responseStatus) || body.responseStatus < 200 || body.responseStatus > 599) {
            errors.responseStatus = 'must be an integer between 200 and 599';
        } else settings.responseStatus = body.responseStatus;
    }
    if (body.responseContentType !== undefined) {
        if (!RESPONSE_CONTENT_TYPES.includes(body.responseContentType)) {
            errors.responseContentType = `must be one of ${RESPONSE_CONTENT_TYPES.join(', ')}`;
        } else settings.responseContentType = body.responseContentType;
    }
    if (body.responseBody !== undefined) {
        if (typeof body.responseBody !== 'string' || body.responseBody.length > MAX_RESPONSE_BODY) {
            errors.responseBody = `must be a string of at most ${MAX_RESPONSE_BODY} characters`;
        } else settings.responseBody = body.responseBody;
    }
    return Object.keys(errors).length ? { errors } : { settings };
}

module.exports = {
    badRequest,
    parseId,
    isBinId,
    validateRequestQuery,
    validateIdParam,
    validateIdList,
    parseBinSettings,
    METHODS,
    RESPONSE_CONTENT_TYPES,
};
