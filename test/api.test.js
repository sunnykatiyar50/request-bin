const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-logs-'));

const request = require('supertest');
const { loadConfig } = require('../src/config');
const initializeDatabase = require('../src/database/initDatabase');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');

const ADMIN_TOKEN = 'admin-token-0123456789';
const ADMIN_PASSWORD = 'correct horse battery staple';
const env = {
    ADMIN_USERNAME: 'opsadmin',
    ADMIN_PASSWORD,
    ADMIN_TOKEN,
    SESSION_SECRET: 'x'.repeat(48),
    MAX_BODY_KB: '4',
    MAX_REQUESTS_PER_BIN: '5',
};

let db;
let app;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

async function createBin(body = {}) {
    const res = await admin(request(app).post('/api/bins')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
}

async function latestIn(binId) {
    const res = await admin(request(app).get(`/api/requests/latest?bin=${binId}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

before(async () => {
    db = await initializeDatabase();
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

describe('config', () => {
    test('refuses to start without auth settings', () => {
        assert.throws(() => loadConfig({}), /Invalid auth configuration/);
    });

    test('AUTH_DISABLED skips the auth requirements', () => {
        assert.equal(loadConfig({ AUTH_DISABLED: 'true' }).authDisabled, true);
    });

    test('rejects sample.env placeholders', () => {
        assert.throws(() => loadConfig({ ...env, ADMIN_PASSWORD: 'change-me' }), /placeholder/);
    });

    test('defaults', () => {
        const config = loadConfig({ ...env, MAX_BODY_KB: '', MAX_REQUESTS_PER_BIN: '' });
        assert.equal(config.port, 30002);
        assert.equal(config.maxBodyBytes, 1024 * 1024);
        assert.equal(config.maxRequestsPerBin, 500);
        assert.equal(config.retentionDays, 7);
    });

    test('caps MAX_BODY_KB at what the database can store', () => {
        assert.equal(loadConfig({ ...env, MAX_BODY_KB: '999999' }).maxBodyBytes, 16 * 1024 * 1024);
    });
});

describe('bins', () => {
    test('need authentication', async () => {
        assert.equal((await request(app).get('/api/bins')).status, 401);
        assert.equal((await request(app).post('/api/bins').send({})).status, 401);
    });

    test('create, list, update and delete', async () => {
        const { bin } = await createBin({ name: 'Stripe webhooks' });
        assert.match(bin.id, /^[0-9a-f]{16}$/);
        assert.equal(bin.hasSecret, false);

        const list = await admin(request(app).get('/api/bins'));
        const listed = list.body.bins.find(b => b.id === bin.id);
        assert.equal(listed.requestCount, 0);
        assert.equal(listed.lastRequestAt, null);

        const updated = await admin(request(app).patch(`/api/bins/${bin.id}`)).send({ responseStatus: 202, name: 'Renamed' });
        assert.equal(updated.body.responseStatus, 202);
        assert.equal(updated.body.name, 'Renamed');

        assert.equal((await admin(request(app).delete(`/api/bins/${bin.id}`))).status, 200);
        assert.equal((await admin(request(app).get(`/api/bins/${bin.id}`))).status, 404);
    });

    test('deleting a bin deletes its requests', async () => {
        const { bin } = await createBin();
        const { body } = await request(app).post(`/b/${bin.id}`).send('x');
        assert.ok(body);
        const before = await latestIn(bin.id);
        await admin(request(app).delete(`/api/bins/${bin.id}`));
        assert.equal((await admin(request(app).get(`/api/requests/${before.id}`))).status, 404);
    });

    test('validates settings', async () => {
        const res = await admin(request(app).post('/api/bins')).send({ responseStatus: 99, responseContentType: 'image/png', name: '' });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.responseStatus);
        assert.ok(res.body.details.responseContentType);
        assert.ok(res.body.details.name);
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
        assert.equal(res.text, '{"ok":true}');

        const detail = await latestIn(bin.id);
        assert.equal(detail.method, 'POST');
        assert.equal(detail.path, '/orders/42');
        assert.equal(detail.queryString, 'expand=items&x=1');
        assert.deepEqual(detail.query, [{ name: 'expand', value: 'items' }, { name: 'x', value: '1' }]);
        assert.equal(detail.headers['x-custom'], 'hello');
        assert.equal(detail.contentType, 'application/json');
        assert.equal(detail.body, '{"event":"order.created"}');
        assert.equal(detail.bodyEncoding, 'utf8');
        assert.equal(detail.binName, bin.name);
    });

    test('captures any method, including the bin root', async () => {
        const { bin } = await createBin();
        await request(app).put(`/b/${bin.id}`).send('x');
        await request(app).delete(`/b/${bin.id}/a/b/c`);
        const list = await admin(request(app).get(`/api/requests?bin=${bin.id}`));
        assert.deepEqual(list.body.requests.map(r => `${r.method} ${r.path}`), ['DELETE /a/b/c', 'PUT /']);
    });

    test('stores binary bodies exactly, returned as base64', async () => {
        const { bin } = await createBin();
        const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x10]);
        await request(app).post(`/b/${bin.id}`).set('Content-Type', 'application/octet-stream').send(bytes);
        const detail = await latestIn(bin.id);
        assert.equal(detail.bodyEncoding, 'base64');
        assert.equal(detail.body, bytes.toString('base64'));
        assert.equal(detail.bodySize, 4);
    });

    test('redacts sensitive headers by default, keeps them when redaction is off', async () => {
        const { bin } = await createBin();
        await request(app).get(`/b/${bin.id}`).set('Authorization', 'Bearer real-token').set('Cookie', 'a=b');
        const redacted = await latestIn(bin.id);
        assert.equal(redacted.headers.authorization, '[redacted]');
        assert.equal(redacted.headers.cookie, '[redacted]');

        const { bin: open } = await createBin({ redactHeaders: false });
        await request(app).get(`/b/${open.id}`).set('Authorization', 'Bearer real-token');
        assert.equal((await latestIn(open.id)).headers.authorization, 'Bearer real-token');
    });

    test('rejects bodies over MAX_BODY_KB', async () => {
        const { bin } = await createBin();
        const res = await request(app).post(`/b/${bin.id}`).set('Content-Type', 'text/plain').send('a'.repeat(5000));
        assert.equal(res.status, 413);
    });

    test('returns 404 for unknown bins', async () => {
        assert.equal((await request(app).get('/b/0000000000000000')).status, 404);
        assert.equal((await request(app).get('/b/not-a-bin')).status, 404);
    });

    test('serves the configured response inside a sandbox CSP', async () => {
        const { bin } = await createBin({ responseStatus: 201, responseContentType: 'text/html', responseBody: '<script>alert(1)</script>' });
        const res = await request(app).post(`/b/${bin.id}`);
        assert.equal(res.status, 201);
        assert.equal(res.text, '<script>alert(1)</script>');
        assert.match(res.headers['content-security-policy'], /^sandbox/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    test('keeps only the newest MAX_REQUESTS_PER_BIN requests', async () => {
        const { bin } = await createBin();
        for (let i = 0; i < 8; i++) await request(app).get(`/b/${bin.id}/n${i}`);
        const list = await admin(request(app).get(`/api/requests?bin=${bin.id}`));
        assert.equal(list.body.total, 5);
        assert.equal(list.body.requests[0].path, '/n7');
        assert.equal(list.body.requests[4].path, '/n3');
    });
});

describe('bin secrets', () => {
    test('enforced via header or ?secret=, which is redacted from the stored query', async () => {
        const { bin, secret } = await createBin({ withSecret: true });
        assert.ok(secret);
        assert.equal(bin.hasSecret, true);
        assert.equal((await request(app).post(`/b/${bin.id}`)).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('X-Bin-Secret', 'wrong')).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('X-Bin-Secret', secret)).status, 200);
        assert.equal((await request(app).post(`/b/${bin.id}?secret=${secret}&a=1`)).status, 200);
        const detail = await latestIn(bin.id);
        assert.deepEqual(detail.query, [{ name: 'secret', value: '[redacted]' }, { name: 'a', value: '1' }]);
    });

    test('can be shown again, rotated and removed', async () => {
        const { bin, secret } = await createBin({ withSecret: true });
        const shown = await admin(request(app).post(`/api/bins/${bin.id}/secret/reveal`));
        assert.equal(shown.body.secret, secret);
        assert.equal(shown.headers['cache-control'], 'no-store');

        const rotated = await admin(request(app).post(`/api/bins/${bin.id}/secret`));
        assert.notEqual(rotated.body.secret, secret);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('X-Bin-Secret', secret)).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('X-Bin-Secret', rotated.body.secret)).status, 200);

        await admin(request(app).delete(`/api/bins/${bin.id}/secret`));
        assert.equal((await request(app).post(`/b/${bin.id}`)).status, 200);
        assert.equal((await admin(request(app).post(`/api/bins/${bin.id}/secret/reveal`))).status, 404);
    });

    test('is stored only as a hash and an encrypted copy', async () => {
        const { bin, secret } = await createBin({ withSecret: true });
        const [row] = await db.all('SELECT * FROM bins WHERE id = ?', [bin.id]);
        assert.equal(Object.values(row).some(v => String(v).includes(secret)), false);
    });
});

describe('reading requests', () => {
    test('needs authentication', async () => {
        assert.equal((await request(app).get('/api/requests')).status, 401);
        assert.equal((await request(app).get('/api/requests/latest')).status, 401);
    });

    test('filters by bin and method, searches path, headers and body', async () => {
        const { bin } = await createBin();
        await request(app).post(`/b/${bin.id}/hooks`).set('Content-Type', 'text/plain').send('needle in body');
        await request(app).get(`/b/${bin.id}/other`).set('X-Trace', 'HeaderNeedle');
        const base = `/api/requests?bin=${bin.id}`;
        assert.equal((await admin(request(app).get(`${base}&method=get`))).body.total, 1);
        assert.equal((await admin(request(app).get(`${base}&search=NEEDLE IN`))).body.total, 1);
        assert.equal((await admin(request(app).get(`${base}&search=headerneedle`))).body.total, 1);
        assert.equal((await admin(request(app).get(`${base}&search=/hooks`))).body.total, 1);
    });

    test('filters by time', async () => {
        const { bin } = await createBin();
        await request(app).get(`/b/${bin.id}`);
        const soon = new Date(Date.now() + 60000).toISOString();
        assert.equal((await admin(request(app).get(`/api/requests?bin=${bin.id}&from=${soon}`))).body.total, 0);
        assert.equal((await admin(request(app).get(`/api/requests?bin=${bin.id}&startDate=2000-01-01`))).body.total, 1);
    });

    test('validates query parameters', async () => {
        assert.equal((await admin(request(app).get('/api/requests?pageSize=1000'))).status, 400);
        assert.equal((await admin(request(app).get('/api/requests?bin=nope'))).status, 400);
        assert.equal((await admin(request(app).get('/api/requests?method=FETCH'))).status, 400);
    });

    test('latest returns 404 when nothing matches', async () => {
        const { bin } = await createBin();
        assert.equal((await admin(request(app).get(`/api/requests/latest?bin=${bin.id}`))).status, 404);
    });

    test('deletes one, several, or all requests in a bin', async () => {
        const { bin } = await createBin();
        for (let i = 0; i < 4; i++) await request(app).get(`/b/${bin.id}/${i}`);
        const ids = (await admin(request(app).get(`/api/requests?bin=${bin.id}`))).body.requests.map(r => r.id);
        assert.equal((await admin(request(app).delete(`/api/requests/${ids[0]}`))).status, 200);
        assert.equal((await admin(request(app).delete(`/api/requests/${ids[0]}`))).status, 404);
        assert.equal((await admin(request(app).delete('/api/requests')).send({ ids: [ids[1], ids[2]] })).body.deleted, 2);
        assert.equal((await admin(request(app).delete(`/api/bins/${bin.id}/requests`))).body.deleted, 1);
    });
});

describe('live stream', () => {
    test('pushes newly captured requests over SSE, filtered by bin', async () => {
        const { bin } = await createBin();
        const { bin: other } = await createBin();
        const server = app.listen(0);
        const { port } = server.address();
        try {
            const event = await new Promise((resolve, reject) => {
                const req = http.get(
                    { port, path: `/api/stream?bin=${bin.id}`, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
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
                        // A request to another bin first (filtered out), then one to this bin
                        setTimeout(async () => {
                            try {
                                await request(server).post(`/b/${other.id}/ignored`).send('x');
                                await request(server).post(`/b/${bin.id}/live`).send('x');
                            } catch (error) {
                                reject(error);
                            }
                        }, 50);
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

describe('dashboard and server', () => {
    async function login() {
        const res = await request(app).post('/auth/login').send({ username: 'opsadmin', password: ADMIN_PASSWORD });
        assert.equal(res.status, 200);
        const cookie = res.headers['set-cookie'][0];
        assert.match(cookie, /^rb_session=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        return cookie.split(';')[0];
    }

    test('redirects the dashboard to the login page without a session', async () => {
        const res = await request(app).get('/');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, '/login.html');
    });

    test('serves the dashboard with a session, with a strict CSP', async () => {
        const res = await request(app).get('/').set('Cookie', await login());
        assert.equal(res.status, 200);
        assert.match(res.text, /Request Bin/);
        assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    });

    test('rejects a wrong password', async () => {
        assert.equal((await request(app).post('/auth/login').send({ username: 'opsadmin', password: 'nope' })).status, 401);
    });

    test('cookie-authenticated writes need X-Requested-With (CSRF)', async () => {
        const cookie = await login();
        assert.equal((await request(app).post('/api/bins').set('Cookie', cookie).send({})).status, 403);
        const ok = await request(app).post('/api/bins').set('Cookie', cookie).set('X-Requested-With', 'fetch').send({});
        assert.equal(ok.status, 201);
    });

    test('health check is public', async () => {
        assert.equal((await request(app).get('/health')).body.status, 'ok');
    });

    test('unknown API routes return JSON 404', async () => {
        const res = await admin(request(app).get('/api/nope'));
        assert.equal(res.status, 404);
        assert.equal(res.body.error, 'Not found');
    });
});
