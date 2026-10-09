const crypto = require('crypto');

// Response templating: a bin's response body can contain {{ placeholder }} or
// {{ placeholder | fallback }}, filled in from the captured request:
//
//   {{method}} {{path}} {{ip}} {{id}} {{bin}}       request method, sub-path, client IP, request id, bin id
//   {{query}} {{query.<name>}}                      whole query string, or one parameter
//   {{header.<name>}}                               a request header (case-insensitive)
//   {{body}} {{body.<path>}}                        whole body, or a JSON field (user.name, items.0.id,
//                                                   items[0].id) or form field
//   {{now}} {{timestamp}} {{uuid}}                  ISO time, Unix time in ms, a random UUID
//
// Unknown placeholders and missing values become the fallback (or nothing). Values are escaped
// for the response content type: JSON string escaping, or HTML/XML entities. In JSON responses,
// non-string JSON values (numbers, objects, ...) are inserted as JSON, so {"user": {{body.user}}}
// works as well as {"name": "{{body.user.name}}"}.

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z]+)(?:\.([^|}]+?))?\s*(?:\|([^}]*))?\}\}/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escaperFor(contentType) {
    if (/json/i.test(contentType)) return value => JSON.stringify(value).slice(1, -1);
    if (/html|xml/i.test(contentType)) return value => value.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
    return value => value;
}

// The body parsed as JSON or a form, for {{body.<path>}}; undefined when it's neither
function parseBody(text, contentType) {
    if (!text) return undefined;
    if (/x-www-form-urlencoded/i.test(contentType || '')) return Object.fromEntries(new URLSearchParams(text));
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function lookup(value, path) {
    for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
    }
    return value;
}

// request: { id, binId, method, path, queryString, headers, contentType, bodyText (string or null), ip }
function renderTemplate(template, request, contentType) {
    const escape = escaperFor(contentType);
    const json = /json/i.test(contentType);
    const query = new URLSearchParams(request.queryString);
    let body; // parsed lazily, once

    const resolve = (source, key) => {
        switch (source) {
            case 'method': return request.method;
            case 'path': return request.path;
            case 'ip': return request.ip;
            case 'id': return request.id;
            case 'bin': return request.binId;
            case 'now': return new Date().toISOString();
            case 'timestamp': return Date.now();
            case 'uuid': return crypto.randomUUID();
            case 'query': return key === undefined ? request.queryString : query.get(key) ?? undefined;
            case 'header': return key === undefined ? undefined : request.headers[key.toLowerCase()];
            case 'body':
                if (key === undefined) return request.bodyText ?? undefined;
                if (body === undefined) body = parseBody(request.bodyText, request.contentType) ?? null;
                return lookup(body, key);
            default: return undefined;
        }
    };

    return template.replace(PLACEHOLDER_RE, (match, source, key, fallback) => {
        let value = resolve(source.toLowerCase(), key?.trim());
        if (Array.isArray(value) && source.toLowerCase() === 'header') value = value.join(', ');
        if (value === undefined || value === null || value === '') return escape((fallback ?? '').trim());
        if (typeof value === 'string') return escape(value);
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return json ? text : escape(text);
    });
}

module.exports = { renderTemplate, parseBody, lookup };
