# Request Bin

A self-hosted HTTP request collector. Create a bin, point a webhook, integration, or test client at its URL, and every request sent there (any method, any path) is stored and shown live in a web dashboard: method, path, query, headers, and body.

Use it to debug webhooks (Stripe, GitHub, Slack, payment gateways, SMS providers), check what an SDK actually sends, or give tests a fake endpoint to call.

Built with Node.js, Express, and SQLite (Node's built-in `node:sqlite`, so there are no native dependencies to compile).

## Features

- Unlimited bins, each with a unique URL: `http://<host>/b/<bin-id>/<any/path>`
- Captures every HTTP method, the path below the bin URL, query string, headers, raw body (text or binary), client IP, and time
- Live dashboard updates over server-sent events
- JSON bodies pretty-printed; binary bodies shown as base64; "Copy as cURL" for any captured request
- Search across path, query, headers, and body; filter by method
- Configurable response per bin (status code, content type, body)
- Optional per-bin secret, so only callers that know it can post to the bin
- Sensitive headers (`Authorization`, `Cookie`, ...) are redacted before storing, unless you turn that off per bin
- Password-protected dashboard and bearer-token admin API
- Body size limit, rate limiting, per-bin request cap, and automatic retention cleanup

## Quick start

Requires [Node.js](https://nodejs.org/) 22.13 or later (tested with Node.js 24).

```
npm install
cp sample.env .env          # Windows: copy sample.env .env
```

Replace the `change-me` values in `.env` (the server refuses to start while they are still there). To generate a random value:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then start the server:
```
npm start
```

Open `http://localhost:3007`, sign in with `ADMIN_PASSWORD`, click **New bin**, and send it a request:

```
curl -X POST http://localhost:3007/b/<bin-id>/webhooks/test \
  -H "Content-Type: application/json" \
  -d '{"event": "order.created", "id": 42}'
```

For development with auto-restart: `npm run dev`. To run the tests: `npm test`.

## Running with Docker

Set `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`, then:

```
docker compose up --build
```

The service is available at `http://localhost:3007`. Data and logs are kept in the `request-bin-data` and `request-bin-logs` volumes. To delete them, run `docker compose down -v`.

If you put the service behind a reverse proxy (nginx, Traefik, etc.), set `TRUST_PROXY=1` so client IPs are recorded correctly, rate limiting works per client, and session cookies are marked `Secure` over HTTPS.

## Capturing requests

Anything sent to `/b/<bin-id>` or `/b/<bin-id>/<anything>` is captured. The stored path is the part after the bin ID (`/webhooks/test` in the example above).

The bin answers with its configured response (by default `200` with `{"ok":true}`). Change it under **Response settings** in the dashboard or with `PATCH /api/bins/:id`. The response content type can be `application/json`, `text/plain`, `application/xml`, or `text/xml`. Responses are sent with `Content-Security-Policy: sandbox`, so a response body can never run scripts on the dashboard's origin.

**Bin secret.** A bin created with a secret only accepts requests that include it, in either the `X-Bin-Secret` header or a `secret` query parameter (for senders that can't set headers). Other requests get `401`. A secret sent in the query string is stored as `[redacted]`. The secret is shown once, when the bin is created.

**Header redaction.** In bins with redaction on (the default), the values of `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, and `x-bin-secret` are stored as `[redacted]`. Change the list with `REDACT_HEADERS`.

**Limits.** Bodies over `MAX_BODY_KB` are rejected with `413`. Each bin keeps its newest `MAX_REQUESTS_PER_BIN` requests. Requests older than `RETENTION_DAYS` are deleted hourly.

## Admin API

All `/api` endpoints need either a dashboard session or `Authorization: Bearer <ADMIN_TOKEN>`. Errors are JSON: `{ "error": "..." }`, plus a `details` object for validation errors.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bins` | List bins with their request counts |
| `POST` | `/api/bins` | Create a bin. Body (all optional): `name`, `withSecret`, `redactHeaders`, `responseStatus`, `responseContentType`, `responseBody`. Returns `{ bin, secret? }`. |
| `GET` | `/api/bins/:id` | Get a bin |
| `PATCH` | `/api/bins/:id` | Update `name`, `redactHeaders`, `responseStatus`, `responseContentType`, `responseBody` |
| `DELETE` | `/api/bins/:id` | Delete a bin and its requests |
| `GET` | `/api/bins/:id/requests` | List captured requests, newest first. Query: `method`, `search`, `page`, `pageSize` (1–100, default 50). Bodies and headers are not included. |
| `DELETE` | `/api/bins/:id/requests` | Delete all requests in a bin |
| `GET` | `/api/bins/:id/stream` | Server-sent events: a `request` event for every newly captured request |
| `GET` | `/api/requests/:id` | Get one request with `headers`, `query`, `body`, and `bodyEncoding` (`utf8` or `base64`) |
| `DELETE` | `/api/requests/:id` | Delete one request |
| `GET` | `/health` | Public health check |

Example: read the last webhook a test triggered.

```js
const headers = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const { requests } = await (await fetch(`${BIN_HOST}/api/bins/${binId}/requests?pageSize=1`, { headers })).json();
const detail = await (await fetch(`${BIN_HOST}/api/requests/${requests[0].id}`, { headers })).json();
const payload = JSON.parse(detail.body);
```

## Configuration

See `sample.env` for a commented template.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3007` | Port the server listens on |
| `ADMIN_PASSWORD` | — | Required. Dashboard password |
| `SESSION_SECRET` | — | Required. At least 32 characters; signs session cookies |
| `ADMIN_TOKEN` | — | Optional bearer token for the admin API (at least 16 characters) |
| `SESSION_TTL_HOURS` | `12` | How long a dashboard sign-in lasts |
| `AUTH_DISABLED` | `false` | `true` turns off dashboard/API authentication (local development only) |
| `MAX_BODY_KB` | `1024` | Largest request body accepted |
| `MAX_REQUESTS_PER_BIN` | `500` | Requests kept per bin (`0` = unlimited) |
| `CAPTURE_RATE_LIMIT` | `300` | Captured requests per minute per client IP |
| `RETENTION_DAYS` | `7` | Delete requests older than this (`0` = keep forever) |
| `REDACT_HEADERS` | see `sample.env` | Headers redacted in bins with redaction on |
| `DATABASE_PATH` | `./request-bin.sqlite` | SQLite database file |
| `TRUST_PROXY` | — | Number of reverse-proxy hops in front of the service |
| `LOG_DIR` | `./logs` | Directory for log files |

## Project structure

```
src
├── app.js              # Entry point: config, database, retention, server
├── server.js           # Builds the Express app
├── config.js           # Reads and validates environment variables
├── db.js               # SQLite schema
├── events.js           # In-process pub/sub for live updates
├── middleware/auth.js  # Dashboard sessions and admin token
├── models/             # binModel.js, requestModel.js
├── routes/             # captureRoutes.js (/b), apiRoutes.js (/api)
├── utils/              # logger.js, session.js
└── views/              # Dashboard (index.html, dashboard.js, login.html, login.js, styles.css)
test/api.test.js
```

## Roadmap

- Replay or forward captured requests to a target URL, with an allowlist so the server can't be used to reach internal hosts (SSRF)
- Response templating (echo fields from the request, delays, random failures)
- Per-bin retention and request caps
- Export as HAR
- Multiple users and per-user bins
- Adapters that parse known payloads (SMS providers, Stripe, GitHub) into readable summaries

## License

Apache License 2.0. See [LICENSE](LICENSE).
