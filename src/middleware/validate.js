// Request validation. Each helper either returns the cleaned values or an { errors } object.

const BIN_ID_RE = /^[0-9a-f]{16}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const RESPONSE_CONTENT_TYPES = ['application/json', 'text/plain', 'application/xml', 'text/xml', 'text/html'];
const MAX_PAGE_SIZE = 100;
const MAX_BULK_DELETE = 500;
const EXPORT_FORMATS = ['har', 'json'];
const MAX_RESPONSE_BODY = 64 * 1024;
const MAX_RESPONSE_DELAY_MS = 30 * 1000;
const MAX_RULES = 20;
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

// Export options, on top of the list filters (validateRequestQuery runs first):
//   format=har|json, ids=1,2,3 to export only those requests
function validateExportQuery(req, res, next) {
    const errors = {};
    const format = typeof req.query.format === 'string' && req.query.format ? req.query.format.toLowerCase() : 'har';
    if (!EXPORT_FORMATS.includes(format)) errors.format = `must be one of ${EXPORT_FORMATS.join(', ')}`;
    let ids = [];
    if (typeof req.query.ids === 'string' && req.query.ids.trim()) {
        const parts = req.query.ids.split(',');
        ids = parts.map(id => parseId(id.trim()));
        if (parts.length > MAX_BULK_DELETE || ids.includes(null)) errors.ids = `must be a comma-separated list of up to ${MAX_BULK_DELETE} ids`;
    }
    if (Object.keys(errors).length) return badRequest(res, errors);
    req.listQuery.filters.ids = [...new Set(ids)];
    req.exportFormat = format;
    next();
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A response rule's `response` part: any of status, contentType, body, template, delayMs
function parseRuleResponse(src, errors, at) {
    const out = {};
    if (!isPlainObject(src)) {
        errors[at] = 'must be an object';
        return out;
    }
    if (src.status !== undefined) {
        if (!Number.isInteger(src.status) || src.status < 200 || src.status > 599) errors[`${at}.status`] = 'must be an integer between 200 and 599';
        else out.status = src.status;
    }
    if (src.contentType !== undefined) {
        if (!RESPONSE_CONTENT_TYPES.includes(src.contentType)) errors[`${at}.contentType`] = `must be one of ${RESPONSE_CONTENT_TYPES.join(', ')}`;
        else out.contentType = src.contentType;
    }
    if (src.body !== undefined) {
        if (typeof src.body !== 'string' || src.body.length > MAX_RESPONSE_BODY) errors[`${at}.body`] = `must be a string of at most ${MAX_RESPONSE_BODY} characters`;
        else out.body = src.body;
    }
    if (src.template !== undefined) {
        if (typeof src.template !== 'boolean') errors[`${at}.template`] = 'must be true or false';
        else out.template = src.template;
    }
    if (src.delayMs !== undefined) {
        if (!Number.isInteger(src.delayMs) || src.delayMs < 0 || src.delayMs > MAX_RESPONSE_DELAY_MS) errors[`${at}.delayMs`] = `must be an integer between 0 and ${MAX_RESPONSE_DELAY_MS}`;
        else out.delayMs = src.delayMs;
    }
    return out;
}

// A { <key>, value? } condition, where `key` is the header, query or body field it looks at
function parseCondition(src, key, errors, at) {
    if (!isPlainObject(src) || typeof src[key] !== 'string' || src[key].trim() === '' || src[key].length > 200) {
        errors[at] = `must be an object with a ${key} of 1-200 characters`;
        return undefined;
    }
    if (src.value !== undefined && (typeof src.value !== 'string' || src.value.length > 200)) {
        errors[`${at}.value`] = 'must be a string of at most 200 characters';
        return undefined;
    }
    return { [key]: src[key].trim(), ...(src.value !== undefined && { value: src.value }) };
}

// Response rules: an array of up to MAX_RULES { name?, match, response }
function parseRules(value, errors) {
    if (!Array.isArray(value) || value.length > MAX_RULES) {
        errors.responseRules = `must be an array of up to ${MAX_RULES} rules`;
        return undefined;
    }
    const before = Object.keys(errors).length;
    const rules = value.map((src, i) => {
        const at = `responseRules[${i}]`;
        if (!isPlainObject(src)) {
            errors[at] = 'must be an object';
            return null;
        }
        const rule = {};
        if (src.name !== undefined) {
            if (typeof src.name !== 'string' || src.name.length > 100) errors[`${at}.name`] = 'must be a string of at most 100 characters';
            else if (src.name.trim()) rule.name = src.name.trim();
        }
        const matchSrc = src.match;
        rule.match = {};
        if (!isPlainObject(matchSrc)) errors[`${at}.match`] = 'must be an object';
        else {
            if (matchSrc.method !== undefined) {
                const method = typeof matchSrc.method === 'string' ? matchSrc.method.toUpperCase() : '';
                if (!METHODS.includes(method)) errors[`${at}.match.method`] = `must be one of ${METHODS.join(', ')}`;
                else rule.match.method = method;
            }
            if (matchSrc.path !== undefined) {
                if (typeof matchSrc.path !== 'string' || matchSrc.path === '' || matchSrc.path.length > 200) errors[`${at}.match.path`] = 'must be a string of 1-200 characters';
                else rule.match.path = matchSrc.path;
            }
            for (const [field, key] of [['header', 'name'], ['query', 'name'], ['body', 'path']]) {
                if (matchSrc[field] === undefined) continue;
                const condition = parseCondition(matchSrc[field], key, errors, `${at}.match.${field}`);
                if (condition) rule.match[field] = condition;
            }
            if (Object.keys(matchSrc).some(k => !['method', 'path', 'header', 'query', 'body'].includes(k))) {
                errors[`${at}.match`] = 'may only contain method, path, header, query and body';
            } else if (Object.keys(rule.match).length === 0 && !errors[`${at}.match`]) {
                errors[`${at}.match`] = 'needs at least one condition';
            }
        }
        rule.response = parseRuleResponse(src.response, errors, `${at}.response`);
        return rule;
    });
    return Object.keys(errors).length > before ? undefined : rules;
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
    if (body.responseTemplate !== undefined) {
        if (typeof body.responseTemplate !== 'boolean') errors.responseTemplate = 'must be true or false';
        else settings.responseTemplate = body.responseTemplate;
    }
    if (body.responseDelayMs !== undefined) {
        if (!Number.isInteger(body.responseDelayMs) || body.responseDelayMs < 0 || body.responseDelayMs > MAX_RESPONSE_DELAY_MS) {
            errors.responseDelayMs = `must be an integer between 0 and ${MAX_RESPONSE_DELAY_MS}`;
        } else settings.responseDelayMs = body.responseDelayMs;
    }
    if (body.responseRules !== undefined) {
        const rules = parseRules(body.responseRules, errors);
        if (rules) settings.responseRules = rules;
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
    validateExportQuery,
    parseBinSettings,
    METHODS,
    RESPONSE_CONTENT_TYPES,
};
