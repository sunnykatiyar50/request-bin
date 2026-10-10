const { forwardHeaders, hopCount, MAX_HOPS } = require('./outbound');
const { logToFile } = require('./logger');

// Automatic forwarding: a bin with forward_config { enabled, url, methods? } passes each request it
// captures on to `url`, exactly as sent (see outbound.js for what is allowed). It happens after the
// bin has answered the sender and never affects that answer. The outcome is stored on the request:
// { target, status, statusText, durationMs } or { target, error }.

function parseStoredForward(value) {
    const none = { enabled: false, url: '', methods: [] };
    if (!value) return none;
    try {
        const config = JSON.parse(value);
        if (!config || typeof config !== 'object') return none;
        return {
            enabled: config.enabled === true,
            url: typeof config.url === 'string' ? config.url : '',
            methods: Array.isArray(config.methods) ? config.methods : [],
        };
    } catch {
        return none;
    }
}

// The target without its query string or fragment, which may carry tokens: for logs and for display
function describeTarget(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
        return '';
    }
}

function createForwarder({ outbound, requestModel }) {
    // bin: the raw bin row. captured: { id, method, headers (as stored), body (Buffer) }.
    // Never rejects: failures are recorded on the request.
    async function forward(bin, captured) {
        const config = parseStoredForward(bin.forward_config);
        if (!config.enabled || !config.url) return;
        if (config.methods.length && !config.methods.includes(captured.method)) return;

        const target = describeTarget(config.url);
        let result;
        if (hopCount(captured.headers) >= MAX_HOPS) {
            result = { target, error: 'Not forwarded: this request has already been forwarded too many times (a loop?)' };
        } else {
            try {
                const response = await outbound.send(config.url, {
                    method: captured.method,
                    headers: forwardHeaders(captured.headers, { binId: bin.id }),
                    body: captured.body,
                });
                result = { target, status: response.status, statusText: response.statusText, durationMs: response.durationMs };
            } catch (err) {
                result = { target, error: err.message };
            }
        }

        try {
            await requestModel.setForwardResult(captured.id, result);
        } catch (err) {
            logToFile(`Could not record the forward result for request ${captured.id}: ${err.message}`);
        }
        if (result.error) logToFile(`Forwarding request ${captured.id} of bin ${bin.id} to ${target} failed: ${result.error}`);
    }

    return { forward };
}

module.exports = { createForwarder, parseStoredForward, describeTarget };
