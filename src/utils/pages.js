const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// The dashboard and sign-in pages, served with versioned asset URLs: every script, stylesheet and icon
// they reference gets `?v=<hash of that file's content>`.
//
// Without it a browser (or a CDN or proxy in front, such as Cloudflare, which caches .js and .css files
// and tells browsers to keep them for hours) can keep serving an old scripts.js or styles.css next to a
// new page, and the two no longer match: a page whose tabs, buttons or layout silently stop working.
// With it, changing a file changes its URL, so nothing stale can be served.

const ASSET_RE = /(\b(?:src|href)=")([A-Za-z0-9._-]+\.(?:js|css|svg))(")/g;

function createPageServer(viewsDir) {
    const hashes = new Map(); // file name -> { mtimeMs, size, hash }

    // A short hash of the file's content, recomputed only when the file changes. null if it doesn't exist.
    function versionOf(name) {
        const file = path.join(viewsDir, name);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            return null;
        }
        const cached = hashes.get(name);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
        const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
        hashes.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
        return hash;
    }

    function render(page) {
        const html = fs.readFileSync(path.join(viewsDir, page), 'utf8');
        return html.replace(ASSET_RE, (match, before, name, after) => {
            const version = versionOf(name);
            return version ? `${before}${name}?v=${version}${after}` : match;
        });
    }

    // Sends a page; never cached, so the next load always sees the current asset versions
    function send(res, page) {
        res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }).send(render(page));
    }

    return { send, render };
}

module.exports = { createPageServer };
