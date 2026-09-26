# API

Everything the dashboard does goes through a small JSON API, so you can script it too.

## Authentication

Admin endpoints accept either:

- the session cookie set by `POST /api/login` (what the browser uses), or
- an `Authorization: Bearer <ADMIN_PASSWORD>` header (handy for scripts). This works even when password *sign-in* is disabled because Google sign-in is used.

Requests that change data must send `Content-Type: application/json` (this also protects against cross-site request forgery).

Read endpoints (`/api/status`, `GET /api/monitors/:id`) are public when *Public dashboard* is on; otherwise they need auth. Targets (URLs/IPs) are only included for admins, or when *Show URLs / IP addresses to public visitors* is on.

`/api/peer-status` uses a separate `Authorization: Bearer <PEER_TOKEN>` (not the admin password) — see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | Liveness check. Always public. |
| GET | `/api/peer-status` | peer token | What a federated peer polls (see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation)): this server's own name, version and self-uptime. Public if `PEER_TOKEN` is unset, otherwise needs `Authorization: Bearer <PEER_TOKEN>`. |
| GET | `/api/status` | view | Everything the dashboard shows: self uptime, counts, all monitors, peers. |
| GET | `/api/monitors` | view | All monitors (same objects as in `/api/status`). |
| GET | `/api/monitors/:id` | view | One monitor with 24 h response-time series, 90 daily buckets and recent events. |
| POST | `/api/monitors` | admin | Create a monitor. |
| PUT | `/api/monitors/:id` | admin | Update a monitor (send only the fields to change). |
| DELETE | `/api/monitors/:id` | admin | Delete a monitor and its history. |
| POST | `/api/monitors/:id/check` | admin | Run a check now; returns the updated monitor. |
| POST | `/api/login` | — | `{"password": "..."}` → sets session cookie. Only when password login is enabled. Rate-limited to 10 tries/minute per IP. |
| GET | `/api/auth/google` | — | Starts Google sign-in (browser redirect). |
| GET | `/api/auth/google/callback` | — | Google redirects back here. Register this URL in Google Cloud. |
| POST | `/api/logout` | — | Ends the session. |
| GET | `/api/settings` | admin | Current settings. |
| PUT | `/api/settings` | admin | Update `title`, `webhooks` (array or newline-separated string), `publicDashboard`, `publicShowTargets`. |
| POST | `/api/settings/test-notification` | admin | Send a test message to all webhooks. |
| GET | `/api/export` | admin | Download monitors and settings as JSON. |
| POST | `/api/import` | admin | `{"monitors": [...]}` — adds monitors (same fields as create). |

## Monitor fields

```json
{
  "name": "Proxmox UI",
  "type": "http",               // "http" | "ping" | "tcp"
  "target": "https://192.168.1.10:8006",
  "port": null,                 // required for tcp
  "interval": 60,               // seconds, 10–86400
  "timeout": 10,                // seconds, 1–120
  "retries": 1,                 // 0–10
  "method": "GET",              // http: GET | HEAD
  "acceptedStatus": "200-399",  // http
  "keyword": "",                // http
  "invertKeyword": false,       // http
  "followRedirects": true,      // http
  "ignoreTls": true,            // http
  "paused": false
}
```

Validation errors return `400 {"error": "..."}`.

## Examples

```bash
PW='your-admin-password'
URL=http://localhost:3000

# health
curl -s $URL/api/health

# add a ping monitor
curl -s -X POST $URL/api/monitors \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"name":"Router","type":"ping","target":"192.168.1.1","interval":30}'

# add a TCP monitor
curl -s -X POST $URL/api/monitors \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"name":"SSH on server","type":"tcp","target":"192.168.1.10","port":22}'

# pause a monitor
curl -s -X PUT $URL/api/monitors/<id> \
  -H "Authorization: Bearer $PW" -H 'Content-Type: application/json' \
  -d '{"paused":true}'

# list names and statuses (needs jq)
curl -s $URL/api/status | jq -r '.monitors[] | "\(.status)\t\(.name)"'
```

## `/api/status` response (abridged)

```json
{
  "title": "Uptime Monitor",
  "authed": false,
  "user": null,
  "auth": { "google": true, "password": false },
  "version": "1.0.0",
  "counts": { "up": 4, "down": 1, "pending": 0, "paused": 0 },
  "self": {
    "status": "up",
    "startedAt": 1790308523589,
    "processUptime": 86400,
    "uptime": { "24h": 100, "7d": 99.93, "30d": 99.98, "90d": 99.99 },
    "restarts": 3,
    "lastDowntime": { "start": 1790200000000, "end": 1790200300000, "reason": "Stopped" },
    "daily": [{ "t": 1782532523589, "pct": 100 }, "..."],
    "events": [{ "t": 1790308523589, "status": "up", "msg": "Started again" }]
  },
  "monitors": [
    {
      "id": "a1b2c3d4e5f6",
      "name": "Website",
      "type": "http",
      "status": "up",
      "last": { "t": 1790308523589, "ok": true, "ms": 84.2, "msg": "HTTP 200" },
      "avgMs24h": 91.3,
      "uptime": { "24h": 100, "7d": 99.9, "30d": 99.95, "90d": null },
      "recent": [{ "t": 1790308523589, "ok": true, "ms": 84.2, "msg": "HTTP 200" }],
      "cert": { "validTo": "2026-12-01T00:00:00.000Z", "daysLeft": 67, "issuer": "Let's Encrypt" }
    }
  ],
  "peers": [
    {
      "url": "https://status-eu.example.com",
      "name": "EU",
      "reachable": true,
      "error": null,
      "checkedAt": 1790308523589,
      "version": "1.2.0",
      "self": { "status": "up", "uptime": { "24h": 100, "7d": 99.97, "30d": 100, "90d": 100 }, "...": "same shape as the top-level self" },
      "observedUptime": { "24h": 100, "7d": 100, "30d": 99.9, "90d": null }
    }
  ]
}
```

Times are Unix milliseconds. Uptime values are percentages, or `null` when there is no data for that window. `peers` is only present when `PEERS` is configured (see [Peer servers](CONFIGURATION.md#peer-servers-multi-server--federation)); `self` inside a peer entry is that peer's own last-reported self-uptime (kept even if `reachable` is currently `false`), and `observedUptime` is that peer's uptime as seen from this server's own polling.
