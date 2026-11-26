const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, openTestDatabase } = require('./helpers/database');
setupTestEnv('pwa');

const request = require('supertest');
const { loadConfig } = require('../src/config');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = {
    ADMIN_USERNAME: 'opsadmin',
    ADMIN_PASSWORD: 'correct horse battery staple',
    ADMIN_TOKEN,
    SESSION_SECRET: 'x'.repeat(48),
};

let db;
let app;

before(async () => {
    db = await openTestDatabase();
    const config = loadConfig(env);
    app = createApp({
        config,
        binModel: new BinModel(db, { encryptionSecret: config.sessionSecret }),
        requestModel: new RequestModel(db, { maxRequestsPerBin: config.maxRequestsPerBin }),
        apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
    });
});

after(async () => {
    await db.close();
});

describe('installable web app', () => {
    test('the sign-in page and the dashboard link the manifest and the install meta tags', async () => {
        for (const page of ['/login.html', '/']) {
            const res = await request(app).get(page);
            // the dashboard redirects to sign-in when signed out, so follow that for the dashboard
            const html = res.status === 302 ? (await request(app).get('/login.html')).text : res.text;
            assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/, page);
            assert.match(html, /<meta name="theme-color" content="#2563eb">/, page);
            assert.match(html, /<link rel="apple-touch-icon" href="icon-192\.png">/, page);
            assert.match(html, /<script src="pwa\.js\?v=[0-9a-f]{10}" defer><\/script>/, page);
        }
    });

    test('the manifest is public and served as a web app manifest', async () => {
        const res = await request(app).get('/manifest.webmanifest');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /application\/(manifest\+json|json)/);
        assert.equal(res.body.name, 'Request Bin');
        assert.equal(res.body.start_url, '/');
        assert.equal(res.body.display, 'standalone');
        const sizes = res.body.icons.map(icon => icon.sizes);
        assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
        for (const icon of res.body.icons) {
            const file = await request(app).get(`/${icon.src}`);
            assert.equal(file.status, 200, icon.src);
        }
    });

    test('the service worker is served from the root, so its scope covers the whole app', async () => {
        const res = await request(app).get('/sw.js');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /javascript/);
        assert.match(res.headers['cache-control'], /no-cache/);
    });

    test('the service worker never caches pages, the API, the capture endpoint or sign-in', async () => {
        const res = await request(app).get('/sw.js');
        assert.match(res.text, /NOT_CACHED_PATH = \/\^\\\/\(\?:api\|b\|auth\|health\)/);
        assert.match(res.text, /request\.mode === 'navigate'/);
    });

    test('the offline page is public', async () => {
        const res = await request(app).get('/offline.html');
        assert.equal(res.status, 200);
        assert.match(res.text, /You're offline/);
    });

    test('the dashboard still requires a session', async () => {
        const res = await request(app).get('/');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/login.html');
    });

    test('the API is not affected by the PWA routes', async () => {
        const res = await request(app).get('/api/bins');
        assert.equal(res.status, 401);
    });
});
