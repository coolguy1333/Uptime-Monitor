# Configuration

- [Environment variables](#environment-variables)
- [Monitor types](#monitor-types)
- [Monitor options](#monitor-options)
- [Status meanings](#status-meanings)
- [Notifications](#notifications)
- [Self-monitoring](#self-monitoring)
- [Peer servers (multi-server / federation)](#peer-servers-multi-server--federation)
- [Dashboard settings](#dashboard-settings)
- [Data files and retention](#data-files-and-retention)

## Environment variables

Set them in your shell, in Docker/Compose, in `/etc/uptime-monitor.env` (systemd install), or in a `.env` file next to `server.js`. Real environment variables win over `.env`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind to. `127.0.0.1` = only reachable from the same machine (e.g. via a reverse proxy). |
| `ADMIN_PASSWORD` | *(generated)* | Admin password and API token. When unset, the password in `DATA_DIR/admin-password.txt` is used; that file is created with a random password on first start. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Turn on "Sign in with Google". See [GOOGLE_SIGNIN.md](GOOGLE_SIGNIN.md). |
| `ADMIN_EMAILS` | | Comma-separated Google accounts allowed to sign in. `@example.com` allows a whole Google Workspace domain. |
| `PUBLIC_URL` | | Public base URL (e.g. `https://status.example.com`). Used to build the Google redirect URI; also marks cookies `Secure` when it starts with `https://`. |
| `PASSWORD_LOGIN` | auto | Password sign-in. Default: on without Google, off with Google. |
| `DATA_DIR` | `./data` | Storage folder. Relative paths are relative to the app folder. Docker image default: `/data`. systemd install: `/var/lib/uptime-monitor`. |
| `SITE_TITLE` | `Uptime Monitor` | Site title used on first start. After that, change it in Settings. |
| `PUBLIC_DASHBOARD` | `true` | Initial "public dashboard" setting used on first start (`false` = login required to see anything). After that, change it in Settings. |
| `NOTIFY_WEBHOOK_URL` | | One or more webhook URLs, comma-separated. Always used, in addition to the webhooks entered in Settings. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` headers. Enable only behind a reverse proxy. |
| `ALLOW_EMBED` | `false` | Allow embedding the dashboard in an iframe (removes `X-Frame-Options: DENY`). |
| `PEERS` | | Comma-separated base URLs of other Uptime Monitor instances to federate with. See [Peer servers](#peer-servers-multi-server--federation). |
| `PEER_TOKEN` | | Shared secret sent as `Authorization: Bearer <PEER_TOKEN>` between peers. Recommended whenever `PEERS` is set; use the same value on every server in the group. |

**Changing the admin password:** set `ADMIN_PASSWORD` and restart, or edit `admin-password.txt` and restart. Existing sessions stay signed in; delete `sessions.json` and restart to sign everyone out.

## Monitor types

### Website (HTTP/HTTPS)

Requests the URL and checks the response.

- **Up** when the final status code (after redirects) is in *Accepted status codes* and, if set, the *keyword* check passes.
- Reports response time (whole request including redirects), HTTP status and, for HTTPS, **days until the TLS certificate expires** (highlighted under 30 and 14 days).
- If you type a URL without `http://` or `https://`, `https://` is added.
- Compressed responses (gzip, deflate, brotli) are decompressed before the keyword check.

### IP / host (ping)

Sends one ICMP echo request using the system `ping` command and reports round-trip time. Works with IPv4, IPv6 and hostnames. Useful for routers, switches, servers, Proxmox hosts, VMs, printers, etc.

Requires the `ping` command on the machine running the monitor (included in the Docker image and installed by `deploy/install.sh`).

### TCP port

Opens a TCP connection to `host:port` and closes it again. You can type `192.168.1.10:22` in the target box; the port is filled in for you. Good for anything that listens on a port but has no web page: SSH (22), databases (3306, 5432), Minecraft (25565), SMB (445), RDP (3389), the Proxmox web UI (8006), DNS over TCP (53), etc.

## Monitor options

| Option | Default | Applies to | Description |
|---|---|---|---|
| Name | | all | Display name. |
| Target | | all | URL for websites; IP address or hostname for ping/TCP. |
| Port | | TCP | 1–65535. |
| Check every | 60 s | all | Interval between checks (10 s – 24 h). |
| Timeout | 10 s | all | How long to wait before a check fails (1–120 s). |
| Retries before "down" | 1 | all | Consecutive failures tolerated before the monitor is marked down and an alert is sent. `0` = alert on the first failure. With `1` and a 60 s interval, a site must fail twice in a row (about a minute) to be marked down. |
| Method | GET | HTTP | `GET` or `HEAD`. `HEAD` is lighter but ignores the keyword check. |
| Accepted status codes | `200-399` | HTTP | Comma-separated codes and ranges: `200`, `200-299`, `2xx`, `200-299,401`. |
| Keyword | | HTTP | Text that must appear in the response body (case-insensitive). |
| Keyword must be absent | off | HTTP | Invert: the check fails if the keyword **is** found (e.g. "maintenance"). |
| Follow redirects | on | HTTP | Follow up to 10 redirects. When off, a 301/302 is judged by *Accepted status codes*. |
| Ignore TLS/SSL errors | off | HTTP | Accept self-signed or expired certificates — handy for internal services like Proxmox (`https://192.168.1.10:8006`). |
| Paused | off | all | Stop checking without deleting history. |

## Status meanings

| Status | Meaning |
|---|---|
| 🟢 **Up** | Last check passed. |
| 🟠 **Pending** | Waiting for the first check, or failing but still within the allowed retries. |
| 🔴 **Down** | Failed more times in a row than *Retries* allows. An alert was sent. |
| ⚪ **Paused** | Not being checked. |

Uptime percentages count every individual check: `successful checks ÷ total checks`. The 90-day bars are rolling 24-hour windows ending now: green ≥ 99.9 %, amber ≥ 95 %, red below that, grey = no data.

## Notifications

Add webhook URLs in **Settings → Notification webhooks** (one per line) or with `NOTIFY_WEBHOOK_URL`. Use **Send test notification** to verify.

Alerts are sent when:

- a monitor goes **down** (after its retries),
- a monitor comes back **up** (includes how long it was down),
- an HTTPS certificate is about to expire (once each at 14, 7, 3 and 1 days left; resets when the certificate is renewed),
- the monitor server **restarts after an outage** (includes how long it was offline).

The format is chosen from the URL:

| Service | URL looks like | Sent as |
|---|---|---|
| Discord | `https://discord.com/api/webhooks/...` | `{"content": "..."}` |
| Slack | `https://hooks.slack.com/services/...` | `{"text": "..."}` |
| ntfy | `https://ntfy.sh/your-topic` (or your own ntfy server, URL containing `ntfy`) | plain text with Title / Priority / Tags headers |
| Anything else | any URL | JSON (below) |

Generic JSON payload:

```json
{
  "event": "monitor_down",
  "status": "down",
  "title": "🔴 NAS is DOWN",
  "text": "🔴 NAS is DOWN\nConnection refused",
  "monitor": { "id": "a1b2c3d4e5f6", "name": "NAS", "type": "tcp", "target": "192.168.1.20", "port": 445 },
  "message": "Connection refused",
  "time": "2026-09-25T03:54:55.852Z"
}
```

`event` is one of `monitor_down`, `monitor_up` (adds `downForMs`), `cert_expiring` (adds `cert`), `self_recovered` (adds `downForMs`), `test`. This works with Home Assistant webhooks, n8n, Node-RED, Gotify-style relays, etc.

## Self-monitoring

The **This server** card tracks the monitor's own availability:

- While running, it writes a heartbeat to `self.json` every **15 seconds**.
- On startup, if the last heartbeat is more than **45 seconds** old, the gap is recorded as an outage — whether the app was stopped, crashed, the machine rebooted, lost power, or the VM/container was paused. Quick restarts under 45 s are logged as "restart" but not counted as downtime.
- While running, if the process is frozen for more than 45 s (host suspended, VM paused), that gap is also recorded.
- Shown: current process uptime (live counter), start time, uptime % for 24 h/7 d/30 d/90 d, 90-day bars, restart and outage counts, and an event log. When logged in you also see host name, OS, Node version, host uptime, load and memory.

Because it can't alert while it is itself down, see [Monitoring the monitor](DEPLOYMENT.md#monitoring-the-monitor) for instant alerts.

## Peer servers (multi-server / federation)

Run Uptime Monitor on more than one machine and have every instance show all of them on one dashboard, each with its own uptime record. There's no central server and no single point of failure: every instance independently polls the others, so any one instance's dashboard shows the whole group even if some of the others are down.

**Setup**, on each server:

```ini
PEERS=https://status-eu.example.com,https://status-us.example.com   # the *other* servers, not itself
PEER_TOKEN=some-long-shared-secret                                   # same value on every server
```

- `PEERS` is the list of the *other* servers in the group (each one lists everyone else). Don't include a server's own address.
- `PEER_TOKEN` is a shared secret, the same on every server, sent as `Authorization: Bearer <PEER_TOKEN>`. Without it, `/api/peer-status` (what peers poll) is public and unauthenticated — it never exposes monitors or targets, only this server's own uptime numbers, but setting a token is still recommended.

Each instance polls every URL in `PEERS` every 20 seconds and shows the result in an **Other servers** panel: online/unreachable, uptime % (24h/7d/30d/90d) and 90-day bars, using the peer's own self-reported uptime record when it's reachable, and the last one it reported plus "last seen" when it isn't.

This only shares each server's own self-uptime — it does not sync monitor lists between servers; each instance still has its own monitors, settings and admin login.

## Dashboard settings

In **Settings** (admin only):

- **Site title**
- **Public dashboard** — when off, visitors must log in to see anything. `/api/health` always stays public.
- **Show URLs / IP addresses to public visitors** — off by default, so a public status page doesn't reveal your internal IPs. Logged-in admins always see them.
- **Export / Import monitors** — JSON file with your monitor definitions (not history). Import adds to the existing list.

## Data files and retention

| File | Contents | Written |
|---|---|---|
| `monitors.json` | monitor definitions | on change |
| `settings.json` | dashboard settings, webhooks | on change |
| `history.json` | check results and events | every 30 s and on shutdown |
| `self.json` | heartbeat, outages, server events | every 15 s |
| `sessions.json` | signed-in sessions (hashed tokens) | on sign-in/out |
| `admin-password.txt` | generated password | first start |

Retention: individual check results are kept for **24 hours**; hourly summaries for **90 days**; the last 100 status events per monitor. A monitor checked every 60 s uses roughly 200 KB of history. Files are written atomically (temp file + rename), so a crash mid-write won't corrupt them. If a file is unreadable on startup it is renamed to `*.corrupt-<timestamp>` and a fresh one is started.

You can edit `monitors.json` by hand while the app is stopped.
