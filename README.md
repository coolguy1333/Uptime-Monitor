# Uptime Monitor

A small, self-hosted uptime monitor and status page. It watches **websites**, **IP addresses** and **TCP ports**, and also tracks **its own uptime** so you can see when the monitor itself was offline.

- **Zero dependencies** — just Node.js 18+. No database, no `npm install`, no build step.
- **Runs anywhere** — Docker, a Proxmox LXC / any Linux box (systemd), Windows, or macOS.
- **All data in one folder** — plain JSON files that are easy to back up.

## Features

| | |
|---|---|
| **Website checks (HTTP/HTTPS)** | Status codes, optional keyword that must be present (or absent), redirects, response time, TLS certificate expiry. |
| **IP / host checks (ping)** | ICMP ping using the system `ping` command, with round-trip time. |
| **TCP port checks** | Checks that a port (SSH, database, game server, …) accepts connections. |
| **Self-monitoring** | Records a heartbeat every 15 s. Any gap (crash, reboot, power cut, host suspended) is logged as an outage and shown with its own uptime %, 90-day history and event log. |
| **Uptime stats** | 24 h / 7 d / 30 d / 90 d uptime per monitor, 90-day daily bars, last-24 h response-time chart, event history. |
| **Alerts** | Webhooks for Discord, Slack, ntfy or any JSON endpoint when something goes down, comes back up, a TLS certificate is about to expire, or the monitor restarts after an outage. |
| **Status page** | Public read-only dashboard (optional); IPs/URLs hidden from the public by default. |
| **Sign-in** | **Sign in with Google** (restricted to the accounts in `ADMIN_EMAILS`) and/or an admin password. Sessions survive restarts. |
| **Extras** | Retries before marking down, per-monitor intervals, dark/light theme, mobile layout, export/import, `/api/health` endpoint, JSON API. |

## Quick start

Pick one.

### Docker Compose (recommended)

```bash
docker compose up -d
docker compose logs uptime-monitor   # shows the generated admin password
```

Open **http://your-server:3000**.

### Plain Node.js (any OS)

```bash
node server.js
```

On Windows you can also double-click **`start.bat`**; on Linux/macOS run **`./start.sh`**.

### Proxmox LXC / Debian / Ubuntu (systemd service)

Copy this folder into the container (e.g. `git clone` or `scp`), then:

```bash
sudo ./deploy/install.sh
```

It installs Node.js and `ping` if needed, creates a service user, starts the service on boot and prints the URL and admin password.

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for full instructions, reverse proxy / HTTPS setup, backups and updating.

## Signing in

**With Google (recommended).** Create a Google OAuth client, then set:

```ini
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=you@gmail.com
PUBLIC_URL=https://status.example.com
```

Step-by-step: **[docs/GOOGLE_SIGNIN.md](docs/GOOGLE_SIGNIN.md)**. Google needs HTTPS on a real domain, or `http://localhost`. It doesn't accept a bare LAN IP.

**With a password.** Without Google configured, sign in with the admin password. It is generated on first start, printed in the log and saved to `data/admin-password.txt`, or you can set your own with `ADMIN_PASSWORD`. When Google is configured, password login is off unless `PASSWORD_LOGIN=true`; the password still works as an API token.

Three example monitors are created on first run so you can see how it works — edit or delete them.

## Configuration

All settings are optional environment variables. You can also put them in a `.env` file next to `server.js` (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. Use `127.0.0.1` when only a local reverse proxy should reach it. |
| `ADMIN_PASSWORD` | *(generated)* | Admin password / API token. If unset, read from / generated into `DATA_DIR/admin-password.txt`. |
| `GOOGLE_CLIENT_ID` | | Google OAuth client ID. With the secret, turns on "Sign in with Google". |
| `GOOGLE_CLIENT_SECRET` | | Google OAuth client secret. |
| `ADMIN_EMAILS` | | Comma-separated Google accounts allowed to sign in (`@domain.com` = whole Workspace domain). |
| `PUBLIC_URL` | | Public address, e.g. `https://status.example.com`. Used for the Google redirect URI. |
| `PASSWORD_LOGIN` | `true` without Google, `false` with Google | Allow signing in with the admin password. |
| `DATA_DIR` | `./data` | Where monitors, settings and history are stored. |
| `SITE_TITLE` | `Uptime Monitor` | Title used on first start (change it later in Settings). |
| `PUBLIC_DASHBOARD` | `true` | First-start default; `false` = login required to view anything (change later in Settings). |
| `NOTIFY_WEBHOOK_URL` | | Comma-separated webhook URLs, used in addition to those set in the UI. |
| `TRUST_PROXY` | `false` | Set `true` behind Caddy/nginx/Traefik/Cloudflare Tunnel so client IPs and HTTPS are detected correctly. |
| `ALLOW_EMBED` | `false` | Allow the dashboard to be shown in an iframe (Homepage, Heimdall, Home Assistant…). |

More detail — monitor options, notifications, data files — is in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, Proxmox LXC/systemd, Windows, reverse proxy & HTTPS, backups, updates
- [docs/GOOGLE_SIGNIN.md](docs/GOOGLE_SIGNIN.md) — setting up Sign in with Google
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — environment variables, monitor types and options, notifications, self-monitoring, data files
- [docs/API.md](docs/API.md) — JSON API reference
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common problems and fixes

## Project layout

```
server.js            HTTP server, API, startup/shutdown
lib/checks.js        HTTP, TCP and ping checks
lib/scheduler.js     runs checks on their intervals, up/down transitions
lib/self.js          self-uptime heartbeat and outage detection
lib/store.js         JSON storage, uptime maths, history retention
lib/notify.js        webhook notifications
lib/auth.js          Google sign-in, admin password, sessions
public/              dashboard (plain HTML/CSS/JS)
deploy/              systemd unit, installer, Caddy and nginx examples
Dockerfile, docker-compose.yml
```

## License

MIT
