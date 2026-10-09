# Request Bin

A self-hosted HTTP request collector, in the spirit of webhook.site and RequestBin. Create a bin, point a webhook, form, device or script at its URL, and every request sent there is stored and shown in a web dashboard: method, path, query, headers and body, parsed and prettified according to its format.

Built with Node.js and Express. Requests can be stored in SQLite (default), PostgreSQL, or MySQL.

## Features

- **Bins**: each bin has its own capture URL, `/b/<bin id>`. Any method, any sub-path (`/b/<bin id>/webhooks/stripe?attempt=1`) and any content type is captured, up to `MAX_BODY_KB`.
  - Optional per-bin **secret**, sent as an `X-Bin-Secret` header, an `Authorization: Bearer` token or a `?secret=` parameter (stored as `[redacted]`, even with header redaction off). Requests without it get `401` and are not stored.
  - Configurable **response**: status code, content type and body, so senders that check the reply are satisfied.
  - **Response templates**: the body can echo parts of the request, such as `{"received": "{{body.order.id}}", "attempt": {{query.attempt | 1}}}`. See [Response templates](#response-templates).
  - **Response delay** of up to 30 seconds, to test sender timeouts and retries.
  - **Response rules**: different responses by method, path, header, query parameter or body field, so one bin can mock several endpoints. See [Response rules](#response-rules).
  - Sensitive headers (`Authorization`, `Cookie`, `X-API-Key`, …) are **redacted** before storing, on by default and switchable per bin.
- **Dashboard** with a resizable sidebar and a live request list (server-sent events: new requests appear as they arrive):
  - **Requests**: filter by bin, method, text (path, query, headers and body) and time range; bulk delete; **export** the matching or selected requests as **HAR** (for browser dev tools, Postman, Insomnia) or JSON; keyboard navigation (↑/↓ or j/k); a resizable detail pane with copy URL, **copy as cURL** and copy body.
  - Bodies are shown according to their format, with a switch between views:
    - **JSON**: indented and colour-coded, or raw.
    - **Form** (`application/x-www-form-urlencoded`): a name/value table, or raw.
    - **Multipart**: one row per part with name, filename, type, size and text content; binary parts are summarised.
    - **HTML**: a safe preview (sandboxed: scripts and external images blocked), indented source, or raw.
    - **XML**: indented, or raw.
    - **Syslog**: a table with time, host, app, PID and a severity badge, or raw.
    - **Binary**: a hex dump, or base64.
    - **Plain text**: shown as sent, with clickable links.
  - **Bins**: create, rename, configure the response, set/rotate/show/remove the secret, clear or delete.
  - **Send test**: send a sample request of any method and content type into a bin from the browser, with the response shown.
  - **API keys** and **API reference** with copyable examples generated for your server.
- REST API for tests: list and search captured requests, or fetch the newest one (`GET /api/requests/latest?bin=…`) after triggering a webhook.
- Sign-in page with username and password from `.env`, for the admin and for optional read-only viewer accounts.
- Light and dark themes (System, Light, Dark), remembered per browser.
- Rate limiting, security headers (CSP), automatic cleanup of old requests, and a per-bin cap on stored requests.
- Application logs written to `logs/app.log` and stdout, rotated daily. Request bodies are never logged.

## Project Structure

```
src/
  app.js                 startup: config, database, models, retention job, graceful shutdown
  server.js              Express app: security headers, routes, static dashboard
  config.js              environment variables, validated at startup
  events.js              in-process publish/subscribe for the live stream
  database/              sqlite.js (node:sqlite), postgres.js (pg), mysql.js (mysql2), one adapter interface
  middleware/            auth.js (sessions, admin token, Read keys), validate.js
  models/                binModel.js, requestModel.js, apiKeyModel.js
  routes/                captureRoutes.js (/b), binRoutes.js, requestRoutes.js (+ SSE stream), apiKeyRoutes.js
  utils/                 logger, session cookies, API key hashing and encryption, response templates, HAR export
  views/                 dashboard (index.html, scripts.js, formatters.js, styles.css), sign-in page
test/                    node:test suites (npm test)
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22.13 or later (tested with Node.js 22 and 24) and npm. SQLite support is built into Node, so there are no native modules to compile and the same install works on Windows, WSL, Linux, and macOS.
- Optional: a PostgreSQL or MySQL server, if you don't want to use SQLite

## Installation

1. Clone the repository and enter the project directory:
   ```
   git clone <repository-url>
   cd <repository-folder>
   ```

2. Install the dependencies:
   ```
   npm install
   ```

3. Create your `.env` file from the sample:
   ```
   cp sample.env .env        # macOS / Linux / Git Bash
   copy sample.env .env      # Windows cmd / PowerShell
   ```

4. Replace every `change-me` value in `.env`. The server refuses to start while they are still there. To generate a random value:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   See [Environment Configuration](#environment-configuration) for all settings.

## Usage

1. Start the application **from the project root** (the default SQLite file path is relative to the current directory):
   ```
   npm start
   ```
   For development with auto-restart on file changes:
   ```
   npm run dev
   ```

2. Open `http://localhost:30002` in your browser (or whichever `PORT` you set) and sign in with `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD`.

3. Open **Bins**, create a bin, and copy its capture URL. Send something to it:
   ```
   curl -X POST http://localhost:30002/b/<bin id>/hello -H "Content-Type: application/json" -d '{"event":"test"}'
   ```
   It appears under **Requests** straight away. **Send test** does the same from the browser.

To run the tests:
```
npm test
```

The tests use a temporary SQLite database. To run them against PostgreSQL or MySQL, set `TEST_DB_TYPE` and the usual connection variables. The tests empty the tables first, so the database name must contain `test`:
```
TEST_DB_TYPE=postgres PG_HOST=localhost PG_PORT=5432 PG_USER=requestbin PG_PASSWORD=... PG_DATABASE=requestbin_test npm run test:serial
TEST_DB_TYPE=mysql MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=requestbin MYSQL_PASSWORD=... MYSQL_DATABASE=requestbin_test npm run test:serial
```

## Authentication

| Who | How | Can do |
|-----|-----|--------|
| Anything sending requests to a bin | Nothing, or the bin's secret (`X-Bin-Secret` header, `Authorization: Bearer` or `?secret=`) if it has one | `ANY /b/<bin id>/…` only |
| Tests reading captured requests | `Authorization: Bearer <key>` (or `X-API-Key`) with a **Read** key | List bins, list and read requests, live stream |
| Scripts needing full access | `Authorization: Bearer <ADMIN_TOKEN>` from `.env` | Everything |
| Dashboard admin | Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` (sets an HttpOnly session cookie) | Everything |
| Dashboard viewers | Sign in with an account from `VIEWER_USERS` | View bins and requests only: no creating, changing, deleting, sending, or API keys |

### Viewer accounts

To let people look at captured requests without being able to change anything, list them in `.env`:

```
VIEWER_USERS=alice:a-long-password,bob:another-long-password
```

- **What viewers can do:** sign in on the same page as the admin, browse, search and filter all requests, open request details, copy bodies and cURL commands, see the bins list, and read the API reference.
- **What they can't do:** create, change or delete bins, see bin secrets, delete requests, use Send test, or see or manage API keys. Their sidebar doesn't show those actions, and the server refuses them with `403` as well.
- **Format:** `username:password` pairs separated by commas. Usernames may use letters, digits, `.`, `_`, `@` and `-`. Passwords need at least 8 characters, and may contain `:` but not `,`. Restart the server after changing the list.

Changing a viewer's password, or `ADMIN_PASSWORD`, signs that account out on its next request; removing a viewer ends their session.

### API keys

Create Read keys on the dashboard's **API keys** page, for tests and scripts that fetch captured requests. You don't need to edit `.env` or restart the server.

- **New key:** give it a name; the page shows the key with a **Copy** button and a ready-to-run `curl` example.
- **Show / Copy:** any active key can be shown or copied again later from the list, which also shows when each key was last used.
- **Revoke:** anything using a revoked key gets `401` immediately. Revoked keys stay in the list, struck through.
- **Key format:** `rb_read_…`.

How keys and bin secrets are protected:
- **Storage:** the database stores a SHA-256 hash of each key or secret, used to check requests, and an AES-256-GCM encrypted copy, used only to show it in the dashboard. The encryption key is derived from `SESSION_SECRET`.
- **If `SESSION_SECRET` changes:** existing keys and secrets keep working, but can no longer be shown or copied. Create a new key, or set a new bin secret, if you need to copy one.
- **Who can see them:** only an admin (dashboard session or `ADMIN_TOKEN`). Showing a key or secret is logged with its name and the caller's IP, and these responses are never cached.

To turn off authentication completely for local development, set `AUTH_DISABLED=true`. Don't do this on a server other people can reach.

### Capture safety

Capture URLs are public by design, so the service treats everything sent to them as untrusted:
- Bodies are stored as bytes and rendered in the dashboard with `textContent` only. HTML previews run in a sandboxed iframe with no scripts and no external loads.
- The bin's response is sent with `Content-Security-Policy: sandbox; default-src 'none'` and `X-Content-Type-Options: nosniff`, so a bin can't be used to serve a working page from your domain.
- Requests to a bin with a secret are rejected before the body is read. Body size, requests per minute per IP, and requests kept per bin are all capped.

## Running with Docker

The image is published to GitHub Container Registry as `ghcr.io/sunnykatiyar50/request-bin`. It runs as the unprivileged `node` user (UID 1000), for `linux/amd64` and `linux/arm64`.

### With Docker Compose

Requires Docker with the Compose plugin.

1. Copy `sample.env` to `.env` and fill in at least `ADMIN_PASSWORD` and `SESSION_SECRET`. After starting, create bins on the **Bins** page. Compose reads **all** settings from this file.
2. Start it:
   ```
   docker compose up -d
   ```
3. To update to the latest image later:
   ```
   docker compose pull && docker compose up -d
   ```

The service is available at `http://localhost:30002` (or the `PORT` in `.env`; the same port is used on the host and in the container). Captured requests and logs are kept in the `rb-data` and `rb-logs` volumes. To delete them, run `docker compose down -v`.

Keep `SQLITE_PATH` and `LOG_DIR` unset in `.env` when using Docker. The image already points them at `/app/data` and `/app/logs`, which are the mounted folders.

**Bind mounts instead of volumes.** To keep the files in host folders, replace the `volumes:` entries with bind mounts such as `./data:/app/data` and `./logs:/app/logs`. The folders must be writable by UID 1000. Create them yourself before the first start, so Docker doesn't create them as root:
```
sudo mkdir -p ./data ./logs && sudo chown -R 1000:1000 ./data ./logs
```
If a folder isn't writable, the container explains this at startup and prints the command to fix it. For the log folder it continues with stdout logging only. Alternatively, run the container once as root (`user: root` in Compose); it then fixes the ownership itself and still runs the app as UID 1000.

**PostgreSQL or MySQL.** Use the bundled PostgreSQL container (`docker compose --profile postgres up -d`) or any external server. Both are configured with the same `PG_*` (or `MYSQL_*`) variables in `.env`; see [Database setup](#database-setup).

**Listening on one interface only.** Put an address in front of the port in `docker-compose.yml`, for example `"100.110.180.13:30002:30002"` for a VPN or Tailscale address.

### With `docker run`

```
docker run -d --name request-bin --init --restart unless-stopped \
  --env-file .env -p 30002:30002 \
  -v rb-data:/app/data -v rb-logs:/app/logs \
  ghcr.io/sunnykatiyar50/request-bin:latest
```
The container port must match `PORT` in `.env` (30002 by default).

Stopping the container (`docker compose down` or `docker stop`) shuts the app down cleanly: it finishes in-flight requests and closes the database.

If you put the service behind a reverse proxy (nginx, Traefik, Nginx Proxy Manager, etc.), set `TRUST_PROXY=1` so rate limiting sees real client IPs and session cookies are marked `Secure` over HTTPS.

### Publishing the image

A GitHub Actions workflow (`.github/workflows/docker.yml`) runs the tests on SQLite (Node 22 and 24), PostgreSQL 17 and MySQL 8.4. It then builds the image and smoke-tests it (`.github/smoke-test.sh`): it starts a container, waits for the health check, creates a bin, sends a request into it and reads it back. Only after all of that does it build for amd64 and arm64 and publish:

| Event | Tags |
|-------|------|
| Push to `main` | `latest`, `sha-<commit>` |
| Push a tag such as `v2.1.0` | `2.1.0`, `2.1`, `2`, `sha-<commit>` |
| Pull request (to any branch) | Tests, builds and smoke-tests the image, but doesn't publish |

To publish a versioned release:
```
git tag v2.0.0
git push origin v2.0.0
```

New packages on GitHub Container Registry are private. To let anyone pull without logging in, open the package on GitHub (your profile → **Packages** → `request-bin` → **Package settings**) and change its visibility to **Public**. To pull a private image, first run `docker login ghcr.io` with a personal access token that has the `read:packages` scope.

### Building the image yourself

```
docker build -t request-bin .
```
To run your own build with Compose, change `image:` in `docker-compose.yml` to `request-bin`.


## API Endpoints

The dashboard's **API reference** page shows these with examples for your server.

### Capture: `ANY /b/<bin id>` and `ANY /b/<bin id>/<any path>`

Public. Stores the request and answers with the bin's configured response (by default `200` with `{"ok":true}`).

```
curl -X POST "http://localhost:30002/b/3f9c2a7d1e4b8c06/orders?attempt=1" \
  -H "Content-Type: application/json" -d '{"id": 42}'
```

| Response | When |
|----------|------|
| The bin's status and body | Captured |
| `401` | The bin has a secret and the request didn't include it (`X-Bin-Secret` header, `Authorization: Bearer` or `?secret=`) |
| `404` | No such bin |
| `413` | Body larger than `MAX_BODY_KB` |
| `429` | More than `CAPTURE_RATE_LIMIT` requests per minute from this IP |

The path is stored relative to the bin (`/orders` above). Once a bin holds `MAX_REQUESTS_PER_BIN` requests, the oldest are deleted.

With a `responseDelayMs`, the bin waits that long before answering. The request is stored first, so it shows up in the dashboard straight away.

#### Response rules

A bin can hold up to 20 rules, checked in order. The first rule whose conditions **all** match decides the response; a request that matches none gets the bin's own response. A rule only needs to set what differs: `status`, `contentType`, `body`, `template` and `delayMs` that it leaves out come from the bin.

```
{
  "responseRules": [
    { "name": "paid invoice",
      "match": { "method": "POST", "path": "/stripe/*", "body": { "path": "type", "value": "invoice.*" } },
      "response": { "status": 201, "body": "{\"received\": \"{{body.id}}\"}", "template": true } },
    { "name": "maintenance",
      "match": { "header": { "name": "X-Mode", "value": "maintenance" } },
      "response": { "status": 503, "contentType": "text/plain", "body": "back soon" } }
  ]
}
```

| Condition | Matches |
|-----------|---------|
| `method` | The request method |
| `path` | The path after the bin URL (`/orders/42`) |
| `header` | `{ "name", "value"? }`: a request header (name is case-insensitive) |
| `query` | `{ "name", "value"? }`: a query parameter |
| `body` | `{ "path", "value"? }`: a field of a JSON or form body (`order.id`, `items[0].sku`) |

`path` and every `value` match the whole text and are case-sensitive, and `*` stands for any text (`/orders/*`, `invoice.*`). Without a `value`, a `header`, `query` or `body` condition only requires the field to be present. A rule needs at least one condition. Rules are set on the **Bins** page ("Response rules") or with `responseRules` in the bin API; an empty list removes them.

#### Response templates

With `responseTemplate` on, placeholders in the response body are filled in from the request. Without it, the body is sent exactly as written.

| Placeholder | Value |
|-------------|-------|
| `{{method}}`, `{{path}}`, `{{ip}}` | Request method, path after the bin URL, sender IP |
| `{{id}}`, `{{bin}}` | The captured request's id, the bin id |
| `{{query}}`, `{{query.<name>}}` | The whole query string, or one parameter |
| `{{header.<name>}}` | A request header, case-insensitive. Headers hidden by redaction stay `[redacted]` |
| `{{body}}`, `{{body.<path>}}` | The whole body, or a field of a JSON body (`user.name`, `items.0.id`, `items[0].id`) or form body |
| `{{now}}`, `{{timestamp}}`, `{{uuid}}` | Current ISO time, Unix time in milliseconds, a random UUID |
| `{{<placeholder> \| <fallback>}}` | The fallback text when the value is missing or empty |

Unknown placeholders and missing values without a fallback become empty. Values are escaped for the response content type: JSON string escaping for `application/json`, and HTML/XML entities for HTML and XML. In JSON responses, numbers, booleans, objects and arrays are inserted as JSON, so both `{"user": {{body.user}}}` and `{"name": "{{body.user.name}}"}` produce valid JSON.

### Bins: `/api/bins`

| Method and path | Access | Description |
|-----------------|--------|-------------|
| `GET /api/bins` | Read | All bins, with `requestCount` and `lastRequestAt` |
| `GET /api/bins/:id` | Read | One bin |
| `POST /api/bins` | Admin | Create. Body (all optional): `name`, `withSecret` (true/false), `redactHeaders` (true/false, default true), `responseStatus` (200–599), `responseContentType` (`application/json`, `text/plain`, `application/xml`, `text/xml`, `text/html`), `responseBody` (up to 64 KB), `responseTemplate` (true/false, default false), `responseDelayMs` (0–30000, default 0), `responseRules` (up to 20, see [Response rules](#response-rules)). Returns `{ bin, secret? }` |
| `PATCH /api/bins/:id` | Admin | Change any of the settings above except `withSecret` |
| `DELETE /api/bins/:id` | Admin | Delete the bin and its requests |
| `POST /api/bins/:id/secret` | Admin | Set a new secret (replaces the old one). Returns `{ secret }` |
| `POST /api/bins/:id/secret/reveal` | Admin | Show the current secret |
| `DELETE /api/bins/:id/secret` | Admin | Remove the secret: the bin accepts anyone again |
| `DELETE /api/bins/:id/requests` | Admin | Delete everything captured in the bin |

### Captured requests: `/api/requests`

`GET /api/requests` (Read) lists requests, newest first, without bodies:

| Query parameter | Description |
|-----------------|-------------|
| `bin` | Bin id |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS` |
| `search` | Text in the path, query string, headers or body (case-insensitive) |
| `from`, `to` | ISO date-times |
| `startDate`, `endDate` | `YYYY-MM-DD` (UTC, both inclusive), used when `from`/`to` aren't given |
| `page`, `pageSize` | Default 1 and 25; `pageSize` up to 100 |

Returns `{ requests, total, page, totalPages }`.

`GET /api/requests/:id` (Read) returns one request in full: `method`, `path`, `queryString`, `query` (as `[{ name, value }]`), `headers`, `contentType`, `body`, `bodyEncoding` (`utf8`, or `base64` for binary bodies), `bodySize`, `ip` and `createdAt`.

`GET /api/requests/latest` (Read) takes the same filters as the list and returns the newest match in full, or `404`. For a test that triggers a webhook and then checks it:

```
curl -H "Authorization: Bearer $READ_KEY" "http://localhost:30002/api/requests/latest?bin=3f9c2a7d1e4b8c06&method=POST"
```

`GET /api/requests/export` (Read) downloads matching requests in full, oldest first. It takes the same filters as the list, plus:

| Query parameter | Description |
|-----------------|-------------|
| `format` | `har` (default) or `json` |
| `ids` | Comma-separated request ids (up to 500), to export only those |

At most the newest 1000 matches are exported. When there were more, the response has an `X-Export-Truncated: true` header. The HAR file is HAR 1.2. Only the request side of each entry is filled in, because the response the bin sent isn't stored, and binary bodies are base64 with `"encoding": "base64"`. The JSON file is `{ exportedAt, count, truncated, requests }`, with each request in the same shape as `GET /api/requests/:id`.

```
curl -H "Authorization: Bearer $READ_KEY" -o stripe.har "http://localhost:30002/api/requests/export?bin=3f9c2a7d1e4b8c06"
```

`DELETE /api/requests/:id` and `DELETE /api/requests` with `{ "ids": [1, 2, 3] }` (Admin, up to 500 ids) delete requests.

### Live stream: `GET /api/stream`

Read access. Server-sent events: one `request` event (the request summary as JSON) for every newly captured request. Add `?bin=<bin id>` to receive one bin only.

### API key management: `/api/keys`

Admin only: `GET /api/keys` lists keys, `POST /api/keys` with `{ "name": "ci-tests" }` creates a Read key, `POST /api/keys/:id/reveal` shows one again, and `DELETE /api/keys/:id` revokes it.

### `GET /health`

Public. Returns `200 {"status":"ok"}` when the database is reachable, `503` otherwise. Used by the Docker health check.

## Environment Configuration

See `sample.env` for a commented template.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `30002` | Port the server listens on |
| `ADMIN_USERNAME` | `admin` | Dashboard username. Changing it signs out existing sessions. |
| `ADMIN_PASSWORD` | — | Required. Dashboard password. Changing it signs the admin out |
| `VIEWER_USERS` | — | Optional read-only dashboard accounts: `username:password` pairs separated by commas (see [Viewer accounts](#viewer-accounts)) |
| `SESSION_SECRET` | — | Required. At least 32 characters; signs session cookies and encrypts the stored copies of API keys and bin secrets |
| `ADMIN_TOKEN` | — | Optional bearer token for scripts (at least 16 characters) |
| `SESSION_TTL_HOURS` | `12` | How long a dashboard sign-in lasts |
| `AUTH_DISABLED` | `false` | `true` turns off all authentication (local development only) |
| `MAX_BODY_KB` | `1024` | Largest request body captured, in KB (up to 16384). Larger bodies get `413` |
| `MAX_REQUESTS_PER_BIN` | `500` | Requests kept per bin; older ones are deleted as new ones arrive (`0` = no limit) |
| `CAPTURE_RATE_LIMIT` | `300` | Max captured requests per minute per client IP |
| `REDACT_HEADERS` | `authorization,proxy-authorization,cookie,x-api-key,x-bin-secret` | Headers stored as `[redacted]` in bins with redaction on |
| `TRUST_PROXY` | — | Number of reverse-proxy hops in front of the service (e.g. `1`) |
| `RETENTION_DAYS` | `7` | Delete requests older than this many days, checked hourly (`0` keeps everything) |
| `LOG_DIR` | `./logs` | Directory for log files |
| `LOG_TO_FILE` | `true` | `false` logs to stdout only (handy in containers, where `docker logs` already collects output) |
| `DB_TYPE` | `sqlite` | `sqlite`, `postgres`, or `mysql` |
| `SQLITE_PATH` | `./request-bin.sqlite` | SQLite database file (the Docker image uses `/app/data/request-bin.sqlite`) |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` | — | PostgreSQL connection, the same for the bundled container and external servers ([Database setup](#database-setup)) |
| `PG_SSL` | `false` | `true` (verified TLS), `no-verify` (TLS, self-signed certificates), or `false` |
| `PG_SSL_CA` | — | Path to an extra CA certificate (PEM) to trust |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | — | MySQL connection settings |
| `MYSQL_SSL`, `MYSQL_SSL_CA` | `false`, — | Same as `PG_SSL` and `PG_SSL_CA`, for MySQL |

For every database type, the `bins`, `requests` and `api_keys` tables are created automatically on startup. For PostgreSQL and MySQL, the database itself must already exist.

### Database setup

**SQLite** (default) needs no settings.

**PostgreSQL** always uses the same five variables, whether the database is the bundled container or a server somewhere else:

```
DB_TYPE=postgres
PG_HOST=…          # see the table below
PG_PORT=5432
PG_USER=requestbin
PG_PASSWORD=…
PG_DATABASE=requestbin
PG_SSL=false       # true for most hosted databases
```

Only `PG_HOST`, and for hosted databases `PG_SSL`, depend on where the database runs:

| Where PostgreSQL runs | `PG_HOST` | Notes |
|---|---|---|
| Bundled container from `docker-compose.yml` | `postgres` | Start with `docker compose --profile postgres up -d`. The container is created with the same `PG_USER`, `PG_PASSWORD`, and `PG_DATABASE`. |
| On the Docker host itself | `host.docker.internal` | The server must listen on an address the container can reach, not only `127.0.0.1`. |
| Another server, VPN address, or another Compose stack | Its hostname or IP | For another stack, put both containers on a shared Docker network and use the database's service name. |
| Hosted (Neon, Supabase, AWS RDS, Azure, …) | The host from the provider's connection string | Set `PG_SSL=true`. |
| App running without Docker | `localhost` (or the server's address) | — |

Inside Docker, never use `localhost`: it means the app's own container, so the connection fails with `ECONNREFUSED 127.0.0.1:5432`.

`PG_SSL` controls TLS:
- `false` (default): no TLS, for local servers and Docker networks.
- `true`: TLS, with the server certificate verified against the system's trusted CAs.
- `no-verify`: TLS without verifying the certificate, for servers with a self-signed certificate.

If the server's certificate comes from a CA that isn't in the system store (for example the AWS RDS bundle), mount the PEM file into the container and set `PG_SSL_CA` to its path.

If your provider gives a connection string such as `postgres://user:pass@host:5432/db?sslmode=require`, split it into these variables: `user` → `PG_USER`, `pass` → `PG_PASSWORD`, `host` → `PG_HOST`, `5432` → `PG_PORT`, `db` → `PG_DATABASE`, and `sslmode=require` → `PG_SSL=true`.

**MySQL** works the same way with `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_SSL`, and `MYSQL_SSL_CA`, using the same rules for the host. There is no bundled MySQL container.


## Troubleshooting

- **The server exits with `Invalid auth configuration`:** one of the required auth settings is missing, too short, or still a `change-me` placeholder. The message lists what to fix.
- **The server exits with `Startup failed`:** usually the database connection. Check `DB_TYPE` and the connection settings in `.env`, and make sure the database server is running and reachable. To rule out the database server, set `DB_TYPE=sqlite`.
- **A sender gets `401 Invalid bin secret`:** the bin has a secret and the request didn't include it. Add an `X-Bin-Secret` header or `Authorization: Bearer <secret>`, or `?secret=<secret>` to the URL for senders that can't set headers. If the sender uses `Authorization` for its own token, send the secret in `X-Bin-Secret`; any one of the three is enough. The secret can be shown on the **Bins** page.
- **A sender gets `413`:** the body is larger than `MAX_BODY_KB`.
- **Requests don't appear live behind a reverse proxy:** the live list uses server-sent events (`/api/stream`). Turn off response buffering for that path (nginx: `proxy_buffering off;`; the app already sends `X-Accel-Buffering: no`) and allow long-lived connections. The list still refreshes when you reload or change filters.
- **Every client shares one rate limit behind a proxy:** set `TRUST_PROXY=1`. Without it, captured requests also show the proxy's IP instead of the sender's.
- **`401 Invalid or revoked API key`:** the key doesn't match an active key on the API keys page.
- **`EACCES: permission denied` for `/app/logs/app.log` or `unable to open database file` in Docker:** the mounted folder isn't writable by UID 1000, which the container runs as. Fix it once on the host with `sudo chown -R 1000:1000 <folder>`, or start the container once with `user: root` (Compose) / `--user root` to have it fixed automatically. The container's startup output names the folder and the command.
- **`ECONNREFUSED 127.0.0.1:5432` (or `:3306`) in Docker:** `PG_HOST` / `MYSQL_HOST` is `localhost`, which inside a container means the container itself. Use the database container's service name (`postgres` with the bundled profile), or `host.docker.internal` for a database on the host machine.
- **`no pg_hba.conf entry … no encryption`, `SSL/TLS required`, or `connection is insecure` from a hosted database:** the server requires TLS. Set `PG_SSL=true` (or `MYSQL_SSL=true`).
- **`self-signed certificate in certificate chain` or `unable to verify the first certificate`:** TLS is on, but the server's certificate isn't trusted. Set `PG_SSL_CA` to the provider's CA file, or use `PG_SSL=no-verify` for a server with a self-signed certificate.
- **`SQLite is an experimental feature` warning on Node 22:** harmless. The npm scripts already hide it; it only appears if you start the app with plain `node src/app.js`.

## Roadmap

- Forward or replay a captured request to another URL (with an allowlist, to avoid SSRF)
- Per-bin retention
- Multiple admin users

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any suggestions or improvements.

## License

This project is licensed under the MIT License.
