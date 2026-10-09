const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// A file (or server) database, so a second app instance with a different secret can open the same keys
const { setupTestEnv, openTestDatabase } = require('./helpers/database');
setupTestEnv('keys');

const request = require('supertest');
const { loadConfig } = require('../src/config');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');
const { KEY_PATTERN } = require('../src/utils/apiKeys');

const ADMIN_TOKEN = 'admin-token-0123456789';
const env = { ADMIN_TOKEN, ADMIN_PASSWORD: 'pw-for-tests', SESSION_SECRET: 's'.repeat(48) };

let db;
let app;
let bin;
const admin = r => r.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const createKey = async name => {
    const res = await admin(request(app).post('/api/keys')).send({ name });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
};

function buildApp(overrides = {}) {
    const config = loadConfig({ ...env, ...overrides });
    return createApp({
        config,
        binModel: new BinModel(db, { encryptionSecret: config.sessionSecret }),
        requestModel: new RequestModel(db),
        apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
    });
}

before(async () => {
    db = await openTestDatabase();
    app = buildApp();
    bin = (await admin(request(app).post('/api/bins')).send({ name: 'hooks' })).body.bin;
    await request(app).post(`/b/${bin.id}/event`).set('Content-Type', 'application/json').send('{"id":1}');
});

after(async () => {
    await db.close();
});

describe('managing keys', () => {
    test('creates a Read key (the default and only scope), shows it in full, and lists it without the secret', async () => {
        const { key, secret } = await createKey('ci-tests');
        assert.match(secret, KEY_PATTERN);
        assert.equal(key.scope, 'read');
        assert.equal(key.prefix, secret.slice(0, key.prefix.length));
        const list = await admin(request(app).get('/api/keys'));
        assert.equal(list.headers['cache-control'], 'no-store');
        assert.ok(list.body.keys.find(k => k.name === 'ci-tests'));
        assert.equal(JSON.stringify(list.body).includes(secret), false);
    });

    test('rejects other scopes and duplicate names', async () => {
        assert.equal((await admin(request(app).post('/api/keys')).send({ name: 'x', scope: 'send' })).status, 400);
        await createKey('dupe');
        assert.equal((await admin(request(app).post('/api/keys')).send({ name: 'DUPE' })).status, 400);
    });

    test('reveals a key again, and stores only a hash and an encrypted copy', async () => {
        const { key, secret } = await createKey('reveal-me');
        assert.equal((await admin(request(app).post(`/api/keys/${key.id}/reveal`))).body.secret, secret);
        const [row] = await db.all("SELECT * FROM api_keys WHERE name = 'reveal-me'");
        assert.equal(Object.values(row).some(v => String(v).includes(secret)), false);
    });
});

describe('using a Read key', () => {
    let readKey;
    before(async () => {
        ({ secret: readKey } = await createKey('reader'));
    });
    const asKey = r => r.set('Authorization', `Bearer ${readKey}`);

    test('can list bins and requests and fetch one in full', async () => {
        assert.equal((await asKey(request(app).get('/api/bins'))).status, 200);
        const latest = await asKey(request(app).get(`/api/requests/latest?bin=${bin.id}`));
        assert.equal(latest.status, 200);
        assert.equal(latest.body.body, '{"id":1}');
        assert.equal((await request(app).get('/api/requests').set('X-API-Key', readKey)).status, 200);
    });

    test('is accepted with any Bearer spacing and case', async () => {
        const res = await request(app).get('/api/bins').set('Authorization', `bearer  ${readKey}`);
        assert.equal(res.status, 200);
    });

    test('cannot change anything or manage keys', async () => {
        assert.equal((await asKey(request(app).post('/api/bins')).send({})).status, 401);
        assert.equal((await asKey(request(app).delete(`/api/bins/${bin.id}`))).status, 401);
        assert.equal((await asKey(request(app).delete('/api/requests')).send({ ids: [1] })).status, 401);
        assert.equal((await asKey(request(app).get('/api/keys'))).status, 401);
    });

    test('records when it was last used', async () => {
        await new Promise(r => setTimeout(r, 50));
        const list = await admin(request(app).get('/api/keys'));
        assert.ok(list.body.keys.find(k => k.name === 'reader').lastUsedAt);
    });

    test('stops working once revoked', async () => {
        const { key, secret } = await createKey('to-revoke');
        await admin(request(app).delete(`/api/keys/${key.id}`));
        const res = await request(app).get('/api/requests').set('Authorization', `Bearer ${secret}`);
        assert.equal(res.status, 401);
        assert.match(res.body.error, /revoked/);
        assert.equal((await admin(request(app).post(`/api/keys/${key.id}/reveal`))).status, 410);
    });
});

describe('SESSION_SECRET changes', () => {
    test('keys and bin secrets keep working but can no longer be shown', async () => {
        const { key, secret } = await createKey('survivor');
        const created = await admin(request(app).post('/api/bins')).send({ withSecret: true });
        const other = buildApp({ SESSION_SECRET: 't'.repeat(48) });
        assert.equal((await request(other).get('/api/bins').set('Authorization', `Bearer ${secret}`)).status, 200);
        assert.equal((await request(other).post(`/b/${created.body.bin.id}`).set('X-Bin-Secret', created.body.secret)).status, 200);
        assert.equal((await admin(request(other).post(`/api/keys/${key.id}/reveal`))).status, 409);
        assert.equal((await admin(request(other).post(`/api/bins/${created.body.bin.id}/secret/reveal`))).status, 409);
    });
});
