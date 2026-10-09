const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { setupTestEnv, openTestDatabase } = require('./helpers/database');
setupTestEnv('api');

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
        const res = await admin(request(app).post('/api/bins')).send({
            responseStatus: 99, responseContentType: 'image/png', name: '', responseTemplate: 'yes', responseDelayMs: 60000,
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.details.responseStatus);
        assert.ok(res.body.details.responseContentType);
        assert.ok(res.body.details.name);
        assert.ok(res.body.details.responseTemplate);
        assert.ok(res.body.details.responseDelayMs);
    });

    test('adds the template and delay columns to a database created before them', async () => {
        const { bin } = await createBin({ responseTemplate: true, responseDelayMs: 50 });
        // Back to the earlier schema, then connect again as a newer version starting up would
        for (const column of ['response_template', 'response_delay_ms']) await db.run(`ALTER TABLE bins DROP COLUMN ${column}`);
        const upgraded = await initializeDatabase();
        try {
            const after = await new BinModel(upgraded, { encryptionSecret: 'x'.repeat(48) }).get(bin.id);
            assert.equal(after.responseTemplate, false);
            assert.equal(after.responseDelayMs, 0);
        } finally {
            await upgraded.close();
        }
        // Connecting again finds the columns already there
        await (await initializeDatabase()).close();
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

    test('fills response templates from the request', async () => {
        const { bin } = await createBin({
            responseTemplate: true,
            responseBody: '{"echo": "{{body.name}}", "attempt": {{query.attempt | 1}}, "id": {{id}}, "via": "{{method}} {{path}}"}',
        });
        const res = await request(app).post(`/b/${bin.id}/hook?attempt=3`).set('Content-Type', 'application/json').send({ name: 'Say "hi"' });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.text);
        assert.equal(body.echo, 'Say "hi"');
        assert.equal(body.attempt, 3);
        assert.equal(body.via, 'POST /hook');
        assert.equal(body.id, (await latestIn(bin.id)).id);
    });

    test('serves the body as written when templating is off', async () => {
        const { bin } = await createBin({ responseBody: '{"m": "{{method}}"}' });
        assert.equal((await request(app).get(`/b/${bin.id}`)).text, '{"m": "{{method}}"}');
    });

    test('templates see redacted header values', async () => {
        const { bin } = await createBin({ responseTemplate: true, responseContentType: 'text/plain', responseBody: '{{header.authorization}}' });
        const res = await request(app).get(`/b/${bin.id}`).set('Authorization', 'Bearer real-token');
        assert.equal(res.text, '[redacted]');
    });

    test('delays the response, with the request already stored', async () => {
        const { bin } = await createBin({ responseDelayMs: 300 });
        const started = Date.now();
        const pending = request(app).post(`/b/${bin.id}/slow`).send('x').then(res => res); // .then() sends it now
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal((await latestIn(bin.id)).path, '/slow');
        const res = await pending;
        assert.equal(res.status, 200);
        assert.ok(Date.now() - started >= 290, `answered after ${Date.now() - started} ms`);
    });
});

describe('export', () => {
    test('needs authentication', async () => {
        assert.equal((await request(app).get('/api/requests/export')).status, 401);
    });

    test('exports a bin as HAR, oldest first', async () => {
        const { bin } = await createBin({ name: 'Export me' });
        await request(app).post(`/b/${bin.id}/first?a=1&b=two`).set('Content-Type', 'application/x-www-form-urlencoded').send('x=1&y=2');
        await request(app).post(`/b/${bin.id}`).set('Content-Type', 'application/octet-stream').send(Buffer.from([0, 255, 1]));
        await request(app).get(`/b/${bin.id}/third`);

        const res = await admin(request(app).get(`/api/requests/export?bin=${bin.id}`));
        assert.equal(res.status, 200);
        assert.match(res.headers['content-disposition'], new RegExp(`attachment; filename="request-bin-${bin.id}-\\d{8}-\\d{6}\\.har"`));
        const { log } = res.body;
        assert.equal(log.version, '1.2');
        assert.equal(log.creator.name, 'Request Bin');
        assert.equal(log.entries.length, 3);

        const [first, second, third] = log.entries;
        assert.match(first.request.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/b/${bin.id}/first\\?a=1&b=two$`));
        assert.deepEqual(first.request.queryString, [{ name: 'a', value: '1' }, { name: 'b', value: 'two' }]);
        assert.equal(first.request.postData.text, 'x=1&y=2');
        assert.deepEqual(first.request.postData.params, [{ name: 'x', value: '1' }, { name: 'y', value: '2' }]);
        assert.ok(first.request.headers.some(h => h.name === 'content-type'));
        assert.match(first.comment, /Export me/);
        assert.equal(second.request.url.endsWith(`/b/${bin.id}`), true);
        assert.deepEqual(second.request.postData, { mimeType: 'application/octet-stream', text: 'AP8B', encoding: 'base64' });
        assert.equal(third.request.postData, undefined);
        assert.equal(third.response.status, 0);
    });

    test('exports selected requests as JSON', async () => {
        const { bin } = await createBin();
        for (const p of ['/a', '/b', '/c']) await request(app).put(`/b/${bin.id}${p}`).send('body');
        const list = await admin(request(app).get(`/api/requests?bin=${bin.id}`));
        const ids = list.body.requests.filter(r => r.path !== '/b').map(r => r.id);

        const res = await admin(request(app).get(`/api/requests/export?format=json&ids=${ids.join(',')}`));
        assert.equal(res.status, 200);
        assert.match(res.headers['content-disposition'], /\.json"$/);
        assert.equal(res.body.count, 2);
        assert.equal(res.body.truncated, false);
        assert.deepEqual(res.body.requests.map(r => r.path), ['/a', '/c']);
        assert.equal(res.body.requests[0].body, 'body');
    });

    test('returns an empty log when nothing matches, and validates its options', async () => {
        const { bin } = await createBin();
        await request(app).get(`/b/${bin.id}`);
        const empty = await admin(request(app).get('/api/requests/export?search=nothing-matches-this'));
        assert.equal(empty.body.log.entries.length, 0);

        const bad = await admin(request(app).get('/api/requests/export?format=csv&ids=1,x'));
        assert.equal(bad.status, 400);
        assert.ok(bad.body.details.format);
        assert.ok(bad.body.details.ids);
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

    test('accepted as a Bearer token, which is always redacted', async () => {
        const { bin, secret } = await createBin({ withSecret: true, redactHeaders: false });
        assert.equal((await request(app).post(`/b/${bin.id}`).set('Authorization', 'Bearer wrong')).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('Authorization', `Basic ${secret}`)).status, 401);
        assert.equal((await request(app).post(`/b/${bin.id}`).set('Authorization', `bearer \t ${secret} `)).status, 200);
        assert.equal((await latestIn(bin.id)).headers.authorization, '[redacted]');
    });

    test('any one of the header, Bearer token or ?secret= will do', async () => {
        const { bin, secret } = await createBin({ withSecret: true, redactHeaders: false });
        // The sender's own token in Authorization, the bin secret in X-Bin-Secret
        const res = await request(app).post(`/b/${bin.id}?secret=wrong`)
            .set('Authorization', 'Bearer sender-token').set('X-Bin-Secret', secret);
        assert.equal(res.status, 200);
        const detail = await latestIn(bin.id);
        assert.equal(detail.headers.authorization, 'Bearer sender-token');
        assert.equal(detail.headers['x-bin-secret'], '[redacted]');
        assert.deepEqual(detail.query, [{ name: 'secret', value: '[redacted]' }]);
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
    test('accepts ADMIN_TOKEN with any Bearer spacing and case', async () => {
        for (const header of [`bearer ${ADMIN_TOKEN}`, `BEARER  ${ADMIN_TOKEN}`, `Bearer\t${ADMIN_TOKEN} `]) {
            assert.equal((await request(app).get('/api/bins').set('Authorization', header)).status, 200, header);
        }
        for (const header of [`Bearer${ADMIN_TOKEN}`, `Bearer ${ADMIN_TOKEN} extra`, `Token ${ADMIN_TOKEN}`]) {
            assert.equal((await request(app).get('/api/bins').set('Authorization', header)).status, 401, header);
        }
    });

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
