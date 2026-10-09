const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { matchRule, pickResponse, parseStoredRules, globMatch } = require('../src/utils/rules');

const request = {
    method: 'POST',
    path: '/orders/42',
    queryString: 'mode=test&tag=a&tag=b',
    headers: { 'content-type': 'application/json', 'x-event': 'order.created', 'x-multi': ['one', 'two'] },
    contentType: 'application/json',
    bodyText: JSON.stringify({ event: 'order.created', order: { id: 42, items: [{ sku: 'A1' }] } }),
};

const rule = (match, response = { status: 201 }, name) => ({ ...(name && { name }), match, response });
const matches = match => Boolean(matchRule([rule(match)], request));

describe('glob matching', () => {
    test('* stands for any text and everything else is literal', () => {
        assert.ok(globMatch('/orders/*', '/orders/42'));
        assert.ok(globMatch('*', ''));
        assert.ok(globMatch('/a/*/c', '/a/b/x/c'));
        assert.ok(!globMatch('/orders', '/orders/42'));
        assert.ok(globMatch('/a.b', '/a.b'));
        assert.ok(!globMatch('/a.b', '/aXb'));
        assert.ok(globMatch('/(x)+?', '/(x)+?'));
    });
});

describe('rule matching', () => {
    test('method and path', () => {
        assert.ok(matches({ method: 'POST' }));
        assert.ok(!matches({ method: 'GET' }));
        assert.ok(matches({ path: '/orders/*' }));
        assert.ok(matches({ path: '/orders/42' }));
        assert.ok(!matches({ path: '/orders' }));
    });

    test('headers: case-insensitive names, value patterns, presence, repeated values', () => {
        assert.ok(matches({ header: { name: 'X-Event', value: 'order.*' } }));
        assert.ok(matches({ header: { name: 'x-event' } }));
        assert.ok(!matches({ header: { name: 'x-event', value: 'order.deleted' } }));
        assert.ok(!matches({ header: { name: 'x-missing' } }));
        assert.ok(matches({ header: { name: 'x-multi', value: 'two' } }));
    });

    test('query parameters, including repeated ones', () => {
        assert.ok(matches({ query: { name: 'mode', value: 'test' } }));
        assert.ok(matches({ query: { name: 'tag', value: 'b' } }));
        assert.ok(matches({ query: { name: 'mode' } }));
        assert.ok(!matches({ query: { name: 'mode', value: 'live' } }));
        assert.ok(!matches({ query: { name: 'nope' } }));
    });

    test('JSON body fields, with nested paths and array indexes', () => {
        assert.ok(matches({ body: { path: 'event', value: 'order.created' } }));
        assert.ok(matches({ body: { path: 'order.id', value: '42' } }));
        assert.ok(matches({ body: { path: 'order.items[0].sku', value: 'A*' } }));
        assert.ok(matches({ body: { path: 'order' } }));
        assert.ok(!matches({ body: { path: 'order.id', value: '43' } }));
        assert.ok(!matches({ body: { path: 'missing' } }));
    });

    test('form bodies are matched by field', () => {
        const form = { ...request, contentType: 'application/x-www-form-urlencoded', bodyText: 'a=1&b=two' };
        assert.ok(matchRule([rule({ body: { path: 'b', value: 'two' } })], form));
        assert.ok(!matchRule([rule({ body: { path: 'b', value: 'one' } })], form));
    });

    test('a body condition never matches a body that is not JSON or a form', () => {
        assert.ok(!matchRule([rule({ body: { path: 'a' } })], { ...request, bodyText: 'plain text' }));
        assert.ok(!matchRule([rule({ body: { path: 'a' } })], { ...request, bodyText: null }));
    });

    test('all conditions must hold', () => {
        assert.ok(matches({ method: 'POST', path: '/orders/*', header: { name: 'x-event' } }));
        assert.ok(!matches({ method: 'POST', path: '/orders/*', header: { name: 'x-missing' } }));
    });

    test('the first matching rule wins', () => {
        const rules = [
            rule({ method: 'GET' }, { status: 200 }, 'get'),
            rule({ path: '/orders/*' }, { status: 201 }, 'orders'),
            rule({ method: 'POST' }, { status: 202 }, 'post'),
        ];
        assert.equal(matchRule(rules, request).name, 'orders');
    });

    test('no rules, or no match, means no rule', () => {
        assert.equal(matchRule([], request), undefined);
        assert.equal(matchRule(undefined, request), undefined);
        assert.equal(matchRule([rule({ method: 'GET' })], request), undefined);
    });
});

describe('pickResponse', () => {
    const bin = {
        response_status: 200,
        response_content_type: 'application/json',
        response_body: '{"ok":true}',
        response_template: 0,
        response_delay_ms: 0,
        response_rules: JSON.stringify([
            rule({ path: '/orders/*' }, { status: 404, body: '{"error":"gone"}', template: true, delayMs: 50 }, 'orders gone'),
        ]),
    };

    test('uses the bin response when no rule matches', () => {
        assert.deepEqual(pickResponse(bin, { ...request, path: '/other' }), {
            status: 200,
            contentType: 'application/json',
            body: '{"ok":true}',
            template: false,
            delayMs: 0,
            ruleName: null,
        });
    });

    test('a matching rule overrides the fields it sets and inherits the rest from the bin', () => {
        assert.deepEqual(pickResponse(bin, request), {
            status: 404,
            contentType: 'application/json',
            body: '{"error":"gone"}',
            template: true,
            delayMs: 50,
            ruleName: 'orders gone',
        });
    });

    test('works for rows from PostgreSQL, where flags are booleans', () => {
        const pg = { ...bin, response_template: true, response_rules: null };
        assert.equal(pickResponse(pg, request).template, true);
    });
});

describe('stored rules', () => {
    test('anything that is not a JSON array is no rules', () => {
        assert.deepEqual(parseStoredRules(null), []);
        assert.deepEqual(parseStoredRules(''), []);
        assert.deepEqual(parseStoredRules('not json'), []);
        assert.deepEqual(parseStoredRules('{"a":1}'), []);
        assert.deepEqual(parseStoredRules('[{"match":{"method":"GET"}}]'), [{ match: { method: 'GET' } }]);
    });
});
