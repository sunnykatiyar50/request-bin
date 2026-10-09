const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate } = require('../src/utils/template');

const request = {
    id: 42,
    binId: '0123456789abcdef',
    method: 'POST',
    path: '/hooks/stripe',
    queryString: 'attempt=2&name=O%27Brien',
    headers: { 'content-type': 'application/json', 'x-trace': 'abc"123' },
    contentType: 'application/json',
    bodyText: JSON.stringify({ user: { name: 'Ada "A" <L>', roles: ['admin'] }, items: [{ id: 7 }], ok: true }),
    ip: '10.0.0.5',
};
const render = (template, contentType = 'text/plain', overrides = {}) =>
    renderTemplate(template, { ...request, ...overrides }, contentType);

describe('response templates', () => {
    test('fills request fields', () => {
        assert.equal(render('{{method}} {{path}} {{ip}} #{{id}} {{bin}}'), 'POST /hooks/stripe 10.0.0.5 #42 0123456789abcdef');
        assert.equal(render('{{query}}'), 'attempt=2&name=O%27Brien');
        assert.equal(render('{{query.attempt}} {{ query.name }}'), "2 O'Brien");
        assert.equal(render('{{header.X-Trace}}'), 'abc"123');
    });

    test('reads JSON fields by path, with array indexes', () => {
        assert.equal(render('{{body.user.roles.0}} {{body.items[0].id}} {{body.ok}}'), 'admin 7 true');
        assert.equal(render('{{body.user.roles}}'), '["admin"]');
    });

    test('reads form fields', () => {
        assert.equal(render('{{body.a}}+{{body.b}}', 'text/plain', { contentType: 'application/x-www-form-urlencoded', bodyText: 'a=1&b=two+words' }), '1+two words');
    });

    test('uses the fallback for missing values and unknown placeholders', () => {
        assert.equal(render('[{{query.nope}}] [{{query.nope | none}}] [{{nonsense}}] [{{body.user.age|0}}]'), '[] [none] [] [0]');
        assert.equal(render('{{body.x | n/a}}', 'text/plain', { bodyText: 'not json' }), 'n/a');
        assert.equal(render('{{body|empty}}', 'text/plain', { bodyText: '' }), 'empty');
    });

    test('escapes values for JSON responses, inserting non-strings as JSON', () => {
        const out = render('{"name": "{{body.user.name}}", "user": {{body.user}}, "id": {{body.items.0.id}}, "q": "{{query.name}}"}', 'application/json');
        const parsed = JSON.parse(out);
        assert.equal(parsed.name, 'Ada "A" <L>');
        assert.deepEqual(parsed.user.roles, ['admin']);
        assert.equal(parsed.id, 7);
        assert.equal(parsed.q, "O'Brien");
    });

    test('escapes values for HTML and XML responses', () => {
        assert.equal(render('<b>{{body.user.name}}</b>', 'text/html'), '<b>Ada &quot;A&quot; &lt;L&gt;</b>');
        assert.equal(render('<n>{{query.name}}</n>', 'application/xml'), '<n>O&#39;Brien</n>');
    });

    test('generates times and ids', () => {
        assert.match(render('{{now}}'), /^\d{4}-\d{2}-\d{2}T/);
        assert.match(render('{{timestamp}}'), /^\d{13}$/);
        assert.match(render('{{uuid}}'), /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    });

    test('leaves text without placeholders alone', () => {
        assert.equal(render('{ "a": { "b": 1 } } {not} {{ }}'), '{ "a": { "b": 1 } } {not} {{ }}');
    });
});
