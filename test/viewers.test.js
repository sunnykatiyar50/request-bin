const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestEnv, openTestDatabase } = require('./helpers/database');
setupTestEnv('viewers');

const request = require('supertest');
const { loadConfig } = require('../src/config');
const BinModel = require('../src/models/binModel');
const RequestModel = require('../src/models/requestModel');
const ApiKeyModel = require('../src/models/apiKeyModel');
const { createApp } = require('../src/server');

const env = {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-password-1',
    VIEWER_USERS: 'alice:alice-password-1,bob:bob:pass:word',
    SESSION_SECRET: 'v'.repeat(48),
};

let db;
let app;
let bin;

function build(overrides = {}) {
    const config = loadConfig({ ...env, ...overrides });
    return createApp({
        config,
        binModel: new BinModel(db, { encryptionSecret: config.sessionSecret }),
        requestModel: new RequestModel(db),
        apiKeyModel: new ApiKeyModel(db, { encryptionSecret: config.sessionSecret }),
    });
}

async function login(target, username, password) {
    const res = await request(target).post('/auth/login').send({ username, password });
    return { res, cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : null };
}

before(async () => {
    db = await openTestDatabase();
    app = build();
    // A bin with a captured request to look at
    const { cookie } = await login(app, 'admin', env.ADMIN_PASSWORD);
    bin = (await request(app).post('/api/bins').set('Cookie', cookie).set('X-Requested-With', 'fetch').send({ name: 'hooks' })).body.bin;
    await request(app).post(`/b/${bin.id}/event`).set('Content-Type', 'application/json').send('{"id":7}');
});

after(async () => {
    await db.close();
});

describe('config', () => {
    test('parses VIEWER_USERS (passwords may contain colons)', () => {
        assert.deepEqual(loadConfig(env).viewerUsers, [
            { username: 'alice', password: 'alice-password-1' },
            { username: 'bob', password: 'bob:pass:word' },
        ]);
    });

    test('rejects bad entries', () => {
        for (const value of ['al ice:long-enough-1', 'alice:short', 'admin:long-enough-1', 'alice:long-enough-1,ALICE:long-enough-2', 'alice:change-me-1234']) {
            assert.throws(() => loadConfig({ ...env, VIEWER_USERS: value }), /Invalid auth configuration/, value);
        }
    });
});

describe('viewer sign-in', () => {
    test('a viewer can sign in and is reported as a viewer', async () => {
        const { res, cookie } = await login(app, 'alice', 'alice-password-1');
        assert.equal(res.status, 200);
        assert.equal(res.body.role, 'viewer');
        const status = await request(app).get('/auth/status').set('Cookie', cookie);
        assert.deepEqual(status.body, { authenticated: true, authDisabled: false, username: 'alice', role: 'viewer', forwardingEnabled: false });
        assert.equal((await request(app).get('/').set('Cookie', cookie)).status, 200);
    });

    test('wrong passwords and unknown users are rejected the same way', async () => {
        for (const [u, p] of [['alice', 'wrong-password'], ['nobody', 'alice-password-1'], ['alice', 'admin-password-1']]) {
            const { res } = await login(app, u, p);
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Incorrect username or password');
        }
    });
});

describe('what a viewer can do', () => {
    let cookie;
    before(async () => {
        ({ cookie } = await login(app, 'alice', 'alice-password-1'));
    });
    const asViewer = r => r.set('Cookie', cookie).set('X-Requested-With', 'fetch');

    test('can list bins and requests, and open a request in full', async () => {
        assert.equal((await asViewer(request(app).get('/api/bins'))).status, 200);
        const list = await asViewer(request(app).get('/api/requests'));
        assert.equal(list.status, 200);
        assert.equal(list.body.total >= 1, true);
        const latest = await asViewer(request(app).get(`/api/requests/latest?bin=${bin.id}`));
        assert.equal(latest.body.body, '{"id":7}');
    });

    test('cannot create, change or delete bins, or touch bin secrets', async () => {
        assert.equal((await asViewer(request(app).post('/api/bins')).send({})).status, 403);
        assert.equal((await asViewer(request(app).patch(`/api/bins/${bin.id}`)).send({ name: 'x' })).status, 403);
        assert.equal((await asViewer(request(app).delete(`/api/bins/${bin.id}`))).status, 403);
        assert.equal((await asViewer(request(app).post(`/api/bins/${bin.id}/secret`))).status, 403);
        assert.equal((await asViewer(request(app).post(`/api/bins/${bin.id}/secret/reveal`))).status, 403);
    });

    test('cannot delete requests', async () => {
        assert.equal((await asViewer(request(app).delete('/api/requests/1'))).status, 403);
        assert.equal((await asViewer(request(app).delete('/api/requests')).send({ ids: [1] })).status, 403);
        assert.equal((await asViewer(request(app).delete(`/api/bins/${bin.id}/requests`))).status, 403);
    });

    test('cannot list, create, reveal or revoke API keys', async () => {
        assert.equal((await asViewer(request(app).get('/api/keys'))).status, 403);
        assert.equal((await asViewer(request(app).post('/api/keys')).send({ name: 'x' })).status, 403);
        assert.equal((await asViewer(request(app).post('/api/keys/1/reveal'))).status, 403);
        assert.equal((await asViewer(request(app).delete('/api/keys/1'))).status, 403);
    });
});

describe('sessions follow .env', () => {
    test('changing a viewer password signs that viewer out', async () => {
        const { cookie } = await login(app, 'alice', 'alice-password-1');
        const changed = build({ VIEWER_USERS: 'alice:a-new-password-2,bob:bob:pass:word' });
        assert.equal((await request(changed).get('/api/requests').set('Cookie', cookie)).status, 401);
        assert.equal((await request(app).get('/api/requests').set('Cookie', cookie)).status, 200);
    });

    test('removing a viewer from .env ends their session', async () => {
        const { cookie } = await login(app, 'bob', 'bob:pass:word');
        const removed = build({ VIEWER_USERS: 'alice:alice-password-1' });
        assert.equal((await request(removed).get('/api/requests').set('Cookie', cookie)).status, 401);
    });

    test('changing ADMIN_PASSWORD signs the admin out', async () => {
        const { cookie } = await login(app, 'admin', env.ADMIN_PASSWORD);
        const changed = build({ ADMIN_PASSWORD: 'another-admin-pass' });
        assert.equal((await request(changed).get('/api/keys').set('Cookie', cookie)).status, 401);
        assert.equal((await request(app).get('/api/keys').set('Cookie', cookie)).status, 200);
    });

    test('a viewer session cannot be turned into an admin one', async () => {
        const { createSessionToken } = require('../src/utils/session');
        const { cookie } = await login(app, 'alice', 'alice-password-1');
        const payload = JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString());
        // Re-signing needs SESSION_SECRET; without it, changing the role breaks the signature
        const tampered = Buffer.from(JSON.stringify({ ...payload, r: 'admin' })).toString('base64url') + '.' + cookie.split('.')[1];
        assert.equal((await request(app).get('/api/keys').set('Cookie', `rb_session=${tampered}`)).status, 401);
        // Even with the secret, alice's password fingerprint doesn't match the admin account
        const forged = createSessionToken(env.SESSION_SECRET, 60000, { ...payload, u: 'admin', r: 'admin' });
        assert.equal((await request(app).get('/api/keys').set('Cookie', `rb_session=${forged}`)).status, 401);
    });
});
