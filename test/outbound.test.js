const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const http = require('http');
const {
    createOutbound, parseAllowedHosts, matchHost, blockedReason, forwardHeaders, hopCount,
} = require('../src/utils/outbound');

describe('allowlist parsing', () => {
    test('accepts hosts, ports, wildcards and IP addresses', () => {
        assert.deepEqual(parseAllowedHosts('api.example.com, *.hooks.example.com:8443,localhost:3000, 10.0.0.5, [::1]:9000'), [
            { host: 'api.example.com', port: null, wildcard: false },
            { host: '*.hooks.example.com', port: 8443, wildcard: true },
            { host: 'localhost', port: 3000, wildcard: false },
            { host: '10.0.0.5', port: null, wildcard: false },
            { host: '::1', port: 9000, wildcard: false },
        ]);
    });

    test('is empty when unset', () => {
        assert.deepEqual(parseAllowedHosts(''), []);
        assert.deepEqual(parseAllowedHosts(undefined), []);
    });

    test('refuses entries that are not hosts', () => {
        for (const bad of ['https://example.com', 'example.com/path', 'exa mple.com', 'example.com:99999', 'example.com:0', '*.', '*', '*.*.com', 'a..b']) {
            assert.throws(() => parseAllowedHosts(bad), /Invalid FORWARD_ALLOWED_HOSTS/, bad);
        }
    });
});

describe('host matching', () => {
    const list = parseAllowedHosts('api.example.com,*.hooks.example.com,db.internal:5432');

    test('exact names, case-insensitively normalised by the caller', () => {
        assert.deepEqual(matchHost(list, 'api.example.com', 443), { allowed: true, exact: true });
        assert.deepEqual(matchHost(list, 'other.example.com', 443), { allowed: false, exact: false });
    });

    test('a wildcard covers subdomains only, and is never exact', () => {
        assert.deepEqual(matchHost(list, 'a.hooks.example.com', 443), { allowed: true, exact: false });
        assert.deepEqual(matchHost(list, 'a.b.hooks.example.com', 443), { allowed: true, exact: false });
        assert.equal(matchHost(list, 'hooks.example.com', 443).allowed, false);
        assert.equal(matchHost(list, 'evilhooks.example.com', 443).allowed, false);
        assert.equal(matchHost(list, 'a.hooks.example.com.evil.com', 443).allowed, false);
    });

    test('an entry with a port allows only that port', () => {
        assert.equal(matchHost(list, 'db.internal', 5432).allowed, true);
        assert.equal(matchHost(list, 'db.internal', 5433).allowed, false);
        assert.equal(matchHost(list, 'api.example.com', 8080).allowed, true);
    });
});

describe('blocked addresses', () => {
    test('internal addresses need an exact entry', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fd12::1', '224.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1']) {
            assert.ok(blockedReason(ip, false), `${ip} should be blocked`);
            assert.equal(blockedReason(ip, true), null, `${ip} should be allowed when named exactly`);
        }
    });

    test('link-local, metadata and unspecified addresses are never allowed', () => {
        for (const ip of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'fd00:ec2::254', '0.0.0.0', '::', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
            assert.ok(blockedReason(ip, false), `${ip} should be blocked`);
            assert.ok(blockedReason(ip, true), `${ip} should be blocked even when named exactly`);
        }
    });

    test('public addresses are fine', () => {
        for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
            assert.equal(blockedReason(ip, false), null, ip);
        }
    });
});

describe('target URLs', () => {
    const outbound = createOutbound({ allowedHosts: parseAllowedHosts('api.example.com,*.hooks.example.com,127.0.0.1:9999,169.254.169.254,localhost:3000') });
    const check = url => outbound.checkUrl(url);

    test('allowed targets', () => {
        assert.equal(check('https://api.example.com/hook?x=1').ok, true);
        assert.equal(check('http://a.hooks.example.com:8080/').ok, true);
        assert.equal(check('http://127.0.0.1:9999/x').ok, true);
        assert.equal(check('http://localhost:3000/').ok, true);
    });

    test('hosts, ports and schemes outside the allowlist are refused', () => {
        assert.match(check('https://evil.com/').reason, /not in FORWARD_ALLOWED_HOSTS/);
        assert.match(check('http://127.0.0.1:1/').reason, /not in FORWARD_ALLOWED_HOSTS/);
        assert.match(check('ftp://api.example.com/').reason, /http:\/\/ or https:\/\//);
        assert.match(check('file:///etc/passwd').reason, /http:\/\/ or https:\/\//);
        assert.match(check('not a url').reason, /not a valid URL/);
    });

    test('credentials in the URL are refused', () => {
        assert.match(check('https://user:pass@api.example.com/').reason, /user name or password/);
        assert.match(check('https://user@api.example.com/').reason, /user name or password/);
    });

    test('a different spelling of the host does not get past the allowlist', () => {
        assert.equal(check('http://2130706433:9999/').ok, true); // 127.0.0.1 written as one number: the same host
        assert.equal(check('http://2130706433:1/').ok, false);
        assert.equal(check('http://API.EXAMPLE.COM./').ok, false);
        assert.equal(check('https://api.example.com.evil.com/').ok, false);
        assert.equal(check('https://api.example.com@evil.com/').ok, false);
    });

    test('the metadata address is refused even when it is listed', () => {
        assert.match(check('http://169.254.169.254/latest/meta-data/').reason, /never allowed/);
    });

    test('everything is refused when the allowlist is empty', () => {
        const off = createOutbound({});
        assert.equal(off.enabled, false);
        assert.match(off.checkUrl('https://api.example.com/').reason, /switched off/);
    });
});

describe('forwarded headers', () => {
    test('connection-level and redacted headers are dropped, markers added', () => {
        const headers = forwardHeaders({
            host: 'bin.local',
            connection: 'keep-alive',
            'content-length': '12',
            'accept-encoding': 'gzip',
            'transfer-encoding': 'chunked',
            authorization: '[redacted]',
            cookie: '[redacted]',
            'content-type': 'application/json',
            'x-custom': 'kept',
            'x-multi': ['a', 'b'],
            'x-forwarded-by': 'someone-else',
            'x-request-bin-id': 'spoofed',
        }, { binId: 'abc' });
        assert.deepEqual(headers, {
            'content-type': 'application/json',
            'x-custom': 'kept',
            'x-multi': 'a, b',
            'x-forwarded-by': 'request-bin',
            'x-request-bin-id': 'abc',
            'x-request-bin-hops': '1',
        });
    });

    test('counts hops', () => {
        assert.equal(hopCount({}), 0);
        assert.equal(hopCount({ 'x-request-bin-hops': '2' }), 2);
        assert.equal(hopCount({ 'x-request-bin-hops': 'junk' }), 0);
        assert.equal(forwardHeaders({ 'x-request-bin-hops': '2' })['x-request-bin-hops'], '3');
    });
});

describe('sending', () => {
    let server;
    let port;
    let seen;
    let behaviour;
    const handler = (req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            behaviour(req, res);
        });
    };

    before(async () => {
        server = http.createServer(handler);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });
    after(() => new Promise(resolve => server.close(resolve)));

    const outboundFor = (hosts, options = {}) => createOutbound({ allowedHosts: parseAllowedHosts(hosts), ...options });
    const reset = fn => {
        seen = [];
        behaviour = fn || ((req, res) => res.end('{"ok":true}'));
    };

    test('sends the method, headers and exact body bytes, and returns the response', async () => {
        reset();
        const body = Buffer.from([0, 255, 1, 128]);
        const res = await outboundFor(`127.0.0.1:${port}`).send(`http://127.0.0.1:${port}/in?x=1`, {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-a': '1' }, body,
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.toString(), '{"ok":true}');
        assert.equal(res.truncated, false);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, 'PUT');
        assert.equal(seen[0].url, '/in?x=1');
        assert.equal(seen[0].headers['x-a'], '1');
        assert.deepEqual(seen[0].body, body);
    });

    test('does not send a body with GET', async () => {
        reset();
        await outboundFor(`127.0.0.1:${port}`).send(`http://127.0.0.1:${port}/`, { method: 'GET', body: Buffer.from('x') });
        assert.equal(seen[0].body.length, 0);
    });

    test('does not follow redirects', async () => {
        reset((req, res) => {
            res.writeHead(302, { Location: `http://127.0.0.1:${port}/other` });
            res.end();
        });
        const res = await outboundFor(`127.0.0.1:${port}`).send(`http://127.0.0.1:${port}/start`);
        assert.equal(res.status, 302);
        assert.equal(seen.length, 1);
    });

    test('caps how much of the response is read', async () => {
        reset((req, res) => res.end('x'.repeat(200 * 1024)));
        const res = await outboundFor(`127.0.0.1:${port}`).send(`http://127.0.0.1:${port}/big`);
        assert.equal(res.truncated, true);
        assert.equal(res.body.length, 64 * 1024);
    });

    test('gives up after the timeout', async () => {
        reset(() => {}); // never answers
        const started = Date.now();
        await assert.rejects(
            outboundFor(`127.0.0.1:${port}`, { timeoutMs: 300 }).send(`http://127.0.0.1:${port}/hang`),
            /Timed out after 300 ms/
        );
        assert.ok(Date.now() - started < 3000);
    });

    test('reports a connection that is refused', async () => {
        const closed = http.createServer();
        await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
        const closedPort = closed.address().port;
        await new Promise(resolve => closed.close(resolve));
        await assert.rejects(outboundFor(`127.0.0.1:${closedPort}`).send(`http://127.0.0.1:${closedPort}/`), /ECONNREFUSED/);
    });

    test('refuses a target that is not allowed, without connecting', async () => {
        reset();
        await assert.rejects(outboundFor('example.com').send(`http://127.0.0.1:${port}/`), /not in FORWARD_ALLOWED_HOSTS/);
        assert.equal(seen.length, 0);
    });

    describe('DNS answers are checked at connection time', () => {
        const realLookup = dns.lookup;
        const answer = address => (hostname, options, callback) => {
            const family = address.includes(':') ? 6 : 4;
            if (options && options.all) return callback(null, [{ address, family }]);
            callback(null, address, family);
        };
        after(() => { dns.lookup = realLookup; });

        test('a wildcard-allowed name that resolves to an internal address is refused', async () => {
            reset();
            dns.lookup = answer('127.0.0.1');
            await assert.rejects(
                outboundFor('*.example.com').send(`http://rebind.example.com:${port}/`),
                /resolves to 127\.0\.0\.1: internal addresses need an exact allowlist entry/
            );
            assert.equal(seen.length, 0);
        });

        test('so is one that resolves to the metadata address, even if named exactly', async () => {
            reset();
            dns.lookup = answer('169.254.169.254');
            await assert.rejects(outboundFor('meta.example.com').send('http://meta.example.com/'), /never allowed/);
        });

        test('a host named exactly may resolve to an internal address', async () => {
            reset();
            dns.lookup = answer('127.0.0.1');
            const res = await outboundFor('intranet.example.com').send(`http://intranet.example.com:${port}/ok`);
            assert.equal(res.status, 200);
            assert.equal(seen.length, 1);
        });
    });
});
