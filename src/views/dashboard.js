// Request Bin dashboard. All captured data is rendered with textContent, never as HTML.

const state = {
    bins: [],
    bin: null,
    requests: [],
    selectedRequestId: null,
    selectedRequest: null,
    page: 1,
    totalPages: 1,
    stream: null,
};

const $ = id => document.getElementById(id);

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

// fetch wrapper: adds the header the server requires for cookie-authenticated writes,
// parses JSON, and sends the user to the login page when the session has expired
async function api(url, options = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
        ...options,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Not authenticated');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const details = data.details ? ` (${Object.entries(data.details).map(([k, v]) => `${k} ${v}`).join('; ')})` : '';
        throw new Error(`${data.error || response.statusText}${details}`);
    }
    return data;
}

function binUrl(bin) {
    return `${location.origin}/b/${bin.id}`;
}

function formatTime(iso) {
    const date = new Date(iso);
    const diffSec = Math.floor((Date.now() - date) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`;
    return date.toLocaleString();
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

async function copyText(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        const original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = original), 1200);
    } catch {
        prompt('Copy this:', text);
    }
}

// --- Bins ---

async function loadBins(selectId) {
    const { bins } = await api('/api/bins');
    state.bins = bins;
    renderBins();
    const target = selectId || (state.bin && state.bin.id) || localStorage.getItem('rb_selected_bin');
    const bin = bins.find(b => b.id === target) || bins[0];
    if (bin) selectBin(bin.id);
    else showBin(null);
}

function renderBins() {
    const list = $('binList');
    list.replaceChildren();
    if (state.bins.length === 0) {
        list.appendChild(el('li', 'muted', 'No bins yet.'));
        return;
    }
    for (const bin of state.bins) {
        const li = el('li', 'list-item');
        if (state.bin && state.bin.id === bin.id) li.classList.add('selected');
        li.appendChild(el('div', 'title', bin.name));
        li.appendChild(el('div', 'muted', `${bin.requestCount} request(s)`));
        li.addEventListener('click', () => selectBin(bin.id));
        list.appendChild(li);
    }
}

async function createBin() {
    const name = prompt('Bin name:', '');
    if (name === null) return;
    const withSecret = confirm('Require a secret for requests sent to this bin?\n\nOK = yes, Cancel = no');
    try {
        const { bin, secret } = await api('/api/bins', {
            method: 'POST',
            body: { ...(name.trim() && { name: name.trim() }), withSecret },
        });
        if (secret) {
            prompt('Save this bin secret now - it will not be shown again:', secret);
        }
        await loadBins(bin.id);
    } catch (error) {
        alert(`Could not create bin: ${error.message}`);
    }
}

function selectBin(id) {
    const bin = state.bins.find(b => b.id === id);
    if (!bin) return;
    localStorage.setItem('rb_selected_bin', id);
    state.page = 1;
    state.selectedRequestId = null;
    showBin(bin);
    renderBins();
    loadRequests();
    openStream(bin.id);
}

function showBin(bin) {
    state.bin = bin;
    $('noBinSelected').classList.toggle('hidden', Boolean(bin));
    $('binView').classList.toggle('hidden', !bin);
    showRequest(null);
    if (!bin) return;
    $('binTitle').textContent = bin.name;
    $('binUrl').textContent = binUrl(bin);
    $('binSecretInfo').classList.toggle('hidden', !bin.hasSecret);
    $('binNameInput').value = bin.name;
    $('responseStatusInput').value = bin.responseStatus;
    $('responseTypeInput').value = bin.responseContentType;
    $('responseBodyInput').value = bin.responseBody;
    $('redactInput').checked = bin.redactHeaders;
}

async function saveBinSettings(event) {
    event.preventDefault();
    try {
        const bin = await api(`/api/bins/${state.bin.id}`, {
            method: 'PATCH',
            body: {
                name: $('binNameInput').value,
                responseStatus: Number($('responseStatusInput').value),
                responseContentType: $('responseTypeInput').value,
                responseBody: $('responseBodyInput').value,
                redactHeaders: $('redactInput').checked,
            },
        });
        state.bins = state.bins.map(b => (b.id === bin.id ? { ...b, ...bin } : b));
        state.bin = { ...state.bin, ...bin };
        $('binTitle').textContent = bin.name;
        renderBins();
    } catch (error) {
        alert(`Could not save: ${error.message}`);
    }
}

async function deleteBin() {
    if (!confirm(`Delete bin "${state.bin.name}" and all its requests?`)) return;
    try {
        await api(`/api/bins/${state.bin.id}`, { method: 'DELETE' });
        closeStream();
        state.bin = null;
        await loadBins();
    } catch (error) {
        alert(`Could not delete: ${error.message}`);
    }
}

// --- Requests ---

async function loadRequests() {
    if (!state.bin) return;
    const params = new URLSearchParams({ page: state.page, pageSize: 50 });
    if ($('methodFilter').value) params.set('method', $('methodFilter').value);
    if ($('searchInput').value.trim()) params.set('search', $('searchInput').value.trim());
    try {
        const data = await api(`/api/bins/${state.bin.id}/requests?${params}`);
        state.requests = data.requests;
        state.totalPages = data.totalPages;
        renderRequests();
        const bin = state.bins.find(b => b.id === state.bin.id);
        if (bin && !params.has('method') && !params.has('search')) {
            bin.requestCount = data.total;
            renderBins();
        }
        if (!state.selectedRequestId && state.requests[0]) selectRequest(state.requests[0].id);
    } catch (error) {
        $('requestList').replaceChildren(el('li', 'muted', `Could not load requests: ${error.message}`));
    }
}

function renderRequests() {
    const list = $('requestList');
    list.replaceChildren();
    if (state.requests.length === 0) {
        list.appendChild(el('li', 'muted', 'No requests yet. Send one to the URL above, for example:'));
        list.appendChild(el('li', 'muted mono', `curl -X POST ${binUrl(state.bin)}/hello -d '{"hello":"world"}'`));
    }
    for (const request of state.requests) {
        const li = el('li', 'list-item request-item');
        if (request.id === state.selectedRequestId) li.classList.add('selected');
        const top = el('div', 'row');
        top.appendChild(el('span', `method method-${request.method.toLowerCase()}`, request.method));
        top.appendChild(el('span', 'path', request.path + (request.queryString ? `?${request.queryString}` : '')));
        li.appendChild(top);
        li.appendChild(el('div', 'muted', `${formatTime(request.createdAt)} · ${formatSize(request.bodySize)} · ${request.ip || ''}`));
        li.addEventListener('click', () => selectRequest(request.id));
        list.appendChild(li);
    }
    $('prevPage').disabled = state.page <= 1;
    $('nextPage').disabled = state.page >= state.totalPages;
    $('pageInfo').textContent = `Page ${state.page} of ${state.totalPages}`;
}

async function selectRequest(id) {
    state.selectedRequestId = id;
    renderRequests();
    try {
        showRequest(await api(`/api/requests/${id}`));
    } catch (error) {
        showRequest(null);
    }
}

function fillTable(tbody, entries) {
    tbody.replaceChildren();
    if (entries.length === 0) {
        const tr = el('tr');
        tr.appendChild(el('td', 'muted', '(none)'));
        tbody.appendChild(tr);
        return;
    }
    for (const [key, value] of entries) {
        const tr = el('tr');
        tr.appendChild(el('th', null, key));
        tr.appendChild(el('td', 'mono', value));
        tbody.appendChild(tr);
    }
}

function showRequest(request) {
    state.selectedRequest = request;
    $('noRequestSelected').classList.toggle('hidden', Boolean(request));
    $('requestDetail').classList.toggle('hidden', !request);
    if (!request) return;

    $('detailMethod').textContent = request.method;
    $('detailMethod').className = `method method-${request.method.toLowerCase()}`;
    $('detailPath').textContent = request.path + (request.queryString ? `?${request.queryString}` : '');
    fillTable($('detailOverview'), [
        ['Received', new Date(request.createdAt).toLocaleString()],
        ['From', request.ip || ''],
        ['Content type', request.contentType || ''],
        ['Size', formatSize(request.bodySize)],
        ['Request ID', request.id],
    ]);
    fillTable($('detailQuery'), Object.entries(request.query));
    fillTable($('detailHeaders'), Object.entries(request.headers));

    let body = request.body;
    let info = request.bodyEncoding === 'base64' ? '(binary, shown as base64)' : '';
    if (request.bodyEncoding === 'utf8' && body) {
        try {
            body = JSON.stringify(JSON.parse(body), null, 2);
            info = '(JSON)';
        } catch {
            // not JSON: show as-is
        }
    }
    $('detailBodyInfo').textContent = info;
    $('detailBody').textContent = body || '(empty)';
}

// Builds a cURL command that replays the request against the original bin URL
function toCurl(request) {
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
    const url = `${binUrl(state.bin)}${request.path === '/' ? '' : request.path}${request.queryString ? `?${request.queryString}` : ''}`;
    const parts = [`curl -X ${request.method} ${quote(url)}`];
    for (const [name, value] of Object.entries(request.headers)) {
        if (!skip.has(name)) parts.push(`-H ${quote(`${name}: ${value}`)}`);
    }
    if (request.body && request.bodyEncoding === 'utf8') parts.push(`--data-raw ${quote(request.body)}`);
    return parts.join(' \\\n  ');
}

async function clearRequests() {
    if (!confirm('Delete all captured requests in this bin?')) return;
    try {
        await api(`/api/bins/${state.bin.id}/requests`, { method: 'DELETE' });
        state.selectedRequestId = null;
        state.page = 1;
        showRequest(null);
        await loadRequests();
    } catch (error) {
        alert(`Could not clear: ${error.message}`);
    }
}

// --- Live updates ---

function closeStream() {
    if (state.stream) state.stream.close();
    state.stream = null;
    $('liveIndicator').classList.remove('on');
}

function openStream(binId) {
    closeStream();
    const stream = new EventSource(`/api/bins/${binId}/stream`);
    stream.onopen = () => $('liveIndicator').classList.add('on');
    stream.onerror = () => $('liveIndicator').classList.remove('on');
    stream.addEventListener('request', () => {
        // Only auto-refresh when looking at the unfiltered first page
        if (state.page === 1 && !$('methodFilter').value && !$('searchInput').value.trim()) loadRequests();
        else {
            const bin = state.bins.find(b => b.id === binId);
            if (bin) {
                bin.requestCount += 1;
                renderBins();
            }
        }
    });
    state.stream = stream;
}

// --- Wiring ---

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

window.addEventListener('DOMContentLoaded', () => {
    $('newBinButton').addEventListener('click', createBin);
    $('logoutButton').addEventListener('click', async () => {
        try {
            await api('/auth/logout', { method: 'POST' });
        } finally {
            window.location.href = '/login.html';
        }
    });
    $('copyUrlButton').addEventListener('click', e => copyText(binUrl(state.bin), e.target));
    $('copyCurlButton').addEventListener('click', e => state.selectedRequest && copyText(toCurl(state.selectedRequest), e.target));
    $('binSettingsForm').addEventListener('submit', saveBinSettings);
    $('deleteBinButton').addEventListener('click', deleteBin);
    $('clearRequestsButton').addEventListener('click', clearRequests);
    $('methodFilter').addEventListener('change', () => {
        state.page = 1;
        loadRequests();
    });
    $('searchInput').addEventListener('input', debounce(() => {
        state.page = 1;
        loadRequests();
    }, 300));
    $('prevPage').addEventListener('click', () => {
        state.page -= 1;
        loadRequests();
    });
    $('nextPage').addEventListener('click', () => {
        state.page += 1;
        loadRequests();
    });

    loadBins().catch(error => {
        $('binList').replaceChildren(el('li', 'muted', `Could not load bins: ${error.message}`));
    });
});
