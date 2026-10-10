const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

// Outbound HTTP for forwarding and replaying captured requests. Requests are sent only to hosts on
// the FORWARD_ALLOWED_HOSTS allowlist, and never to addresses a server-side request must not reach:
//
//   * Entries are `host`, `host:port`, `*.example.com` (subdomains only) or an IP address, with an
//     optional port. An entry without a port allows any port.
//   * Link-local and cloud-metadata addresses (169.254.0.0/16, fe80::/10, fd00:ec2::254) and the
//     "this network" ranges are never allowed, even when listed.
//   * Loopback, private, CGNAT, multicast and other special-purpose addresses are refused too, unless the
//     allowlist names that host exactly (`localhost:3000`, `10.0.0.5`, `intranet.example.com`). A
//     wildcard entry can never reach them.
//   * The address is checked on the connection itself (a custom DNS lookup), so a name that resolves to
//     a private address, or changes its answer between a check and the connection, is still refused.
//   * Only http and https, no credentials in the URL, redirects are not followed, and the time and the
//     size of the response that is read are capped.

const MAX_IN_FLIGHT = 20;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HOP_HEADER = 'x-request-bin-hops';
const MAX_HOPS = 3;

// Headers that describe one connection, not the request, so they are never passed on
const SKIP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect', 'content-length', 'accept-encoding',
    'x-forwarded-by', 'x-request-bin-id', HOP_HEADER,
]);

const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

// --- Address classes ---

function blockList(subnets) {
    const list = new net.BlockList();
    for (const [address, prefix, family] of subnets) list.addSubnet(address, prefix, family);
    return list;
}

// Never reachable, whatever the allowlist says
const ALWAYS_BLOCKED = blockList([
    ['0.0.0.0', 8, 'ipv4'],
    ['169.254.0.0', 16, 'ipv4'], // link-local, including the 169.254.169.254 metadata service
    ['::', 128, 'ipv6'],
    ['fe80::', 10, 'ipv6'],
    ['fd00:ec2::', 64, 'ipv6'], // AWS metadata over IPv6
]);

// Internal address space: reachable only when the allowlist names the host exactly
const INTERNAL = blockList([
    ['127.0.0.0', 8, 'ipv4'],
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['100.64.0.0', 10, 'ipv4'],
    ['192.0.0.0', 24, 'ipv4'],
    ['198.18.0.0', 15, 'ipv4'],
    ['224.0.0.0', 4, 'ipv4'],
    ['240.0.0.0', 4, 'ipv4'],
    ['::1', 128, 'ipv6'],
    ['fc00::', 7, 'ipv6'],
    ['ff00::', 8, 'ipv6'],
    ['64:ff9b::', 96, 'ipv6'], // NAT64: embeds an IPv4 address
]);

// An IPv4-mapped IPv6 address (::ffff:7f00:1 or ::ffff:127.0.0.1) as its IPv4 address, else null
function unmapIPv4(ip) {
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (dotted) return dotted[1];
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (!hex) return null;
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

// Why an address can't be used, or null. `exact` = the allowlist names this host exactly.
function blockedReason(ip, exact) {
    const mapped = unmapIPv4(ip);
    const address = mapped || ip;
    const family = net.isIPv4(address) ? 'ipv4' : 'ipv6';
    if (ALWAYS_BLOCKED.check(address, family)) return 'link-local, metadata and unspecified addresses are never allowed';
    if (!exact && INTERNAL.check(address, family)) return 'internal addresses need an exact allowlist entry for the host';
    return null;
}

// --- Allowlist ---

function normalizeIp(ip) {
    return new URL(`http://${net.isIPv6(ip) ? `[${ip}]` : ip}`).hostname.replace(/^\[|\]$/g, '');
}

// "api.example.com, *.hooks.example.com:8443, localhost:3000, [::1]:9000" -> [{ host, port, wildcard }]
function parseAllowedHosts(raw) {
    if (!raw) return [];
    const problems = [];
    const entries = [];
    for (const item of raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)) {
        let host = item;
        let port = null;
        const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(item);
        if (bracketed) {
            host = bracketed[1];
            port = bracketed[2] || null;
        } else if (item.split(':').length === 2) {
            [host, port] = item.split(':');
        }
        if (port !== null && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
            problems.push(`"${item}" has an invalid port`);
            continue;
        }
        if (net.isIP(host)) {
            entries.push({ host: normalizeIp(host), port: port === null ? null : Number(port), wildcard: false });
        } else if (HOSTNAME_RE.test(host) && !host.includes('..') && !(host.startsWith('*.') && host.length < 4)) {
            entries.push({ host, port: port === null ? null : Number(port), wildcard: host.startsWith('*.') });
        } else {
            problems.push(`"${item}" is not a host name, wildcard (*.example.com) or IP address`);
        }
    }
    if (problems.length) throw new Error(`Invalid FORWARD_ALLOWED_HOSTS: ${problems.join('; ')}`);
    return entries;
}

// { allowed, exact }: does an allowlist entry cover this host and port, and does one name it exactly?
function matchHost(allowlist, hostname, port) {
    let allowed = false;
    let exact = false;
    for (const entry of allowlist) {
        if (entry.port !== null && entry.port !== port) continue;
        if (entry.wildcard) {
            if (hostname.endsWith(entry.host.slice(1)) && hostname.length > entry.host.length - 1) allowed = true;
        } else if (entry.host === hostname) {
            allowed = true;
            exact = true;
        }
    }
    return { allowed, exact };
}

// --- Request building ---

// The headers to send for a captured request: its own, minus connection-level headers and anything
// stored as "[redacted]" (the real value is gone), plus markers saying who forwarded it
function forwardHeaders(stored, { binId, redactedValue = '[redacted]' } = {}) {
    const headers = {};
    for (const [name, value] of Object.entries(stored || {})) {
        const lower = name.toLowerCase();
        if (SKIP_HEADERS.has(lower)) continue;
        const text = Array.isArray(value) ? value.join(', ') : String(value);
        if (text === redactedValue) continue;
        headers[lower] = text;
    }
    headers['x-forwarded-by'] = 'request-bin';
    if (binId) headers['x-request-bin-id'] = binId;
    headers[HOP_HEADER] = String(hopCount(stored) + 1);
    return headers;
}

function hopCount(headers) {
    const value = headers && headers[HOP_HEADER];
    const n = parseInt(Array.isArray(value) ? value[0] : value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// --- Sending ---

function createOutbound({ allowedHosts = [], timeoutMs = 10000 } = {}) {
    let inFlight = 0;

    // Static checks on a target URL, before any connection: { ok, url } or { ok: false, reason }
    function checkUrl(value) {
        let url;
        try {
            url = new URL(value);
        } catch {
            return { ok: false, reason: 'is not a valid URL' };
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'must start with http:// or https://' };
        if (url.username || url.password) return { ok: false, reason: 'must not contain a user name or password' };
        if (allowedHosts.length === 0) return { ok: false, reason: 'cannot be used: forwarding is switched off (FORWARD_ALLOWED_HOSTS is empty)' };
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        const { allowed, exact } = matchHost(allowedHosts, hostname, port);
        if (!allowed) return { ok: false, reason: `host ${url.host} is not in FORWARD_ALLOWED_HOSTS` };
        if (net.isIP(hostname)) {
            const reason = blockedReason(hostname, exact);
            if (reason) return { ok: false, reason };
        }
        return { ok: true, url, exact };
    }

    // DNS lookup used by the connection: every address the name resolves to is checked before it is used
    const guardedLookup = exact => (hostname, options, callback) => {
        const opts = typeof options === 'object' && options ? options : { family: options };
        dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return callback(err);
            for (const { address } of addresses) {
                const reason = blockedReason(address, exact);
                if (reason) return callback(new Error(`${hostname} resolves to ${address}: ${reason}`));
            }
            if (opts.all) return callback(null, addresses);
            callback(null, addresses[0].address, addresses[0].family);
        });
    };

    // Sends one request. Resolves { status, statusText, headers, body (Buffer), truncated, durationMs } for
    // any response, including redirects and errors; rejects when the target is refused or unreachable.
    async function send(target, { method = 'POST', headers = {}, body } = {}) {
        const check = checkUrl(target);
        if (!check.ok) throw new Error(`Target ${check.reason}`);
        if (inFlight >= MAX_IN_FLIGHT) throw new Error('Too many outbound requests in progress');

        const { url, exact } = check;
        const hasBody = body && body.length > 0 && method !== 'GET' && method !== 'HEAD';
        const requestHeaders = { ...headers };
        if (hasBody) requestHeaders['content-length'] = String(body.length);

        inFlight++;
        const started = Date.now();
        try {
            return await new Promise((resolve, reject) => {
                const transport = url.protocol === 'https:' ? https : http;
                const request = transport.request(url, {
                    method,
                    headers: requestHeaders,
                    agent: false,
                    lookup: guardedLookup(exact),
                }, response => {
                    const chunks = [];
                    let size = 0;
                    let done = false;
                    const finish = truncated => {
                        if (done) return;
                        done = true;
                        clearTimeout(timer);
                        resolve({
                            status: response.statusCode,
                            statusText: response.statusMessage || http.STATUS_CODES[response.statusCode] || '',
                            headers: response.headers,
                            body: Buffer.concat(chunks),
                            truncated,
                            durationMs: Date.now() - started,
                        });
                        if (truncated) response.destroy();
                    };
                    response.on('data', chunk => {
                        if (done) return;
                        const room = MAX_RESPONSE_BYTES - size;
                        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
                        size += Math.min(chunk.length, room);
                        if (chunk.length > room) finish(true);
                    });
                    response.on('end', () => finish(false));
                    response.on('error', err => {
                        if (!done) {
                            done = true;
                            clearTimeout(timer);
                            reject(err);
                        }
                    });
                });
                const timer = setTimeout(() => request.destroy(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
                request.on('error', err => {
                    clearTimeout(timer);
                    reject(err);
                });
                request.end(hasBody ? body : undefined);
            });
        } finally {
            inFlight--;
        }
    }

    return { enabled: allowedHosts.length > 0, allowedHosts, checkUrl, send };
}

module.exports = {
    createOutbound,
    parseAllowedHosts,
    matchHost,
    blockedReason,
    forwardHeaders,
    hopCount,
    MAX_HOPS,
    HOP_HEADER,
};
