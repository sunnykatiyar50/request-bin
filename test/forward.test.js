const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { setupTestEnv, openTestDatabase } = require('./helpers/database');
setupTestEnv('forward');

const request = require('supertest');
const { loadConfig } = require('../src/config');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');

const ADMIN_TOKEN = 'admin-token-0123456789';
const baseEnv = {
    ADMIN_PASSWORD: 'correct horse battery staple',
    ADMIN_TOKEN,
    SESSION_SECRET: 'x'.repeat(48),
};

let db;
let app; // forwarding to the test target
let appOff; // forwarding switched off
let target;
let targetUrl;
let closedUrl;
let received;
let respond;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, what, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await sleep(25);
    }
}

async function createBin(body = {}, theApp = app) {
    const res = await admin(request(theApp).post('/api/bins')).send(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.bin;
}

const forwardTo = (path = '/hook', extra = {}) => ({ enabled: true, url: `${targetUrl}${path}`, ...extra });

async function latestIn(binId) {
    const res = await admin(request(app).get(`/api/requests/latest?bin=${binId}`));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

// The request once its forward outcome has been recorded
const forwardedRequest = binId => waitFor(async () => {
    const detail = await latestIn(binId);
    return detail.forward ? detail : null;
}, 'the forward result');

before(async () => {
    target = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            respond(req, res);
        });
    });
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    targetUrl = `http://127.0.0.1:${target.address().port}`;

    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    closedUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise(resolve => closed.close(resolve));

    db = await openTestDatabase();
    const models = config => ({
        config,
        binModel: new BinModel(db, { encryptionSecret: config.sessionSecret }),
        requestModel: new RequestModel(db, { maxRequestsPerBin: 100 }),
        apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
    });
    app = createApp(models(loadConfig({
        ...baseEnv,
        FORWARD_ALLOWED_HOSTS: `${new URL(targetUrl).host},${new URL(closedUrl).host}`,
        FORWARD_TIMEOUT_MS: '2000',
    })));
    appOff = createApp(models(loadConfig(baseEnv)));
});

after(async () => {
    await new Promise(resolve => target.close(resolve));
    await db.close();
});

const reset = (fn = (req, res) => res.end('{"target":"ok"}')) => {
    received = [];
    respond = fn;
};

describe('forwarding settings', () => {
    test('are saved with the bin', async () => {
        const bin = await createBin({ forwardConfig: forwardTo('/hook', { methods: ['post', 'PUT', 'POST'] }) });
        assert.deepEqual(bin.forwardConfig, { enabled: true, url: `${targetUrl}/hook`, methods: ['POST', 'PUT'] });
        assert.deepEqual((await createBin()).forwardConfig, { enabled: false, url: '', methods: [] });
    });

    test('can be removed with null, or switched off while keeping the URL', async () => {
        const bin = await createBin({ forwardConfig: forwardTo() });
        const off = await admin(request(app).patch(`/api/bins/${bin.id}`)).send({ forwardConfig: { enabled: false, url: `${targetUrl}/hook` } });
        assert.deepEqual(off.body.forwardConfig, { enabled: false, url: `${targetUrl}/hook`, methods: [] });
        const removed = await admin(request(app).patch(`/api/bins/${bin.id}`)).send({ forwardConfig: null });
        assert.deepEqual(removed.body.forwardConfig, { enabled: false, url: '', methods: [] });
    });

    test('are validated', async () => {
        const bad = async (forwardConfig, field) => {
            const res = await admin(request(app).post('/api/bins')).send({ forwardConfig });
            assert.equal(res.status, 400, JSON.stringify(forwardConfig));
            assert.ok(field in res.body.details, JSON.stringify(res.body.details));
        };
        await bad('nope', 'forwardConfig');
        await bad({ enabled: 'yes' }, 'forwardConfig.enabled');
        await bad({ enabled: true }, 'forwardConfig.url');
        await bad({ enabled: true, url: 'not a url' }, 'forwardConfig.url');
        await bad({ enabled: true, url: 'ftp://example.com/' }, 'forwardConfig.url');
        await bad({ enabled: true, url: `http://user:pw@${new URL(targetUrl).host}/` }, 'forwardConfig.url');
        await bad({ url: 'x'.repeat(3000) }, 'forwardConfig.url');
        await bad({ methods: ['FETCH'] }, 'forwardConfig.methods');
        await bad({ methods: 'POST' }, 'forwardConfig.methods');
    });

    test('cannot point at a host the server does not allow', async () => {
        const res = await admin(request(app).post('/api/bins')).send({ forwardConfig: { enabled: true, url: 'http://169.254.169.254/latest/' } });
        assert.equal(res.status, 400);
        assert.match(res.body.details['forwardConfig.url'], /not in FORWARD_ALLOWED_HOSTS/);
        const other = await admin(request(app).post('/api/bins')).send({ forwardConfig: { enabled: true, url: 'https://example.com/' } });
        assert.equal(other.status, 400);
    });

    test('cannot be switched on when forwarding is switched off on the server', async () => {
        const res = await admin(request(appOff).post('/api/bins')).send({ forwardConfig: forwardTo() });
        assert.equal(res.status, 400);
        assert.match(res.body.details['forwardConfig.url'], /switched off/);
        // a disabled setting is just stored
        assert.equal((await admin(request(appOff).post('/api/bins')).send({ forwardConfig: { enabled: false, url: '' } })).status, 201);
    });

    test('hide the URL from anyone but an admin, since it can carry a token', async () => {
        const bin = await createBin({ forwardConfig: forwardTo('/hook?token=secret') });
        const key = (await admin(request(app).post('/api/keys')).send({ name: `fwd-${Date.now()}` })).body.secret;
        assert.ok(key);
        const asKey = await request(app).get(`/api/bins/${bin.id}`).set('Authorization', `Bearer ${key}`);
        assert.equal(asKey.status, 200);
        assert.deepEqual(asKey.body.forwardConfig, { enabled: true, url: '[hidden]', methods: [] });
        const list = await request(app).get('/api/bins').set('X-API-Key', key);
        assert.equal(list.body.bins.find(b => b.id === bin.id).forwardConfig.url, '[hidden]');
        assert.equal((await admin(request(app).get(`/api/bins/${bin.id}`))).body.forwardConfig.url, `${targetUrl}/hook?token=secret`);
    });

    test('can only be changed by an admin', async () => {
        const bin = await createBin();
        assert.equal((await request(app).patch(`/api/bins/${bin.id}`).send({ forwardConfig: forwardTo() })).status, 401);
    });
});

describe('automatic forwarding', () => {
    test('passes the request on exactly as sent, minus redacted headers, and records the outcome', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo('/hook') });
        const bytes = Buffer.from([0, 255, 1, 128, 42]);
        const res = await request(app)
            .post(`/b/${bin.id}/some/path?a=1`)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Custom', 'hello')
            .set('Authorization', 'Bearer sender-token')
            .send(bytes);
        assert.equal(res.status, 200);

        const detail = await forwardedRequest(bin.id);
        assert.deepEqual(detail.forward, {
            target: `${targetUrl}/hook`,
            status: 200,
            statusText: 'OK',
            durationMs: detail.forward.durationMs,
        });
        assert.equal(typeof detail.forward.durationMs, 'number');

        assert.equal(received.length, 1);
        const [got] = received;
        assert.equal(got.method, 'POST');
        assert.equal(got.url, '/hook'); // the configured URL exactly: no sub-path, no query
        assert.deepEqual(got.body, bytes);
        assert.equal(got.headers['content-type'], 'application/octet-stream');
        assert.equal(got.headers['x-custom'], 'hello');
        assert.equal(got.headers.authorization, undefined); // stored as [redacted]: the real value is gone
        assert.equal(got.headers['x-forwarded-by'], 'request-bin');
        assert.equal(got.headers['x-request-bin-id'], bin.id);
        assert.equal(got.headers['x-request-bin-hops'], '1');
    });

    test('passes the real Authorization header when the bin does not redact', async () => {
        reset();
        const bin = await createBin({ redactHeaders: false, forwardConfig: forwardTo() });
        await request(app).post(`/b/${bin.id}`).set('Authorization', 'Bearer sender-token').send('x');
        await forwardedRequest(bin.id);
        assert.equal(received[0].headers.authorization, 'Bearer sender-token');
    });

    test('records the target without its query string, which may carry a token', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo('/hook?token=abc') });
        await request(app).post(`/b/${bin.id}`).send('x');
        const detail = await forwardedRequest(bin.id);
        assert.equal(detail.forward.target, `${targetUrl}/hook`);
        assert.equal(received[0].url, '/hook?token=abc');
    });

    test('does not change the answer the sender gets, whatever the target says', async () => {
        reset((req, res) => {
            res.statusCode = 500;
            res.end('boom');
        });
        const bin = await createBin({ responseStatus: 202, responseBody: '{"mine":true}', forwardConfig: forwardTo() });
        const res = await request(app).post(`/b/${bin.id}`).send('x');
        assert.equal(res.status, 202);
        assert.equal(res.text, '{"mine":true}');
        assert.equal((await forwardedRequest(bin.id)).forward.status, 500);
    });

    test('records an error when the target cannot be reached', async () => {
        reset();
        const bin = await createBin({ forwardConfig: { enabled: true, url: `${closedUrl}/hook` } });
        const res = await request(app).post(`/b/${bin.id}`).send('x');
        assert.equal(res.status, 200);
        const detail = await forwardedRequest(bin.id);
        assert.equal(detail.forward.target, `${closedUrl}/hook`);
        assert.match(detail.forward.error, /ECONNREFUSED/);
        assert.equal(detail.forward.status, undefined);
    });

    test('records an error when the target is too slow', async () => {
        reset(() => {}); // never answers
        const bin = await createBin({ forwardConfig: forwardTo() });
        await request(app).post(`/b/${bin.id}`).send('x');
        const detail = await waitFor(async () => (await latestIn(bin.id)).forward, 'the timeout', 5000).then(() => latestIn(bin.id));
        assert.match(detail.forward.error, /Timed out after 2000 ms/);
    });

    test('only forwards the chosen methods', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo('/hook', { methods: ['POST'] }) });
        await request(app).get(`/b/${bin.id}`);
        await sleep(200);
        assert.equal(received.length, 0);
        assert.equal((await latestIn(bin.id)).forward, null);
        await request(app).post(`/b/${bin.id}`).send('x');
        await forwardedRequest(bin.id);
        assert.equal(received.length, 1);
    });

    test('does not forward when switched off, or for bins without forwarding', async () => {
        reset();
        const off = await createBin({ forwardConfig: { enabled: false, url: `${targetUrl}/hook` } });
        const plain = await createBin();
        await request(app).post(`/b/${off.id}`).send('x');
        await request(app).post(`/b/${plain.id}`).send('x');
        await sleep(200);
        assert.equal(received.length, 0);
    });

    test('stops a request that has been forwarded too many times (a loop)', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo() });
        await request(app).post(`/b/${bin.id}`).set('X-Request-Bin-Hops', '3').send('x');
        const detail = await forwardedRequest(bin.id);
        assert.match(detail.forward.error, /too many times/);
        assert.equal(received.length, 0);

        await request(app).post(`/b/${bin.id}`).set('X-Request-Bin-Hops', '2').send('x');
        await waitFor(async () => received.length === 1, 'a forward with 2 hops');
        assert.equal(received[0].headers['x-request-bin-hops'], '3');
    });

    test('is refused at forward time if the target is no longer allowed', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo() });
        // the same database, read by an app whose allowlist no longer includes the target
        const strict = createApp({
            config: loadConfig({ ...baseEnv, FORWARD_ALLOWED_HOSTS: 'elsewhere.example.com' }),
            binModel: new BinModel(db, { encryptionSecret: baseEnv.SESSION_SECRET }),
            requestModel: new RequestModel(db, { maxRequestsPerBin: 100 }),
            apiKeyModel: new ApiKeyModel(db, { encryptionSecret: baseEnv.SESSION_SECRET }),
        });
        assert.equal((await request(strict).post(`/b/${bin.id}`).send('x')).status, 200);
        const detail = await waitFor(async () => {
            const d = (await admin(request(strict).get(`/api/requests/latest?bin=${bin.id}`))).body;
            return d.forward ? d : null;
        }, 'the refusal');
        assert.match(detail.forward.error, /not in FORWARD_ALLOWED_HOSTS/);
        assert.equal(received.length, 0);
    });

    test('forward results appear in the JSON export', async () => {
        reset();
        const bin = await createBin({ forwardConfig: forwardTo() });
        await request(app).post(`/b/${bin.id}`).send('x');
        await forwardedRequest(bin.id);
        const json = await admin(request(app).get(`/api/requests/export?bin=${bin.id}&format=json`));
        assert.equal(json.body.requests[0].forward.status, 200);
    });
});

describe('replay', () => {
    async function captured(body = '{"event":"order.created"}', headers = {}) {
        const bin = await createBin();
        let req = request(app).post(`/b/${bin.id}/orders`).set('Content-Type', 'application/json').set('X-Custom', 'hello');
        for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
        await req.send(body);
        return { bin, id: (await latestIn(bin.id)).id };
    }
    const replay = (id, body, theApp = app) => admin(request(theApp).post(`/api/requests/${id}/replay`)).send(body);

    test('sends the captured request to the target and returns its reply', async () => {
        reset((req, res) => {
            res.writeHead(201, { 'Content-Type': 'application/json', 'X-Reply': 'yes' });
            res.end('{"replayed":true}');
        });
        const { bin, id } = await captured();
        const res = await replay(id, { url: `${targetUrl}/again` });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 201);
        assert.equal(res.body.statusText, 'Created');
        assert.equal(res.body.body, '{"replayed":true}');
        assert.equal(res.body.headers['x-reply'], 'yes');
        assert.equal(res.body.truncated, false);
        assert.equal(typeof res.body.durationMs, 'number');

        const [got] = received;
        assert.equal(got.method, 'POST');
        assert.equal(got.url, '/again');
        assert.equal(got.body.toString(), '{"event":"order.created"}');
        assert.equal(got.headers['content-type'], 'application/json');
        assert.equal(got.headers['x-custom'], 'hello');
        assert.equal(got.headers['x-request-bin-id'], bin.id);
    });

    test('can use another method', async () => {
        reset();
        const { id } = await captured();
        assert.equal((await replay(id, { url: `${targetUrl}/x`, method: 'put' })).status, 200);
        assert.equal(received[0].method, 'PUT');
        assert.equal((await replay(id, { url: `${targetUrl}/x`, method: 'FETCH' })).status, 400);
    });

    test('does not replay what was redacted', async () => {
        reset();
        const { id } = await captured('x', { Authorization: 'Bearer sender-token' });
        await replay(id, { url: `${targetUrl}/x` });
        assert.equal(received[0].headers.authorization, undefined);
    });

    test('counts hops, so replaying a forwarded request cannot loop forever', async () => {
        reset();
        const { id } = await captured('x', { 'X-Request-Bin-Hops': '1' });
        await replay(id, { url: `${targetUrl}/x` });
        assert.equal(received[0].headers['x-request-bin-hops'], '2');
    });

    test('reports a target that answers with an error status as a normal reply', async () => {
        reset((req, res) => {
            res.statusCode = 503;
            res.end('down');
        });
        const { id } = await captured();
        const res = await replay(id, { url: `${targetUrl}/x` });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 503);
        assert.equal(res.body.body, 'down');
    });

    test('answers 502 when the target cannot be reached', async () => {
        const { id } = await captured();
        const res = await replay(id, { url: `${closedUrl}/x` });
        assert.equal(res.status, 502);
        assert.match(res.body.error, /ECONNREFUSED/);
    });

    test('refuses targets outside the allowlist', async () => {
        reset();
        const { id } = await captured();
        for (const url of ['https://example.com/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:1/', 'file:///etc/passwd', 'nope']) {
            const res = await replay(id, { url });
            assert.equal(res.status, 400, url);
            assert.ok(res.body.details.url, url);
        }
        assert.equal((await replay(id, {})).status, 400);
        assert.equal((await replay(id, { url: 42 })).status, 400);
        assert.equal(received.length, 0);
    });

    test('is switched off without an allowlist', async () => {
        const { id } = await captured();
        const res = await replay(id, { url: `${targetUrl}/x` }, appOff);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /FORWARD_ALLOWED_HOSTS/);
    });

    test('404 for a request that does not exist', async () => {
        assert.equal((await replay(999999999, { url: `${targetUrl}/x` })).status, 404);
        assert.equal((await replay('abc', { url: `${targetUrl}/x` })).status, 400);
    });

    test('is for admins only', async () => {
        const { id } = await captured();
        assert.equal((await request(app).post(`/api/requests/${id}/replay`).send({ url: `${targetUrl}/x` })).status, 401);
        const key = (await admin(request(app).post('/api/keys')).send({ name: `replay-${Date.now()}` })).body.secret;
        const res = await request(app).post(`/api/requests/${id}/replay`).set('Authorization', `Bearer ${key}`).send({ url: `${targetUrl}/x` });
        assert.equal(res.status, 401); // a Read key is not an admin credential
    });
});
