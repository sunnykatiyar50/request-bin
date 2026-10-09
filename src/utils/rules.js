const { parseBody, lookup } = require('./template');

// Response rules: a bin can hold a list of rules, checked in order. The first rule whose `match`
// conditions all hold decides the response; otherwise the bin's own response is used.
//
//   { name?, match: { method?, path?, header?: {name, value?}, query?: {name, value?}, body?: {path, value?} },
//     response: { status?, contentType?, body?, template?, delayMs? } }
//
// `path` and every `value` are exact, case-sensitive matches where * stands for any text. A header,
// query or body condition without a value only requires the field to be present. Response fields
// a rule leaves out come from the bin.

const globCache = new Map();

function globToRegExp(pattern) {
    let re = globCache.get(pattern);
    if (!re) {
        re = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
        if (globCache.size > 500) globCache.clear();
        globCache.set(pattern, re);
    }
    return re;
}

const globMatch = (pattern, text) => globToRegExp(pattern).test(text);

// Does a field's value (undefined when absent; arrays for repeated headers or parameters) satisfy
// an optional value pattern?
function valueMatches(actual, pattern) {
    if (actual === undefined || actual === null) return false;
    if (pattern === undefined) return true;
    const values = Array.isArray(actual) ? actual : [actual];
    return values.some(v => globMatch(pattern, typeof v === 'object' ? JSON.stringify(v) : String(v)));
}

// request: { method, path, queryString, headers, contentType, bodyText }
function ruleMatches(match, request, query, getBody) {
    if (match.method && match.method !== request.method) return false;
    if (match.path !== undefined && !globMatch(match.path, request.path)) return false;
    if (match.header && !valueMatches(request.headers[match.header.name.toLowerCase()], match.header.value)) return false;
    if (match.query) {
        const values = query.getAll(match.query.name);
        if (!valueMatches(values.length ? values : undefined, match.query.value)) return false;
    }
    if (match.body) {
        const body = getBody();
        if (body === null || typeof body !== 'object') return false;
        if (!valueMatches(lookup(body, match.body.path), match.body.value)) return false;
    }
    return true;
}

// The first matching rule, or undefined
function matchRule(rules, request) {
    if (!Array.isArray(rules) || rules.length === 0) return undefined;
    const query = new URLSearchParams(request.queryString);
    let body; // parsed lazily, once
    const getBody = () => {
        if (body === undefined) body = parseBody(request.bodyText, request.contentType) ?? null;
        return body;
    };
    return rules.find(rule => ruleMatches(rule.match || {}, request, query, getBody));
}

function parseStoredRules(value) {
    if (!value) return [];
    try {
        const rules = JSON.parse(value);
        return Array.isArray(rules) ? rules : [];
    } catch {
        return [];
    }
}

// The response to send for a captured request: from the matching rule, else from the bin.
// bin is a raw row; returns { status, contentType, body, template, delayMs, ruleName }
function pickResponse(bin, request) {
    const rule = matchRule(parseStoredRules(bin.response_rules), request);
    const r = (rule && rule.response) || {};
    return {
        status: r.status ?? Number(bin.response_status),
        contentType: r.contentType ?? bin.response_content_type,
        body: r.body ?? bin.response_body,
        template: r.template ?? Boolean(Number(bin.response_template)),
        delayMs: r.delayMs ?? Number(bin.response_delay_ms),
        ruleName: rule ? rule.name || null : null,
    };
}

module.exports = { matchRule, pickResponse, parseStoredRules, globMatch };
