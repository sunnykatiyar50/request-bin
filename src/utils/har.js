const { STATUS_CODES } = require('http');
const { version } = require('../../package.json');

// Captured requests as a HAR 1.2 log (http://www.softwareishard.com/blog/har-12-spec/), which
// browser dev tools, Postman, Insomnia and most HTTP tools can import. The response is the one the
// bin sent (status, content type and body); requests captured before responses were stored have an
// empty one (status 0). Redacted header values stay "[redacted]".

function harHeaders(headers) {
    return Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map(v => ({ name, value: String(v) }))
    );
}

function postData(request) {
    const mimeType = request.contentType || 'application/octet-stream';
    if (request.bodyEncoding === 'base64') {
        // HAR has no encoding field for request bodies; this one follows the response content's
        return { mimeType, text: request.body, encoding: 'base64' };
    }
    const data = { mimeType, text: request.body };
    if (/x-www-form-urlencoded/i.test(mimeType)) {
        data.params = [...new URLSearchParams(request.body)].map(([name, value]) => ({ name, value }));
    }
    return data;
}

function harResponse(response) {
    if (!response) {
        return {
            status: 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: 'x-unknown' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
        };
    }
    const size = Buffer.byteLength(response.body);
    return {
        status: response.status,
        statusText: STATUS_CODES[response.status] || '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: response.contentType ? [{ name: 'Content-Type', value: response.contentType }] : [],
        content: { size, mimeType: response.contentType || 'x-unknown', text: response.body },
        redirectURL: '',
        headersSize: -1,
        bodySize: size,
    };
}

function toHarEntry(request, baseUrl) {
    const subPath = request.path && request.path !== '/' ? request.path : '';
    const url = `${baseUrl}/b/${request.binId}${subPath}${request.queryString ? `?${request.queryString}` : ''}`;
    return {
        startedDateTime: request.createdAt,
        time: 0,
        request: {
            method: request.method,
            url,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: harHeaders(request.headers),
            queryString: request.query,
            ...(request.bodySize > 0 && { postData: postData(request) }),
            headersSize: -1,
            bodySize: request.bodySize,
        },
        response: harResponse(request.response),
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        ...(request.ip && { _clientIp: request.ip }),
        comment: `Request Bin: ${request.binName || request.binId}, request #${request.id}${request.response && request.response.ruleName ? `, rule "${request.response.ruleName}"` : ''}`,
    };
}

function toHar(requests, { baseUrl, truncated = false }) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'Request Bin', version },
            entries: requests.map(r => toHarEntry(r, baseUrl)),
            ...(truncated && { comment: `Only the newest ${requests.length} matching requests were exported.` }),
        },
    };
}

module.exports = { toHar };
