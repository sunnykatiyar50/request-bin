const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPageServer } = require('../src/utils/pages');

describe('versioned page assets', () => {
    let dir;
    const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-pages-'));
        write('app.js', 'console.log(1);');
        write('app.css', 'body{}');
        write('icon.svg', '<svg/>');
        write('page.html', [
            '<link rel="icon" href="icon.svg" type="image/svg+xml">',
            '<link rel="stylesheet" href="app.css">',
            '<script src="app.js"></script>',
            '<script src="missing.js"></script>',
            '<a href="https://example.com/x.js">external</a>',
            '<a href="/page.html">page</a>',
        ].join('\n'));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const version = (html, name) => (new RegExp(`${name.replace('.', '\\.')}\\?v=([0-9a-f]{10})"`).exec(html) || [])[1];

    test('adds a content hash to the assets a page references', () => {
        const html = createPageServer(dir).render('page.html');
        assert.match(html, /href="icon\.svg\?v=[0-9a-f]{10}"/);
        assert.match(html, /href="app\.css\?v=[0-9a-f]{10}"/);
        assert.match(html, /src="app\.js\?v=[0-9a-f]{10}"/);
    });

    test('leaves everything else alone: missing files, external links and pages', () => {
        const html = createPageServer(dir).render('page.html');
        assert.ok(html.includes('<script src="missing.js"></script>'));
        assert.ok(html.includes('href="https://example.com/x.js"'));
        assert.ok(html.includes('<a href="/page.html">'));
    });

    test('the version changes when, and only when, the file changes', () => {
        const pages = createPageServer(dir);
        const before = pages.render('page.html');
        assert.equal(pages.render('page.html'), before);
        write('app.js', 'console.log(2);');
        const after = pages.render('page.html');
        assert.notEqual(version(after, 'app.js'), version(before, 'app.js'));
        assert.equal(version(after, 'app.css'), version(before, 'app.css'));
    });

    test('the same content has the same version in another server instance', () => {
        assert.equal(version(createPageServer(dir).render('page.html'), 'app.css'), version(createPageServer(dir).render('page.html'), 'app.css'));
    });

    test('pages are sent uncacheable, as HTML', () => {
        const headers = {};
        let sent;
        const res = {
            set(h) { Object.assign(headers, h); return this; },
            send(body) { sent = body; },
        };
        createPageServer(dir).send(res, 'page.html');
        assert.equal(headers['Cache-Control'], 'no-store');
        assert.match(headers['Content-Type'], /^text\/html/);
        assert.match(sent, /app\.css\?v=/);
    });
});
