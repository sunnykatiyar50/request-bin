// Request Bin dashboard. Captured data is always rendered with textContent, never as HTML.

const $ = id => document.getElementById(id);

// --- Utilities ---

// fetch wrapper: marks requests as same-origin script calls (required by the server for
// cookie-authenticated writes) and sends the user to the login page when the session expires
async function apiFetch(url, options = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Not authenticated');
    }
    return response;
}

async function apiJson(url, options = {}) {
    const headers = options.body ? { 'Content-Type': 'application/json' } : {};
    const response = await apiFetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    return { response, data };
}

function readSetting(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: the setting just isn't remembered
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

// An inline SVG icon from fixed markup in this file (never from captured data)
function svgIcon(innerMarkup) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = innerMarkup;
    return svg;
}

const ICONS = {
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    eraser: '<path d="M20 20H7L3 16l10-10 7 7-3.5 3.5"/><line x1="6" y1="11" x2="13" y2="18"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    up: '<polyline points="6 15 12 9 18 15"/>',
    down: '<polyline points="6 9 12 15 18 9"/>',
    ban: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>',
};

// Icon-only button; `label` appears as a tooltip on hover or keyboard focus
function iconButton(icon, label, onClick, { danger = false } = {}) {
    const button = el('button', `icon-action${danger ? ' danger-icon' : ''}`);
    button.type = 'button';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.appendChild(svgIcon(ICONS[icon]));
    button.addEventListener('click', onClick);
    return button;
}

async function copyText(text, button) {
    const original = button.textContent;
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
    } catch {
        button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = original), 1500);
}

function relativeTime(timestamp) {
    const date = new Date(timestamp);
    const diffSec = Math.floor((Date.now() - date) / 1000);
    if (diffSec < 10) return 'Just now';
    if (diffSec < 60) return `${diffSec} s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} d ago`;
    return date.toLocaleDateString();
}

// Converts a YYYY-MM-DD value from a date input to an ISO timestamp for local midnight
// (optionally the following midnight, so the end date is inclusive)
function localDayToIso(value, nextDay = false) {
    if (!value) return '';
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d + (nextDay ? 1 : 0)).toISOString();
}

const formatBytes = n => MessageFormat.formatBytes(n);

function captureUrl(binId, path = '', queryString = '') {
    const p = path && path !== '/' ? path : '';
    return `${location.origin}/b/${binId}${p}${queryString ? `?${queryString}` : ''}`;
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// --- Quick time ranges (sidebar) ---

const MINUTE = 60 * 1000;
const RANGES = {
    '10m': { ms: 10 * MINUTE, label: 'Last 10 minutes' },
    '1h': { ms: 60 * MINUTE, label: 'Last 1 hour' },
    '8h': { ms: 8 * 60 * MINUTE, label: 'Last 8 hours' },
    '24h': { ms: 24 * 60 * MINUTE, label: 'Last 1 day' },
    '7d': { ms: 7 * 24 * 60 * MINUTE, label: 'Last 1 week' },
    '30d': { ms: 30 * 24 * 60 * MINUTE, label: 'Last 1 month' },
};
let timeRange = 'all'; // a RANGES key, 'all', or 'custom' (dates picked in the toolbar)

// Keeps the sidebar dropdown and the header chip in sync with the current range
function renderRange() {
    $('rangeSelect').value = timeRange;
    const range = RANGES[timeRange];
    $('rangeChip').classList.toggle('hidden', !range);
    $('rangeChipText').textContent = range ? range.label : '';
    $('rangeIconButton').classList.toggle('active', timeRange !== 'all');
}

async function setTimeRange(value) {
    timeRange = RANGES[value] ? value : 'all';
    // A quick range replaces any picked dates
    $('startDate').value = '';
    $('endDate').value = '';
    renderRange();
    if (currentView() !== 'requests') location.hash = '#/requests';
    else await filterRequests();
}

// --- Navigation ---

const VIEWS = ['requests', 'bins', 'send', 'keys', 'api'];
const VIEW_TITLES = { requests: 'Requests', bins: 'Bins', send: 'Send test', keys: 'API keys', api: 'API reference' };

// The signed-in account's role: 'admin' or 'viewer'. Viewers only look; the server enforces
// this too, the dashboard just hides what they can't use.
let userRole = 'admin';
const ADMIN_VIEWS = ['send', 'keys'];

function currentView() {
    const name = location.hash.replace(/^#\/?/, '');
    if (userRole === 'viewer' && ADMIN_VIEWS.includes(name)) {
        history.replaceState(null, '', '#/requests'); // keep the address bar honest
        return 'requests';
    }
    return VIEWS.includes(name) ? name : 'requests';
}

function showView() {
    const view = currentView();
    document.querySelectorAll('.view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== view));
    document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
        const active = link.dataset.view === view;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
    document.title = `${VIEW_TITLES[view]} · Request Bin`;
    if (view === 'requests') reloadWithSavedParams();
    if (view === 'bins') loadBins().then(renderBins);
    if (view === 'send') loadBins().then(prepareSendForm);
    if (view === 'keys') loadKeys();
    else forgetRevealedKeys();
}

function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const button = $('collapseButton');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', button.title);
    saveSetting('rb_sidebar_collapsed', collapsed ? 'yes' : 'no');
}

// --- Resizable sidebar ---

const SIDEBAR_DEFAULT = 232;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_COLLAPSE_AT = 120; // dragging narrower than this collapses to icons

function applySidebarWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', `${px}px`);
    $('sidebarResizer').setAttribute('aria-valuenow', String(px));
    // The detail pane's width is a share of the remaining space, so let it re-measure
    window.dispatchEvent(new Event('resize'));
}

// Applied as soon as the script runs, before the first paint, so the sidebar doesn't jump
(function restoreSidebarWidth() {
    const saved = parseInt(readSetting('rb_sidebar_width', ''), 10);
    if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', `${saved}px`);
    }
})();

function initSidebarResizer() {
    const handle = $('sidebarResizer');
    // The target width (CSS variable), not the measured one, which lags while the width animates
    const current = () =>
        parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || SIDEBAR_DEFAULT;
    const clamp = px => Math.min(Math.max(Math.round(px), SIDEBAR_MIN), SIDEBAR_MAX);
    handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
    handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));
    handle.setAttribute('aria-valuenow', String(current()));

    handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const left = $('sidebar').getBoundingClientRect().left;
        let width = current();
        let wantsCollapse = false;
        let frame = 0;
        const onMove = moveEvent => {
            const raw = moveEvent.clientX - left;
            wantsCollapse = raw < SIDEBAR_COLLAPSE_AT;
            handle.classList.toggle('will-collapse', wantsCollapse);
            width = clamp(raw);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => applySidebarWidth(width));
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            handle.classList.remove('will-collapse');
            if (wantsCollapse) {
                // Keep the last expanded width for when the sidebar is expanded again
                applySidebarWidth(clamp(parseInt(readSetting('rb_sidebar_width', ''), 10) || SIDEBAR_DEFAULT));
                setSidebarCollapsed(true);
            } else {
                saveSetting('rb_sidebar_width', String(width));
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
    // Keyboard: arrow keys resize in 16px steps
    handle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const width = clamp(current() + (event.key === 'ArrowRight' ? 16 : -16));
        applySidebarWidth(width);
        saveSetting('rb_sidebar_width', String(width));
    });
    handle.addEventListener('dblclick', () => {
        applySidebarWidth(SIDEBAR_DEFAULT);
        saveSetting('rb_sidebar_width', String(SIDEBAR_DEFAULT));
    });
}

// --- Session ---

async function loadSession() {
    try {
        const response = await fetch('/auth/status');
        const status = await response.json();
        userRole = status.role === 'viewer' ? 'viewer' : 'admin';
        forwardingEnabled = Boolean(status.forwardingEnabled);
        $('replayButton').classList.toggle('hidden', !forwardingEnabled);
        const name = status.username || (status.authDisabled ? 'No sign-in' : 'admin');
        $('currentUser').textContent = userRole === 'viewer' ? `${name} (viewer)` : name;
        $('authWarning').classList.toggle('hidden', !status.authDisabled);
        $('logoutButton').classList.toggle('hidden', Boolean(status.authDisabled));
    } catch {
        // keep defaults
    }
    document.body.classList.toggle('role-viewer', userRole === 'viewer');
}

async function logout() {
    try {
        await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
        window.location.href = '/login.html';
    }
}

// --- Bins (shared by several pages) ---

let bins = [];
const binById = id => bins.find(b => b.id === id);

async function loadBins() {
    try {
        const { response, data } = await apiJson('/api/bins');
        if (response.ok) bins = data.bins;
    } catch {
        // keep the previous list
    }
    fillBinSelect($('binFilter'), 'All bins');
    return bins;
}

function fillBinSelect(select, emptyLabel) {
    const current = select.value;
    select.replaceChildren();
    if (emptyLabel) select.appendChild(new Option(emptyLabel, ''));
    for (const bin of bins) select.appendChild(new Option(bin.name, bin.id));
    if ([...select.options].some(o => o.value === current)) select.value = current;
}

// --- Requests: loading and rendering ---

let requests = [];
let currentPage = 1;
let pageSize = 25;
let totalPages = 1;
let selectedId = null;
let selectedDetail = null;
let totalMatching = 0;

function currentFilters() {
    return {
        binId: $('binFilter').value,
        method: $('methodFilter').value,
        searchInput: $('searchInput').value.trim(),
        startDate: $('startDate').value,
        endDate: $('endDate').value,
    };
}

const hasFilters = f => Boolean(f.method || f.searchInput || f.startDate || f.endDate || RANGES[timeRange]);

// The filters as API query parameters (shared by the list and the export)
function filterParams(f) {
    const params = new URLSearchParams();
    if (f.binId) params.set('bin', f.binId);
    if (f.method) params.set('method', f.method);
    if (f.searchInput) params.set('search', f.searchInput);
    if (f.startDate) params.set('from', localDayToIso(f.startDate));
    if (f.endDate) params.set('to', localDayToIso(f.endDate, true));
    // Relative ranges are recalculated on every load, so the window keeps sliding
    if (!f.startDate && !f.endDate && RANGES[timeRange]) {
        params.set('from', new Date(Date.now() - RANGES[timeRange].ms).toISOString());
    }
    return params;
}

async function loadRequests(page = currentPage) {
    const f = currentFilters();
    saveSetting('rb_query_params', JSON.stringify({ ...f, page, pageSize, timeRange }));
    try {
        const params = filterParams(f);
        params.set('page', page);
        params.set('pageSize', pageSize);
        const { response, data } = await apiJson(`/api/requests?${params}`);
        if (!response.ok) throw new Error(data.error || response.statusText);
        requests = data.requests;
        currentPage = data.page;
        totalPages = data.totalPages;
        totalMatching = data.total;
        $('requestInfo').textContent = `${data.total} ${hasFilters(f) || f.binId ? 'matching' : 'total'}`;
        if (!hasFilters(f) && !f.binId) $('navCount').textContent = data.total || '';
    } catch (error) {
        requests = [];
        totalPages = 1;
        $('requestInfo').textContent = 'Could not load requests';
    }
    renderRequests();
    updatePagination();
}

const reloadCurrentPage = () => loadRequests(currentPage);

function methodBadge(method) {
    return el('span', `method-badge method-${method.toLowerCase()}`, method);
}

function renderRequests() {
    const list = $('requestList');
    list.replaceChildren();
    $('selectAllCheckbox').checked = false;
    updateSelectionInfo();

    if (requests.length === 0) {
        const f = currentFilters();
        let text = 'No requests match these filters.';
        if (!hasFilters(f)) {
            text = bins.length === 0
                ? 'No bins yet. Create one on the Bins page, then send requests to its URL.'
                : 'Nothing captured yet. Send a request to a bin URL (see the Bins page).';
        }
        list.appendChild(el('li', 'empty-state', text));
        showDetails(null);
        return;
    }

    if (!requests.some(r => r.id === selectedId)) selectedId = requests[0].id;

    for (const req of requests) {
        const li = el('li', 'message-row request-row');
        li.dataset.id = String(req.id);
        if (req.id === selectedId) li.classList.add('selected');
        li.addEventListener('click', event => {
            if (event.target.closest('.row-check')) return;
            selectRequest(req.id);
        });

        const check = el('input', 'message-checkbox');
        check.type = 'checkbox';
        check.dataset.id = String(req.id);
        check.setAttribute('aria-label', `Select request ${req.id}`);
        check.addEventListener('change', updateSelectionInfo);
        const checkWrap = el('label', 'row-check admin-only');
        checkWrap.appendChild(check);

        const top = el('div', 'row-top');
        top.appendChild(methodBadge(req.method));
        top.appendChild(el('span', 'row-path', req.path + (req.queryString ? `?${req.queryString}` : '')));
        top.appendChild(el('span', 'spacer'));
        const time = el('time', 'row-time', relativeTime(req.createdAt));
        time.title = new Date(req.createdAt).toLocaleString();
        top.appendChild(time);

        const meta = [req.binName || 'Deleted bin', req.contentType ? req.contentType.split(';')[0] : null, formatBytes(req.bodySize), req.ip]
            .filter(Boolean)
            .join(' · ');
        const body = el('div', 'row-body');
        body.appendChild(top);
        body.appendChild(el('div', 'row-text', meta));

        li.appendChild(checkWrap);
        li.appendChild(body);
        list.appendChild(li);
    }
    if (!selectedDetail || selectedDetail.id !== selectedId) selectRequest(selectedId);
}

async function selectRequest(id) {
    selectedId = id;
    document.querySelectorAll('.request-row').forEach(row => row.classList.toggle('selected', row.dataset.id === String(id)));
    try {
        const { response, data } = await apiJson(`/api/requests/${id}`);
        if (selectedId !== id) return; // another row was clicked meanwhile
        showDetails(response.ok ? data : null);
    } catch {
        showDetails(null);
    }
}

function kvTable(rows, emptyText) {
    if (rows.length === 0) return el('p', 'muted small-note', emptyText);
    const table = el('table', 'kv-table');
    const tbody = table.createTBody();
    for (const [name, value] of rows) {
        const tr = tbody.insertRow();
        tr.appendChild(el('th', null, name));
        tr.appendChild(el('td', value === '[redacted]' ? 'redacted' : null, value));
    }
    return table;
}

// --- Detail pane tabs ---

const DETAIL_TABS = ['request', 'body', 'headers', 'response'];
let activeDetailTab = readSetting('rb_detail_tab', 'body');
if (!DETAIL_TABS.includes(activeDetailTab)) activeDetailTab = 'body';

// Shows one tab's panel; the choice is remembered, so it stays while moving between requests
function setDetailTab(name, { focus = false } = {}) {
    if (!DETAIL_TABS.includes(name)) return;
    activeDetailTab = name;
    saveSetting('rb_detail_tab', name);
    document.querySelectorAll('.detail-tab').forEach(tab => {
        const selected = tab.dataset.detailTab === name;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    });
    document.querySelectorAll('[data-detail-panel]').forEach(panel => {
        panel.classList.toggle('hidden', panel.dataset.detailPanel !== name);
    });
}

function initDetailTabs() {
    document.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => setDetailTab(tab.dataset.detailTab));
    });
    // Arrow keys, Home and End move between the tabs
    document.querySelector('.detail-tabs').addEventListener('keydown', event => {
        const index = DETAIL_TABS.indexOf(activeDetailTab);
        const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: DETAIL_TABS.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        setDetailTab(DETAIL_TABS[(target + DETAIL_TABS.length) % DETAIL_TABS.length], { focus: true });
    });
    setDetailTab(activeDetailTab);
}

function showDetails(detail) {
    selectedDetail = detail;
    $('detailEmpty').classList.toggle('hidden', Boolean(detail));
    $('detailBody').classList.toggle('hidden', !detail);
    if (!detail) return;

    const badge = $('detailMethod');
    badge.textContent = detail.method;
    badge.className = `method-badge method-${detail.method.toLowerCase()}`;
    $('detailPath').textContent = detail.path + (detail.queryString ? `?${detail.queryString}` : '');
    $('detailBin').textContent = detail.binName || 'Deleted bin';
    $('detailTime').textContent = new Date(detail.createdAt).toLocaleString();
    $('detailIp').textContent = detail.ip || '';
    $('detailContentType').textContent = detail.contentType || '—';
    $('detailSize').textContent = formatBytes(detail.bodySize);

    renderBody(detail);

    $('queryCount').textContent = detail.query.length || '';
    $('detailQuery').replaceChildren(kvTable(detail.query.map(q => [q.name, q.value]), 'No query parameters'));
    const headers = Object.entries(detail.headers);
    $('headerCount').textContent = headers.length || '';
    $('detailHeaders').replaceChildren(kvTable(headers, 'No headers'));
    renderResponse(detail.response);
    renderForward(detail.forward);
    resetReplay();
}

// The response the bin sent for this request: status, the rule that chose it, and the body
function renderResponse(response) {
    $('detailResponseNone').classList.toggle('hidden', Boolean(response));
    $('detailResponseContent').classList.toggle('hidden', !response);
    $('responseTabBadge').textContent = response ? response.status : '';
    $('responseStatus').textContent = response ? `${response.status}${response.contentType ? ` · ${response.contentType}` : ''}` : '';
    $('responseRule').textContent = response && response.ruleName ? `rule: ${response.ruleName}` : '';
    if (!response) return;
    if (!response.body) {
        $('detailResponseContent').replaceChildren(el('span', 'muted', 'Empty body'));
        return;
    }
    MessageFormat.renderMessage($('detailResponseContent'), response.body, { contentType: response.contentType, encoding: 'utf8', view: '' });
}

// Renders the body as JSON / form / multipart / HTML / XML / syslog / binary / text (see formatters.js)
// with a view switcher. The chosen view is remembered per format.
function renderBody(detail, view) {
    const options = { contentType: detail.contentType, encoding: detail.bodyEncoding };
    const format = MessageFormat.detectFormat(detail.body, options);
    const chosen = view || readSetting(`rb_view_${format}`, '');
    const result = MessageFormat.renderMessage($('detailBodyContent'), detail.body, { ...options, view: chosen });

    $('formatBadge').textContent = detail.body ? MessageFormat.LABELS[result.format] : '';
    $('formatBadge').dataset.format = result.format;
    $('formatBadge').classList.toggle('hidden', !detail.body);
    const switcher = $('viewSwitch');
    switcher.replaceChildren();
    for (const name of result.views) {
        const button = el('button', name === result.view ? 'active' : '', MessageFormat.LABELS[name]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(name === result.view));
        button.addEventListener('click', () => {
            saveSetting(`rb_view_${result.format}`, name);
            renderBody(detail, name);
        });
        switcher.appendChild(button);
    }
}

// A cURL command that replays the captured request against the same bin
function toCurl(detail) {
    const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
    const parts = [`curl -X ${detail.method} ${shellQuote(captureUrl(detail.binId, detail.path, detail.queryString))}`];
    for (const [name, value] of Object.entries(detail.headers)) {
        if (!skip.has(name)) parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
    }
    if (detail.body && detail.bodyEncoding === 'utf8') parts.push(`--data-raw ${shellQuote(detail.body)}`);
    if (detail.body && detail.bodyEncoding === 'base64') parts.push('--data-binary @body.bin  # binary body: save it from the API as body.bin');
    return parts.join(' \\\n  ');
}

// Up/down arrow keys move through the list
function moveSelection(step) {
    const idx = requests.findIndex(r => r.id === selectedId);
    const next = requests[idx + step];
    if (!next) return;
    selectRequest(next.id);
    const row = document.querySelector(`.request-row[data-id="${next.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
}

// --- Live updates ---

let stream = null;
let streamBin = null;
let refreshTimer = 0;

function connectStream() {
    const binId = $('binFilter').value || null;
    if (stream && streamBin === binId) return;
    if (stream) stream.close();
    streamBin = binId;
    stream = new EventSource(`/api/stream${binId ? `?bin=${binId}` : ''}`);
    stream.onopen = () => $('liveIndicator').classList.add('on');
    stream.onerror = () => $('liveIndicator').classList.remove('on');
    stream.addEventListener('request', () => {
        // Refresh the first page right away (debounced for bursts); elsewhere just count
        if (currentView() === 'requests' && currentPage === 1) {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(reloadCurrentPage, 250);
        }
    });
}

// --- Resizable detail pane ---

const DEFAULT_DETAIL_RATIO = 0.48;
const MIN_DETAIL_PX = 320;
const MIN_LIST_PX = 340;

// The detail pane width is stored as a share of the layout, so it adapts when the window is resized
function applyDetailRatio(ratio) {
    const layout = document.querySelector('.messages-layout');
    const width = layout.getBoundingClientRect().width;
    if (!width) return;
    const px = Math.min(Math.max(ratio * width, MIN_DETAIL_PX), Math.max(MIN_DETAIL_PX, width - MIN_LIST_PX));
    layout.style.setProperty('--detail-width', `${Math.round(px)}px`);
    $('paneResizer').setAttribute('aria-valuenow', String(Math.round((px / width) * 100)));
}

function initPaneResizer() {
    const layout = document.querySelector('.messages-layout');
    const resizer = $('paneResizer');
    let ratio = parseFloat(readSetting('rb_detail_ratio', '')) || DEFAULT_DETAIL_RATIO;
    const apply = () => applyDetailRatio(ratio);
    const save = () => saveSetting('rb_detail_ratio', ratio.toFixed(3));
    resizer.setAttribute('aria-valuemin', '20');
    resizer.setAttribute('aria-valuemax', '75');

    resizer.addEventListener('pointerdown', event => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        const onMove = moveEvent => {
            const rect = layout.getBoundingClientRect();
            ratio = Math.min(Math.max((rect.right - moveEvent.clientX) / rect.width, 0.2), 0.75);
            apply();
        };
        const onUp = () => {
            resizer.removeEventListener('pointermove', onMove);
            resizer.removeEventListener('pointerup', onUp);
            resizer.removeEventListener('pointercancel', onUp);
            document.body.classList.remove('resizing');
            save();
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
    });
    resizer.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        ratio = Math.min(Math.max(ratio + (event.key === 'ArrowLeft' ? 0.02 : -0.02), 0.2), 0.75);
        apply();
        save();
    });
    resizer.addEventListener('dblclick', () => {
        ratio = DEFAULT_DETAIL_RATIO;
        apply();
        save();
    });
    window.addEventListener('resize', apply);
    window.addEventListener('hashchange', () => requestAnimationFrame(apply));
    apply();
}

// --- Requests: pagination, filters, selection ---

function updatePagination() {
    $('prevPage').disabled = currentPage <= 1;
    $('nextPage').disabled = currentPage >= totalPages;
    $('pageInfo').textContent = `${currentPage} / ${totalPages}`;
}

async function changePage(direction) {
    await loadRequests(Math.min(Math.max(1, currentPage + direction), totalPages));
}

async function changePageSize() {
    pageSize = parseInt($('pageSizeSelect').value, 10);
    await loadRequests(1);
}

async function filterRequests() {
    connectStream();
    await loadRequests(1);
}

async function resetFilters() {
    $('binFilter').value = '';
    $('methodFilter').value = '';
    $('searchInput').value = '';
    $('startDate').value = '';
    $('endDate').value = '';
    timeRange = 'all';
    renderRange();
    await filterRequests();
}

// Picking dates in the toolbar switches the sidebar range to "Custom dates"
async function onDateChange() {
    timeRange = $('startDate').value || $('endDate').value ? 'custom' : 'all';
    renderRange();
    await filterRequests();
}

// Opens the Requests page filtered to one bin
function showBinRequests(binId) {
    $('binFilter').value = binId;
    saveSetting('rb_query_params', JSON.stringify({ ...currentFilters(), binId, page: 1, pageSize, timeRange }));
    location.hash = '#/requests';
}

async function reloadWithSavedParams() {
    await loadBins();
    try {
        const saved = JSON.parse(readSetting('rb_query_params', 'null'));
        if (saved) {
            $('binFilter').value = binById(saved.binId) ? saved.binId : '';
            $('methodFilter').value = saved.method || '';
            $('searchInput').value = saved.searchInput || '';
            $('startDate').value = saved.startDate || '';
            $('endDate').value = saved.endDate || '';
            timeRange = RANGES[saved.timeRange] || saved.timeRange === 'custom' ? saved.timeRange : 'all';
            if ([25, 50, 100].includes(saved.pageSize)) pageSize = saved.pageSize;
            $('pageSizeSelect').value = String(pageSize);
            renderRange();
            connectStream();
            return loadRequests(saved.page || 1);
        }
    } catch {
        // fall through
    }
    connectStream();
    return loadRequests(1);
}

function selectedIds() {
    return Array.from(document.querySelectorAll('.message-checkbox:checked')).map(c => Number(c.dataset.id));
}

function updateSelectionInfo() {
    const count = selectedIds().length;
    $('selectionInfo').textContent = count ? `${count} selected` : '';
    $('deleteSelectedButton').disabled = count === 0;
    $('selectAllCheckbox').checked = count > 0 && count === requests.length;
}

function toggleSelectAll(checked) {
    document.querySelectorAll('.message-checkbox').forEach(c => (c.checked = checked));
    updateSelectionInfo();
}

// --- Export ---

function toggleExportMenu(open = $('exportMenu').classList.contains('hidden')) {
    $('exportMenu').classList.toggle('hidden', !open);
    $('exportButton').setAttribute('aria-expanded', String(open));
    if (!open) return;
    const ids = selectedIds();
    $('exportMenuTitle').textContent = ids.length
        ? `Export the ${ids.length} selected request${ids.length === 1 ? '' : 's'}`
        : `Export ${totalMatching > 1000 ? 'the newest 1000 of ' : ''}${totalMatching} matching request${totalMatching === 1 ? '' : 's'}`;
    $('exportMenu').querySelector('button').focus();
}

// Downloads the selected requests, or everything matching the filters
async function exportRequests(format) {
    toggleExportMenu(false);
    const ids = selectedIds();
    const params = ids.length ? new URLSearchParams({ ids: ids.join(',') }) : filterParams(currentFilters());
    params.set('format', format);
    try {
        const response = await apiFetch(`/api/requests/export?${params}`);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
        const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '');
        const link = el('a');
        link.href = URL.createObjectURL(await response.blob());
        link.download = name ? name[1] : `request-bin.${format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
        alert(`Export failed: ${error.message}`);
    }
}

async function deleteSelectedRequests() {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} request(s)? This can't be undone.`)) return;
    const { response } = await apiJson('/api/requests', { method: 'DELETE', body: JSON.stringify({ ids }) });
    if (!response.ok) alert('Failed to delete the selected requests.');
    await reloadCurrentPage();
}

// --- Forwarding (in the bin form) and replay (in the detail pane) ---

let forwardingEnabled = false; // the server has FORWARD_ALLOWED_HOSTS set

function buildForwardMethods() {
    const box = $('binForwardMethods');
    for (const method of RULE_METHODS) {
        const label = el('label', 'check-label');
        const input = el('input');
        input.type = 'checkbox';
        input.value = method;
        label.appendChild(input);
        label.appendChild(el('span', null, method));
        box.appendChild(label);
    }
}

function updateForwardSummary() {
    $('binForwardSummary').textContent = $('binForwardEnabled').checked ? 'Forwarding (on)' : 'Forwarding';
}

function fillForwardForm(bin) {
    const config = bin ? bin.forwardConfig : { enabled: false, url: '', methods: [] };
    $('binForwardEnabled').checked = config.enabled;
    $('binForwardUrl').value = config.url;
    $('binForwardMethods').querySelectorAll('input').forEach(input => { input.checked = config.methods.includes(input.value); });
    $('binForwardOff').classList.toggle('hidden', forwardingEnabled);
    $('binForwardDetails').open = config.enabled;
    updateForwardSummary();
}

function readForwardForm() {
    return {
        enabled: $('binForwardEnabled').checked,
        url: $('binForwardUrl').value.trim(),
        methods: [...$('binForwardMethods').querySelectorAll('input:checked')].map(input => input.value),
    };
}

// What automatic forwarding did with the selected request
function renderForward(forward) {
    $('detailForwardSection').classList.toggle('hidden', !forward);
    if (!forward) return;
    const line = forward.error
        ? el('p', 'form-status error', `Could not forward to ${forward.target}: ${forward.error}`)
        : el('p', null, `Forwarded to ${forward.target}: ${forward.status} ${forward.statusText} in ${forward.durationMs} ms`);
    $('detailForward').replaceChildren(line);
}

function resetReplay() {
    $('replayPanel').classList.add('hidden');
    $('replayStatus').textContent = '';
    $('replayStatus').classList.remove('error');
    $('replayResult').classList.add('hidden');
}

async function sendReplay() {
    if (!selectedDetail) return;
    const url = $('replayUrl').value.trim();
    const status = $('replayStatus');
    const result = $('replayResult');
    result.classList.add('hidden');
    status.classList.remove('error');
    if (!url) {
        status.classList.add('error');
        status.textContent = 'Enter the URL to send the request to.';
        return;
    }
    saveSetting('rb_replay_url', url);
    $('replaySend').disabled = true;
    status.textContent = 'Sending…';
    try {
        const body = { url, ...($('replayMethod').value && { method: $('replayMethod').value }) };
        const { response, data } = await apiJson(`/api/requests/${selectedDetail.id}/replay`, { method: 'POST', body: JSON.stringify(body) });
        if (!response.ok) {
            status.classList.add('error');
            status.textContent = data.details
                ? Object.entries(data.details).map(([field, msg]) => `${field} ${msg}.`).join(' ')
                : data.error || 'Could not replay the request.';
            return;
        }
        status.textContent = `${data.status} ${data.statusText} in ${data.durationMs} ms${data.truncated ? ' (reply cut short)' : ''}`;
        result.textContent = data.body.length > 4000 ? `${data.body.slice(0, 4000)}\n… (${data.body.length - 4000} more characters)` : data.body;
        result.classList.toggle('hidden', data.body === '');
    } finally {
        $('replaySend').disabled = false;
    }
}

// --- Bins page ---

// --- Response rules editor (in the bin form) ---

const RULE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const RULE_CONTENT_TYPES = ['application/json', 'text/plain', 'application/xml', 'text/xml', 'text/html'];

function ruleInput(type, className, value, placeholder, extra = {}) {
    const input = el('input', className);
    input.type = type;
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    input.autocomplete = 'off';
    Object.assign(input, extra);
    return input;
}

function ruleSelect(options, value, anyLabel) {
    const select = el('select');
    if (anyLabel) select.appendChild(new Option(anyLabel, ''));
    options.forEach(option => select.appendChild(new Option(option, option)));
    select.value = value || '';
    return select;
}

function ruleField(label, ...controls) {
    const wrap = el('label', 'rule-field');
    wrap.appendChild(el('span', 'rule-label', label));
    const row = el('span', 'rule-controls');
    controls.forEach(control => row.appendChild(control));
    wrap.appendChild(row);
    return wrap;
}

function updateRulesSummary() {
    const count = $('binRules').children.length;
    $('binRulesSummary').textContent = count ? `Response rules (${count})` : 'Response rules';
}

function moveRule(card, direction) {
    const sibling = direction < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling) return;
    if (direction < 0) card.parentNode.insertBefore(card, sibling);
    else card.parentNode.insertBefore(sibling, card);
    renumberRules();
}

function renumberRules() {
    [...$('binRules').children].forEach((card, i) => {
        card.querySelector('.rule-number').textContent = `Rule ${i + 1}`;
    });
    updateRulesSummary();
}

// One rule as an editable card; card.readRule() returns the rule as the API expects it
function ruleCard(rule = {}) {
    const match = rule.match || {};
    const response = rule.response || {};
    const card = el('div', 'rule-card');

    const head = el('div', 'rule-head');
    head.appendChild(el('strong', 'rule-number', 'Rule'));
    const name = ruleInput('text', 'rule-name', rule.name, 'Name (optional)', { maxLength: 100 });
    head.appendChild(name);
    head.appendChild(iconButton('up', 'Move up', () => moveRule(card, -1)));
    head.appendChild(iconButton('down', 'Move down', () => moveRule(card, 1)));
    head.appendChild(iconButton('trash', 'Remove rule', () => {
        card.remove();
        renumberRules();
    }, { danger: true }));
    card.appendChild(head);
    head.querySelectorAll('button').forEach(b => { b.type = 'button'; });

    card.appendChild(el('div', 'rule-section', 'When the request matches'));
    const grid = el('div', 'rule-grid');
    const method = ruleSelect(RULE_METHODS, match.method, 'Any method');
    const path = ruleInput('text', null, match.path, '/orders/*', { maxLength: 200 });
    const headerName = ruleInput('text', null, match.header && match.header.name, 'X-Event', { maxLength: 200 });
    const headerValue = ruleInput('text', null, match.header && match.header.value, 'any value', { maxLength: 200 });
    const queryName = ruleInput('text', null, match.query && match.query.name, 'mode', { maxLength: 200 });
    const queryValue = ruleInput('text', null, match.query && match.query.value, 'any value', { maxLength: 200 });
    const bodyPath = ruleInput('text', null, match.body && match.body.path, 'order.status', { maxLength: 200 });
    const bodyValue = ruleInput('text', null, match.body && match.body.value, 'any value', { maxLength: 200 });
    grid.appendChild(ruleField('Method', method));
    grid.appendChild(ruleField('Path', path));
    grid.appendChild(ruleField('Header', headerName, headerValue));
    grid.appendChild(ruleField('Query parameter', queryName, queryValue));
    grid.appendChild(ruleField('JSON or form field', bodyPath, bodyValue));
    card.appendChild(grid);

    card.appendChild(el('div', 'rule-section', 'Respond with'));
    const out = el('div', 'rule-grid');
    const status = ruleInput('number', null, response.status, '(bin default)', { min: 200, max: 599 });
    const type = ruleSelect(RULE_CONTENT_TYPES, response.contentType, '(bin default)');
    const delay = ruleInput('number', null, response.delayMs, '(bin default)', { min: 0, max: 30000, step: 100 });
    const template = ruleSelect(['yes', 'no'], response.template === undefined ? '' : response.template ? 'yes' : 'no', '(bin default)');
    const body = el('textarea', 'rule-body');
    body.rows = 2;
    body.placeholder = '(bin default)';
    body.value = response.body ?? '';
    body.dataset.set = response.body === undefined ? '' : '1';
    body.addEventListener('input', () => { body.dataset.set = '1'; });
    out.appendChild(ruleField('Status', status));
    out.appendChild(ruleField('Content type', type));
    out.appendChild(ruleField('Delay (ms)', delay));
    out.appendChild(ruleField('Fill in placeholders', template));
    const bodyField = ruleField('Body', body);
    bodyField.classList.add('rule-wide');
    out.appendChild(bodyField);
    card.appendChild(out);

    const text = input => input.value.trim();
    card.readRule = () => {
        const rule = {};
        if (text(name)) rule.name = text(name);
        rule.match = {};
        if (method.value) rule.match.method = method.value;
        if (text(path)) rule.match.path = text(path);
        for (const [key, nameInput, valueInput, field] of [
            ['header', headerName, headerValue, 'name'],
            ['query', queryName, queryValue, 'name'],
            ['body', bodyPath, bodyValue, 'path'],
        ]) {
            if (!text(nameInput)) continue;
            rule.match[key] = { [field]: text(nameInput), ...(valueInput.value !== '' && { value: valueInput.value }) };
        }
        rule.response = {};
        if (status.value !== '') rule.response.status = Number(status.value);
        if (type.value) rule.response.contentType = type.value;
        if (delay.value !== '') rule.response.delayMs = Number(delay.value);
        if (template.value) rule.response.template = template.value === 'yes';
        if (body.dataset.set) rule.response.body = body.value;
        return rule;
    };
    return card;
}

function renderRules(rules) {
    const list = $('binRules');
    list.replaceChildren(...rules.map(ruleCard));
    renumberRules();
    $('binRulesDetails').open = rules.length > 0;
}

function readRules() {
    return [...$('binRules').children].map(card => card.readRule());
}

let editingBin = null; // the bin being edited, or null when creating

function binResponseSummary(bin) {
    return [
        bin.responseStatus,
        bin.responseContentType,
        ...(bin.responseTemplate ? ['templated'] : []),
        ...(bin.responseDelayMs ? [`${bin.responseDelayMs} ms delay`] : []),
        ...(bin.forwardConfig.enabled ? ['forwards'] : []),
        ...(bin.responseRules.length ? [`${bin.responseRules.length} rule${bin.responseRules.length === 1 ? '' : 's'}`] : []),
    ].join(' · ');
}

function binRow(bin) {
    const tr = el('tr');
    const nameCell = el('td', 'key-name');
    nameCell.appendChild(el('span', null, bin.name));
    tr.appendChild(nameCell);

    const urlCell = el('td', 'key-value');
    const url = captureUrl(bin.id);
    urlCell.appendChild(el('code', null, url));
    const copy = el('button', 'ghost small', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(url, copy));
    const actions = el('span', 'key-actions');
    actions.appendChild(copy);
    urlCell.appendChild(actions);
    tr.appendChild(urlCell);

    tr.appendChild(el('td', 'num', String(bin.requestCount)));
    tr.appendChild(el('td', 'muted', bin.lastRequestAt ? relativeTime(bin.lastRequestAt) : 'Never'));
    tr.appendChild(el('td', 'muted mono', binResponseSummary(bin)));

    const secretCell = el('td');
    secretCell.appendChild(el('span', bin.hasSecret ? 'scope-badge scope-read' : 'muted', bin.hasSecret ? 'Required' : 'None'));
    if (bin.hasSecret && userRole === 'admin') {
        const copySecret = el('button', 'ghost small secret-copy', 'Copy');
        copySecret.type = 'button';
        copySecret.addEventListener('click', async () => {
            const { response, data } = await apiJson(`/api/bins/${bin.id}/secret/reveal`, { method: 'POST' });
            if (!response.ok) return alert(data.error || 'Could not show the secret.');
            copyText(data.secret, copySecret);
        });
        secretCell.appendChild(copySecret);
    }
    tr.appendChild(secretCell);

    const actionCell = el('td', 'key-row-action bin-actions');
    actionCell.appendChild(iconButton('inbox', 'View requests', () => showBinRequests(bin.id)));
    if (userRole === 'admin') {
        actionCell.appendChild(iconButton('edit', 'Edit bin', () => openBinForm(bin)));
        actionCell.appendChild(iconButton('eraser', 'Clear requests', () => clearBin(bin)));
        actionCell.appendChild(iconButton('trash', 'Delete bin', () => deleteBin(bin), { danger: true }));
    }
    tr.appendChild(actionCell);
    return tr;
}

function renderBins() {
    const body = $('binsBody');
    body.replaceChildren();
    bins.forEach(bin => body.appendChild(binRow(bin)));
    $('binsEmpty').classList.toggle('hidden', bins.length > 0);
    document.querySelector('.bins-table').classList.toggle('hidden', bins.length === 0);
}

function openBinForm(bin = null) {
    editingBin = bin;
    $('binForm').classList.remove('hidden');
    $('newBinButton').classList.add('hidden');
    $('binResult').classList.add('hidden');
    $('binFormError').textContent = '';
    $('binFormTitle').textContent = bin ? `Edit "${bin.name}"` : 'New bin';
    $('saveBinButton').textContent = bin ? 'Save changes' : 'Create bin';
    $('binNameInput').value = bin ? bin.name : '';
    $('binStatusInput').value = bin ? bin.responseStatus : 200;
    $('binTypeInput').value = bin ? bin.responseContentType : 'application/json';
    $('binBodyInput').value = bin ? bin.responseBody : '{"ok":true}';
    $('binTemplateInput').checked = bin ? bin.responseTemplate : false;
    $('binDelayInput').value = bin ? bin.responseDelayMs : 0;
    renderRules(bin ? bin.responseRules : []);
    fillForwardForm(bin);
    $('binRedactInput').checked = bin ? bin.redactHeaders : true;
    $('binSecretInput').checked = false;
    // New bins: a checkbox. Existing bins: add / replace / remove buttons
    $('binSecretField').classList.toggle('hidden', Boolean(bin));
    $('binSecretManage').classList.toggle('hidden', !bin);
    if (bin) {
        $('binSecretStatus').textContent = bin.hasSecret ? 'This bin requires a secret.' : 'This bin has no secret.';
        $('binSecretAdd').classList.toggle('hidden', bin.hasSecret);
        $('binSecretRotate').classList.toggle('hidden', !bin.hasSecret);
        $('binSecretRemove').classList.toggle('hidden', !bin.hasSecret);
    }
    $('binNameInput').focus();
}

function closeBinForm() {
    editingBin = null;
    $('binForm').classList.add('hidden');
    $('newBinButton').classList.remove('hidden');
}

function binExample(bin, secret) {
    return [
        `curl -X POST ${shellQuote(captureUrl(bin.id, '/webhook'))} \\`,
        '  -H "Content-Type: application/json" \\',
        ...(secret ? [`  -H ${shellQuote(`X-Bin-Secret: ${secret}`)} \\`] : []),
        `  -d '{"event": "order.created", "id": 42}'`,
    ].join('\n');
}

function showBinResult(title, bin, secret) {
    $('binResultTitle').textContent = title;
    $('binResultUrl').textContent = captureUrl(bin.id);
    $('binResultSecretRow').classList.toggle('hidden', !secret);
    $('binResultSecret').textContent = secret || '';
    $('binResultExample').textContent = binExample(bin, secret);
    $('binResult').classList.remove('hidden');
}

async function saveBin(event) {
    event.preventDefault();
    const settings = {
        name: $('binNameInput').value.trim() || undefined,
        responseStatus: Number($('binStatusInput').value),
        responseContentType: $('binTypeInput').value,
        responseBody: $('binBodyInput').value,
        responseTemplate: $('binTemplateInput').checked,
        responseDelayMs: Number($('binDelayInput').value) || 0,
        responseRules: readRules(),
        forwardConfig: readForwardForm(),
        redactHeaders: $('binRedactInput').checked,
    };
    if (editingBin && !settings.name) {
        $('binFormError').textContent = 'Give the bin a name.';
        return;
    }
    $('saveBinButton').disabled = true;
    try {
        const { response, data } = editingBin
            ? await apiJson(`/api/bins/${editingBin.id}`, { method: 'PATCH', body: JSON.stringify(settings) })
            : await apiJson('/api/bins', { method: 'POST', body: JSON.stringify({ ...settings, withSecret: $('binSecretInput').checked }) });
        if (!response.ok) {
            $('binFormError').textContent = data.details
                ? Object.entries(data.details).map(([field, msg]) => `${field} ${msg}.`).join(' ')
                : data.error || 'Could not save the bin.';
            return;
        }
        const wasEditing = Boolean(editingBin);
        closeBinForm();
        if (!wasEditing) showBinResult(`Bin created: ${data.bin.name}`, data.bin, data.secret);
        await loadBins();
        renderBins();
    } finally {
        $('saveBinButton').disabled = false;
    }
}

async function changeBinSecret(action) {
    const bin = editingBin;
    if (action === 'remove' && !confirm(`Remove the secret from "${bin.name}"?\n\nAnyone who knows the URL can then send to it.`)) return;
    if (action === 'rotate' && !confirm(`Replace the secret of "${bin.name}"?\n\nSenders using the old secret get 401 until they're updated.`)) return;
    const { response, data } = await apiJson(`/api/bins/${bin.id}/secret`, { method: action === 'remove' ? 'DELETE' : 'POST' });
    if (!response.ok) return alert(data.error || 'Could not change the secret.');
    closeBinForm();
    await loadBins();
    renderBins();
    if (data.secret) showBinResult(`New secret for ${bin.name}`, bin, data.secret);
}

async function clearBin(bin) {
    if (!confirm(`Delete all ${bin.requestCount} request(s) captured in "${bin.name}"?`)) return;
    await apiJson(`/api/bins/${bin.id}/requests`, { method: 'DELETE' });
    await loadBins();
    renderBins();
}

async function deleteBin(bin) {
    if (!confirm(`Delete the bin "${bin.name}" and its ${bin.requestCount} captured request(s)?\n\nIts URL stops working. This can't be undone.`)) return;
    await apiJson(`/api/bins/${bin.id}`, { method: 'DELETE' });
    await loadBins();
    renderBins();
}

// --- Send test ---

const SAMPLES = {
    'application/json': '{"event": "order.created", "id": 42, "amount": 19.99, "paid": true}',
    'application/x-www-form-urlencoded': 'name=Ada+Lovelace&email=ada%40example.com&plan=pro',
    'text/plain': 'Hello from the Request Bin dashboard',
    'application/xml': '<?xml version="1.0"?><order><id>42</id><status>created</status></order>',
    '': '',
};

function prepareSendForm() {
    fillBinSelect($('sendBin'), bins.length ? null : 'Create a bin first');
    $('sendButton').disabled = bins.length === 0;
    updateSendCurl();
}

function sendTarget() {
    const path = $('sendPath').value.trim() || '/';
    return captureUrl($('sendBin').value, path.startsWith('/') ? path : `/${path}`);
}

function updateSendCurl() {
    if (!$('sendBin').value) {
        $('sendCurl').textContent = '';
        return;
    }
    const type = $('sendType').value;
    const body = $('sendBody').value;
    const bin = binById($('sendBin').value);
    $('sendCurl').textContent = [
        `curl -X ${$('sendMethod').value} ${shellQuote(sendTarget())}`,
        ...(type ? [`-H ${shellQuote(`Content-Type: ${type}`)}`] : []),
        ...(bin && bin.hasSecret ? ['-H "X-Bin-Secret: $BIN_SECRET"'] : []),
        ...(body && $('sendMethod').value !== 'GET' ? [`--data-raw ${shellQuote(body)}`] : []),
    ].join(' \\\n  ');
}

async function sendTestRequest(event) {
    event.preventDefault();
    const bin = binById($('sendBin').value);
    if (!bin) return;
    const method = $('sendMethod').value;
    const headers = {};
    if ($('sendType').value) headers['Content-Type'] = $('sendType').value;
    $('sendButton').disabled = true;
    $('sendStatus').textContent = 'Sending…';
    $('sendStatus').className = 'form-status';
    try {
        if (bin.hasSecret) {
            const { response, data } = await apiJson(`/api/bins/${bin.id}/secret/reveal`, { method: 'POST' });
            if (!response.ok) throw new Error(data.error || 'Could not read the bin secret');
            headers['X-Bin-Secret'] = data.secret;
        }
        const response = await fetch(sendTarget(), {
            method,
            headers,
            body: method === 'GET' ? undefined : $('sendBody').value,
        });
        const text = await response.text();
        $('sendResponse').textContent = `HTTP ${response.status} ${response.statusText}\n${response.headers.get('content-type') || ''}\n\n${text}`;
        $('sendResponse').classList.remove('muted-code');
        $('sendStatus').textContent = response.ok ? 'Captured.' : `The bin answered ${response.status}.`;
        $('sendStatus').className = `form-status ${response.ok ? 'success' : 'error'}`;
        $('sendViewRequest').classList.remove('hidden');
    } catch (error) {
        $('sendStatus').textContent = error.message || 'Could not send the request.';
        $('sendStatus').className = 'form-status error';
    } finally {
        $('sendButton').disabled = false;
    }
}

// --- API keys ---

// Full keys revealed on this page, by key id. Only kept while the page is open, and cleared when
// navigating to another view.
const revealedKeys = new Map();
let keysData = { keys: [], adminTokenConfigured: false };

function forgetRevealedKeys() {
    revealedKeys.clear();
    $('newKeyResult').classList.add('hidden');
    $('newKeySecret').textContent = '';
    $('newKeyExample').textContent = '';
}

async function loadKeys() {
    try {
        const { response, data } = await apiJson('/api/keys');
        if (!response.ok) throw new Error(data.error || response.statusText);
        keysData = data;
    } catch (error) {
        keysData = { keys: [], adminTokenConfigured: false };
        $('keysFootnote').textContent = `Could not load API keys: ${error.message}`;
    }
    renderKeys();
}

function keyExample(secret) {
    return [`curl -H "Authorization: Bearer ${secret}" \\`, `  "${location.origin}/api/requests?pageSize=5"`].join('\n');
}

// Fetches (once) and returns a key's full value
async function revealKey(id) {
    if (revealedKeys.has(id)) return revealedKeys.get(id);
    const { response, data } = await apiJson(`/api/keys/${id}/reveal`, { method: 'POST' });
    if (!response.ok) throw new Error(data.error || response.statusText);
    revealedKeys.set(id, data.secret);
    return data.secret;
}

function keyRow({ id, name, prefix, lastUsedAt, createdAt, revokedAt }) {
    const tr = el('tr', revokedAt ? 'key-revoked' : '');
    const nameCell = el('td', 'key-name');
    nameCell.appendChild(el('span', null, name));
    tr.appendChild(nameCell);

    const keyCell = el('td', 'key-value');
    const shown = revealedKeys.get(id);
    keyCell.appendChild(el('code', null, shown || `${prefix}…`));
    if (!revokedAt) {
        const actions = el('span', 'key-actions');
        const toggle = el('button', 'ghost small', shown ? 'Hide' : 'Show');
        toggle.type = 'button';
        toggle.addEventListener('click', async () => {
            if (revealedKeys.has(id)) {
                revealedKeys.delete(id);
                return renderKeys();
            }
            try {
                await revealKey(id);
                renderKeys();
            } catch (error) {
                alert(error.message);
            }
        });
        const copy = el('button', 'ghost small', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
            try {
                copyText(await revealKey(id), copy);
            } catch (error) {
                alert(error.message);
            }
        });
        actions.append(toggle, copy);
        keyCell.appendChild(actions);
    }
    tr.appendChild(keyCell);
    tr.appendChild(el('td', 'muted', lastUsedAt ? relativeTime(lastUsedAt) : 'Never'));
    tr.appendChild(el('td', 'muted', new Date(createdAt).toLocaleDateString()));

    const actionCell = el('td', 'key-row-action');
    if (revokedAt) {
        const revoked = el('span', 'revoked-tag', 'Revoked');
        revoked.tabIndex = 0;
        revoked.dataset.tooltip = `Revoked ${new Date(revokedAt).toLocaleString()}`;
        actionCell.appendChild(revoked);
    } else {
        actionCell.appendChild(iconButton('ban', 'Revoke key', () => revokeKey(id, name), { danger: true }));
    }
    tr.appendChild(actionCell);
    return tr;
}

function renderKeys() {
    const body = $('keysBody');
    body.replaceChildren();
    keysData.keys.forEach(key => body.appendChild(keyRow(key)));
    $('keysEmpty').classList.toggle('hidden', keysData.keys.length > 0);
    document.querySelector('.keys-table').classList.toggle('hidden', keysData.keys.length === 0);
    $('keysFootnote').textContent = keysData.adminTokenConfigured
        ? 'ADMIN_TOKEN from .env also gives full API access (including deleting). It is not shown here.'
        : '';
}

function showKeyForm(visible) {
    $('newKeyForm').classList.toggle('hidden', !visible);
    $('newKeyButton').classList.toggle('hidden', visible);
    $('keyNameError').textContent = '';
    $('keyNameInput').classList.remove('invalid');
    if (visible) {
        $('newKeyResult').classList.add('hidden');
        $('keyNameInput').focus();
    } else {
        $('newKeyForm').reset();
    }
}

async function createKey(event) {
    event.preventDefault();
    const name = $('keyNameInput').value.trim();
    if (!name) {
        $('keyNameError').textContent = 'Give the key a name, e.g. the test suite that will use it.';
        $('keyNameInput').classList.add('invalid');
        return;
    }
    $('createKeyButton').disabled = true;
    try {
        const { response, data } = await apiJson('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
        if (!response.ok) {
            $('keyNameError').textContent = data.details && data.details.name ? `Name ${data.details.name}.` : data.error || 'Could not create the key.';
            $('keyNameInput').classList.add('invalid');
            return;
        }
        revealedKeys.set(data.key.id, data.secret);
        showKeyForm(false);
        $('newKeyName').textContent = data.key.name;
        $('newKeySecret').textContent = data.secret;
        $('newKeyExample').textContent = keyExample(data.secret);
        $('newKeyResult').classList.remove('hidden');
        await loadKeys();
    } catch {
        $('keyNameError').textContent = 'Could not reach the server.';
    } finally {
        $('createKeyButton').disabled = false;
    }
}

async function revokeKey(id, name) {
    if (!confirm(`Revoke "${name}"?\n\nAnything using this key stops working immediately. This can't be undone.`)) return;
    const { response, data } = await apiJson(`/api/keys/${id}`, { method: 'DELETE' });
    if (!response.ok) alert(data.error || 'Could not revoke the key.');
    revealedKeys.delete(id);
    await loadKeys();
}

// --- API reference ---

function renderApiReference() {
    const base = location.origin;
    $('captureEndpoint').textContent = `${base}/b/<bin-id>/<any/path>`;
    $('curlCapture').textContent = [
        `curl -X POST "${base}/b/<bin-id>/webhooks/stripe?attempt=1" \\`,
        '  -H "Content-Type: application/json" \\',
        '  -H "X-Bin-Secret: $BIN_SECRET" \\',
        `  -d '{"type": "payment_intent.succeeded", "id": "evt_123"}'`,
    ].join('\n');
    $('curlLatest').textContent = [
        'curl -H "Authorization: Bearer $READ_KEY" \\',
        `  "${base}/api/requests/latest?bin=<bin-id>"`,
    ].join('\n');
    $('jsLatest').textContent = [
        `const res = await fetch('${base}/api/requests/latest?bin=<bin-id>', {`,
        '  headers: { Authorization: `Bearer ${process.env.READ_KEY}` },',
        '});',
        'const { method, path, headers, body } = await res.json();',
        'const payload = JSON.parse(body); // for JSON webhooks',
    ].join('\n');
}

// --- Wiring ---

window.addEventListener('DOMContentLoaded', () => {
    setSidebarCollapsed(readSetting('rb_sidebar_collapsed', 'no') === 'yes');
    renderApiReference();

    $('collapseButton').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
    $('logoutButton').addEventListener('click', logout);

    // Requests
    $('searchButton').addEventListener('click', filterRequests);
    $('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') filterRequests();
    });
    $('binFilter').addEventListener('change', filterRequests);
    $('methodFilter').addEventListener('change', filterRequests);
    $('startDate').addEventListener('change', onDateChange);
    $('endDate').addEventListener('change', onDateChange);
    $('rangeSelect').addEventListener('change', event => setTimeRange(event.target.value));
    $('rangeChip').addEventListener('click', () => setTimeRange('all'));
    initPaneResizer();
    initSidebarResizer();
    $('resetFiltersButton').addEventListener('click', resetFilters);
    $('refreshButton').addEventListener('click', reloadCurrentPage);
    $('prevPage').addEventListener('click', () => changePage(-1));
    $('nextPage').addEventListener('click', () => changePage(1));
    $('pageSizeSelect').addEventListener('change', changePageSize);
    $('selectAllCheckbox').addEventListener('change', event => toggleSelectAll(event.target.checked));
    $('deleteSelectedButton').addEventListener('click', deleteSelectedRequests);
    $('exportButton').addEventListener('click', () => toggleExportMenu());
    $('exportMenu').querySelectorAll('[data-format]').forEach(b => b.addEventListener('click', () => exportRequests(b.dataset.format)));
    document.addEventListener('click', event => {
        if (!event.target.closest('.menu-wrap')) toggleExportMenu(false);
    });
    $('exportMenu').addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            toggleExportMenu(false);
            $('exportButton').focus();
        }
    });
    $('copyUrlButton').addEventListener('click', event => {
        if (selectedDetail) copyText(captureUrl(selectedDetail.binId, selectedDetail.path, selectedDetail.queryString), event.target);
    });
    $('copyCurlButton').addEventListener('click', event => {
        if (selectedDetail) copyText(toCurl(selectedDetail), event.target);
    });
    $('copyBodyButton').addEventListener('click', event => {
        if (selectedDetail) copyText(selectedDetail.body, event.target);
    });
    document.addEventListener('keydown', event => {
        if (currentView() !== 'requests' || event.target.matches('input, textarea, select') || event.target.closest('.menu')) return;
        if (event.key === 'ArrowDown' || event.key === 'j') {
            event.preventDefault();
            moveSelection(1);
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
            event.preventDefault();
            moveSelection(-1);
        }
    });

    // Bins
    $('newBinButton').addEventListener('click', () => openBinForm());
    $('cancelBinButton').addEventListener('click', closeBinForm);
    buildForwardMethods();
    initDetailTabs();
    $('binForwardEnabled').addEventListener('change', updateForwardSummary);
    const replayMethod = $('replayMethod');
    replayMethod.appendChild(new Option('Same method', ''));
    RULE_METHODS.forEach(method => replayMethod.appendChild(new Option(method, method)));
    $('replayButton').addEventListener('click', () => {
        const panel = $('replayPanel');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            if (!$('replayUrl').value) $('replayUrl').value = readSetting('rb_replay_url', '');
            $('replayUrl').focus();
        }
    });
    $('replaySend').addEventListener('click', sendReplay);
    $('replayUrl').addEventListener('keydown', event => {
        if (event.key === 'Enter') sendReplay();
    });
    $('addRuleButton').addEventListener('click', () => {
        $('binRules').appendChild(ruleCard());
        renumberRules();
    });
    $('binForm').addEventListener('submit', saveBin);
    $('binSecretAdd').addEventListener('click', () => changeBinSecret('add'));
    $('binSecretRotate').addEventListener('click', () => changeBinSecret('rotate'));
    $('binSecretRemove').addEventListener('click', () => changeBinSecret('remove'));
    $('dismissBinResult').addEventListener('click', () => $('binResult').classList.add('hidden'));

    // Send test
    $('sendForm').addEventListener('submit', sendTestRequest);
    ['sendMethod', 'sendBin', 'sendPath', 'sendType', 'sendBody'].forEach(id => $(id).addEventListener('input', updateSendCurl));
    $('sendSampleButton').addEventListener('click', () => {
        $('sendBody').value = SAMPLES[$('sendType').value] ?? '';
        updateSendCurl();
    });
    $('sendViewRequest').addEventListener('click', event => {
        event.preventDefault();
        showBinRequests($('sendBin').value);
    });

    // API keys
    $('newKeyButton').addEventListener('click', () => showKeyForm(true));
    $('cancelKeyButton').addEventListener('click', () => showKeyForm(false));
    $('newKeyForm').addEventListener('submit', createKey);
    $('keyNameInput').addEventListener('input', () => {
        $('keyNameError').textContent = '';
        $('keyNameInput').classList.remove('invalid');
    });
    $('copyNewKey').addEventListener('click', event => copyText($('newKeySecret').textContent, event.target));
    $('dismissKeyResult').addEventListener('click', () => $('newKeyResult').classList.add('hidden'));

    // Copy buttons that copy another element's text
    document.querySelectorAll('.copy-button').forEach(button =>
        button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button))
    );

    window.addEventListener('hashchange', showView);
    // Know the role before showing a view, so a viewer never lands on an admin-only page
    loadSession().then(showView);
});
