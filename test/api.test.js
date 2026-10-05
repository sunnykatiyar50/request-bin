const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'request-bin-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const { createApp } = require('../src/server');

const ADMIN_TOKEN = 'admin-token-0123456789';
const ADMIN_PASSWORD = 'correct horse battery staple';
const env = {
    ADMIN_PASSWORD,
    ADMIN_TOKEN,
    SESSION_SECRET: 'x'.repeat(48),
    MAX_BODY_KB: '4',
    MAX_REQUESTS_PER_BIN: '5',
};

let app;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

async function createBin(body = {}) {
    const res = await admin(request(app).post('/api/bins')).send(body);
    assert.equal(res.status, 201);
    return res.body;
}

async function latestRequest(binId) {
    const list = await admin(request(app).get(`/api/bins/${binId}/requests`));
    return (await admin(request(app).get(`/api/requests/${list.body.requests[0].id}`))).body;
}

before(() => {
    const config = loadConfig(env);
    const db = openDatabase(':memory:');
    app = createApp({ config, binModel: new BinModel(db), requestModel: new RequestModel(db, config) });
});

describe('config', () => {
    test('refuses to start without auth settings', () => {
        assert.throws(() => loadConfig({}), /Invalid auth configuration/);
    });
    test('rejects sample.env placeholders', () => {
        assert.throws(() => loadConfig({ ...env, ADMIN_PASSWORD: 'change-me' }), /placeholder/);
    });
});

describe('admin API', () => {
    test('requires authentication', async () => {
        assert.equal((await request(app).get('/api/bins')).status, 401);
        assert.equal((await request(app).post('/api/bins').send({})).status, 401);
    });

    test('creates, lists, updates and deletes bins', async () => {
        const { bin } = await createBin({ name: 'Stripe webhooks' });
        assert.match(bin.id, /^[0-9a-f]{16}$/);

        const list = await admin(request(app).get('/api/bins'));
        assert.ok(list.body.bins.some(b => b.id === bin.id && b.requestCount === 0));

        const updated = await admin(request(app).patch(`/api/bins/${bin.id}`)).send({ responseStatus: 202 });
        assert.equal(updated.body.responseStatus, 202);

        assert.equal((await admin(request(app).delete(`/api/bins/${bin.id}`))).status, 200);
        assert.equal((await admin(request(app).get(`/api/bins/${bin.id}`))).status, 404);
    });

    test('validates bin settings', async () => {
        const res = await admin(request(app).post('/api/bins')).send({
            responseStatus: 99,
            responseContentType: 'text/html',
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.responseStatus);
        assert.ok(res.body.details.responseContentType);
    });
});

describe('capture', () => {
    test('captures method, path, query, headers and body', async () => {
        const { bin } = await createBin();
        const res = await request(app)
            .post(`/b/${bin.id}/orders/42?expand=items&x=1`)
            .set('Content-Type', 'application/json')
            .set('X-Custom', 'hello')
            .send('{"event":"order.created"}');
        assert.equal(res.status, 200);

        const detail = await latestRequest(bin.id);
        assert.equal(detail.method, 'POST');
        assert.equal(detail.path, '/orders/42');
        assert.deepEqual(detail.query, { expand: 'items', x: '1' });
        assert.equal(detail.headers['x-custom'], 'hello');
        assert.equal(detail.body, '{"event":"order.created"}');
        assert.equal(detail.bodyEncoding, 'utf8');
    });

    test('captures requests to the bin root and any method', async () => {
        const { bin } = await createBin();
        await request(app).put(`/b/${bin.id}`).send('x');
        await request(app).delete(`/b/${bin.id}/a/b/c`);
        const list = await admin(request(app).get(`/api/bins/${bin.id}/requests`));
        assert.deepEqual(list.body.requests.map(r => `${r.method} ${r.path}`), ['DELETE /a/b/c', 'PUT /']);
    });

    test('stores binary bodies as base64', async () => {
        const { bin } = await createBin();
        await request(app).post(`/b/${bin.id}`).set('Content-Type', 'application/octet-stream').send(Buffer.from([0xff, 0x00, 0xfe]));
        const detail = await latestRequest(bin.id);
        assert.equal(detail.bodyEncoding, 'base64');
        assert.equal(detail.body, Buffer.from([0xff, 0x00, 0xfe]).toString('base64'));
    });

    test('redacts sensitive headers by default', async () => {
        const { bin } = await createBin();
        await request(app).get(`/b/${bin.id}`).set('Authorization', 'Bearer real-token').set('Cookie', 'a=b');
        const detail = await latestRequest(bin.id);
        assert.equal(detail.headers.authorization, '[redacted]');
        assert.equal(detail.headers.cookie, '[redacted]');
    });

    test('keeps headers when redaction is turned off', async () => {
        const { bin } = await createBin({ redactHeaders: false });
        await request(app).get(`/b/${bin.id}`).set('Authorization', 'Bearer real-token');
        assert.equal((await latestRequest(bin.id)).headers.authorization, 'Bearer real-token');
    });

    test('rejects bodies over the size limit', async () => {
        const { bin } = await createBin();
        const res = await request(app).post(`/b/${bin.id}`).set('Content-Type', 'text/plain').send('a'.repeat(5000));
        assert.equal(res.status, 413);
    });

    test('returns 404 for unknown bins', async () => {
        assert.equal((await request(app).get('/b/0000000000000000')).status, 404);
        assert.equal((await request(app).get('/b/not-a-bin')).status, 404);
    });

    test('enforces the bin secret and redacts it from the stored query', async () => {
        const { bin, secret } = await createBin({ withSecret: true });
        assert.ok(secret);
        assert.equal((await request(app).post(`/b/${bin.id}`)).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('X-Bin-Secret', secret)).status, 200);
        assert.equal((await request(app).post(`/b/${bin.id}?secret=${secret}&a=1`)).status, 200);
        const detail = await latestRequest(bin.id);
        assert.equal(detail.query.secret, '[redacted]');
        assert.equal(detail.query.a, '1');
    });

    test('serves the configured response inside a sandbox CSP', async () => {
        const { bin } = await createBin({ responseStatus: 201, responseContentType: 'text/plain', responseBody: 'thanks' });
        const res = await request(app).post(`/b/${bin.id}`);
        assert.equal(res.status, 201);
        assert.equal(res.text, 'thanks');
        assert.match(res.headers['content-security-policy'], /^sandbox/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    test('keeps only the newest MAX_REQUESTS_PER_BIN requests', async () => {
        const { bin } = await createBin();
        for (let i = 0; i < 8; i++) await request(app).get(`/b/${bin.id}/n${i}`);
        const list = await admin(request(app).get(`/api/bins/${bin.id}/requests`));
        assert.equal(list.body.total, 5);
        assert.equal(list.body.requests[0].path, '/n7');
        assert.equal(list.body.requests[4].path, '/n3');
    });

    test('filters by method and searches bodies', async () => {
        const { bin } = await createBin();
        await request(app).post(`/b/${bin.id}`).set('Content-Type', 'text/plain').send('needle in body');
        await request(app).get(`/b/${bin.id}`);
        const byMethod = await admin(request(app).get(`/api/bins/${bin.id}/requests?method=get`));
        assert.equal(byMethod.body.total, 1);
        const bySearch = await admin(request(app).get(`/api/bins/${bin.id}/requests?search=NEEDLE`));
        assert.equal(bySearch.body.total, 1);
    });

    test('clears a bin', async () => {
        const { bin } = await createBin();
        await request(app).get(`/b/${bin.id}`);
        const res = await admin(request(app).delete(`/api/bins/${bin.id}/requests`));
        assert.equal(res.body.deleted, 1);
    });
});

describe('live stream', () => {
    test('pushes newly captured requests over SSE', async () => {
        const { bin } = await createBin();
        const server = app.listen(0);
        const { port } = server.address();
        try {
            const event = await new Promise((resolve, reject) => {
                const req = http.get(
                    { port, path: `/api/bins/${bin.id}/stream`, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
                    res => {
                        assert.match(res.headers['content-type'], /^text\/event-stream/);
                        let buffer = '';
                        res.on('data', chunk => {
                            buffer += chunk;
                            const match = buffer.match(/event: request\ndata: (.+)\n\n/);
                            if (match) {
                                req.destroy();
                                resolve(JSON.parse(match[1]));
                            }
                        });
                        // Once the stream is open, send a request to the bin
                        setTimeout(() => request(server).post(`/b/${bin.id}/live`).send('x').catch(reject), 50);
                    }
                );
                req.on('error', reject);
                setTimeout(() => reject(new Error('timed out waiting for SSE event')), 3000);
            });
            assert.equal(event.path, '/live');
            assert.equal(event.binId, bin.id);
        } finally {
            server.close();
        }
    });
});

describe('dashboard', () => {
    test('redirects to login without a session', async () => {
        const res = await request(app).get('/');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/login.html');
    });

    test('login sets a strict HttpOnly cookie that opens the dashboard', async () => {
        const login = await request(app).post('/auth/login').send({ password: ADMIN_PASSWORD });
        assert.equal(login.status, 200);
        const cookie = login.headers['set-cookie'][0];
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        const res = await request(app).get('/').set('Cookie', cookie.split(';')[0]);
        assert.equal(res.status, 200);
        assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    });

    test('cookie-authenticated writes need X-Requested-With (CSRF)', async () => {
        const login = await request(app).post('/auth/login').send({ password: ADMIN_PASSWORD });
        const cookie = login.headers['set-cookie'][0].split(';')[0];
        assert.equal((await request(app).post('/api/bins').set('Cookie', cookie).send({})).status, 403);
        const ok = await request(app).post('/api/bins').set('Cookie', cookie).set('X-Requested-With', 'fetch').send({});
        assert.equal(ok.status, 201);
    });

    test('health check is public', async () => {
        assert.equal((await request(app).get('/health')).body.status, 'ok');
    });
});
