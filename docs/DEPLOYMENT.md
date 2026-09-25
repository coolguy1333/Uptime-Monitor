# Deployment

Uptime Monitor needs only **Node.js 18 or newer**. Everything it stores lives in one data folder.

- [Docker Compose](#docker-compose)
- [Docker (without Compose)](#docker-without-compose)
- [Proxmox LXC / Debian / Ubuntu with systemd](#proxmox-lxc--debian--ubuntu-with-systemd)
- [Windows](#windows)
- [macOS / anything else](#macos--anything-else)
- [Reverse proxy and HTTPS](#reverse-proxy-and-https)
- [Backups](#backups)
- [Updating](#updating)
- [Monitoring the monitor](#monitoring-the-monitor)

---

## Docker Compose

```bash
cd uptime-monitor
docker compose up -d
docker compose logs uptime-monitor     # admin password is printed here on first run
```

Open `http://<server-ip>:3000`.

Set options with a `.env` file next to `docker-compose.yml` (Compose reads it automatically):

```ini
ADMIN_PASSWORD=choose-a-good-password
SITE_TITLE=Homelab Status
TZ=America/Chicago
```

Data is kept in the named volume `uptime-data`. To use a folder instead, change the volume line to `- ./data:/data` and give it to the container user (UID 1000):

```bash
mkdir -p data && sudo chown 1000:1000 data
```

Useful commands:

```bash
docker compose logs -f                          # follow logs
docker compose restart                          # restart
docker compose exec uptime-monitor cat /data/admin-password.txt
```

## Docker (without Compose)

```bash
docker build -t uptime-monitor .
docker run -d --name uptime-monitor --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_PASSWORD=choose-a-good-password \
  -v uptime-data:/data \
  uptime-monitor
```

The image has a built-in `HEALTHCHECK`, so `docker ps` shows `healthy` when the app is responding.

> **Ping inside Docker:** the image runs as a non-root user and uses unprivileged ICMP sockets, which Docker enables by default. If ping checks report *"ping not permitted"*, add `--cap-add NET_RAW` (or `cap_add: [NET_RAW]` in Compose) — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ping-checks-fail).

## Proxmox LXC / Debian / Ubuntu with systemd

### 1. Create a container (Proxmox)

A tiny unprivileged container is plenty:

- Template: Debian 12 or 13
- 1 CPU core, 256–512 MB RAM, 2 GB disk
- Network: DHCP or a static IP on your LAN

Start it and open a console (or `pct enter <CTID>` on the host).

### 2. Get the code into the container

Any of these:

```bash
# from a git repository
apt update && apt install -y git
git clone https://github.com/<you>/uptime-monitor.git /root/uptime-monitor

# or copy from your PC
scp -r "Uptime Monitor" root@<container-ip>:/root/uptime-monitor

# or from the Proxmox host
pct push <CTID> uptime-monitor.tar.gz /root/uptime-monitor.tar.gz
```

### 3. Install

```bash
cd /root/uptime-monitor
sudo ./deploy/install.sh
```

The installer:

1. installs `nodejs` (from Debian, or Node 22 from NodeSource if the distro version is older than 18) and `iputils-ping`,
2. creates a `uptime` system user,
3. copies the app to `/opt/uptime-monitor`,
4. keeps data in `/var/lib/uptime-monitor`,
5. writes settings to `/etc/uptime-monitor.env`,
6. installs and starts the `uptime-monitor` systemd service (auto-starts on boot, restarts on crash),
7. prints the URL and the admin password.

### Managing the service

```bash
systemctl status uptime-monitor
journalctl -u uptime-monitor -f          # logs
systemctl restart uptime-monitor         # after editing /etc/uptime-monitor.env
cat /var/lib/uptime-monitor/admin-password.txt
```

### Manual systemd install (without the script)

```bash
useradd --system --shell /usr/sbin/nologin uptime
mkdir -p /opt/uptime-monitor /var/lib/uptime-monitor
cp -r server.js package.json lib public /opt/uptime-monitor/
chown uptime:uptime /var/lib/uptime-monitor
cp deploy/uptime-monitor.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now uptime-monitor
```

## Windows

1. Install Node.js LTS from <https://nodejs.org>.
2. Double-click **`start.bat`** (or run `node server.js` in a terminal inside the folder).
3. Open <http://localhost:3000>. The admin password is shown in the window and saved in `data\admin-password.txt`.

Windows Firewall will ask whether to allow Node.js on the network the first time — allow it on private networks if other devices should reach the dashboard.

**Run it in the background at startup** (pick one):

- **Task Scheduler:** Create Task → *Run whether user is logged on or not* → Trigger *At startup* → Action *Start a program*: `node.exe`, arguments `server.js`, *Start in* = the project folder. On the Settings tab, uncheck *Stop the task if it runs longer than…*.
- **NSSM** (<https://nssm.cc>): `nssm install UptimeMonitor "C:\Program Files\nodejs\node.exe" server.js`, then set *Startup directory* to the project folder and start the service.

Settings can go in a `.env` file in the project folder (copy `.env.example`).

## macOS / anything else

```bash
node server.js
```

Use `launchd`, `pm2`, `supervisord` or any process manager to keep it running. With pm2:

```bash
npm install -g pm2
pm2 start server.js --name uptime-monitor
pm2 save && pm2 startup
```

## Reverse proxy and HTTPS

Put the monitor behind a reverse proxy to serve it on a domain with HTTPS. This is also what you need for [Google sign-in](GOOGLE_SIGNIN.md) from other devices, because Google only allows HTTPS domains or `localhost`, not LAN IPs. Set **`TRUST_PROXY=true`** so the app knows the original client IP and that the connection is HTTPS (login cookies are then marked `Secure`). Optionally set `HOST=127.0.0.1` so the app is only reachable through the proxy.

**Caddy** (automatic HTTPS) — see `deploy/Caddyfile`:

```
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** — see `deploy/nginx.conf`, then `certbot --nginx -d status.example.com`.

**Nginx Proxy Manager / Traefik / Cloudflare Tunnel** — point them at `http://<host>:3000`; no special settings are needed apart from `TRUST_PROXY=true`.

Serving under a sub-path (e.g. `example.com/status/`, with the trailing slash) works too, because the dashboard only uses relative URLs. Make sure the proxy strips the prefix.

## Backups

Everything is in the data folder (`./data`, `/var/lib/uptime-monitor`, or the Docker volume):

| File | Contents |
|---|---|
| `monitors.json` | your monitors |
| `settings.json` | title, webhooks, visibility options |
| `history.json` | check results (24 h raw, 90 days hourly) |
| `self.json` | the monitor's own uptime record |
| `admin-password.txt` | generated admin password (if `ADMIN_PASSWORD` isn't set) |
| `sessions.json` | signed-in sessions |

Copy the folder to back up; copy it back to restore. For just the monitor list, use **Settings → Export monitors** and **Import monitors**.

Docker volume backup:

```bash
docker run --rm -v uptime-data:/data -v "$PWD":/backup alpine tar czf /backup/uptime-backup.tgz -C /data .
```

## Updating

Replace the code and restart; the data folder is untouched.

- **Docker Compose:** `git pull && docker compose up -d --build`
- **systemd:** `git pull && sudo ./deploy/install.sh` (it keeps your data and settings)
- **Plain Node / Windows:** replace `server.js`, `lib/` and `public/`, then restart.

## Monitoring the monitor

The monitor records its own outages and tells you about them **when it comes back** (and sends a *"restarted after being offline"* webhook). It can't send an alert while it's completely down, so for instant alerts about the monitor itself, point something external at the health endpoint:

```
GET /api/health   ->   200 {"status":"ok", ...}
```

Good options: a second Uptime Monitor instance on another machine (they can watch each other), a free external service such as UptimeRobot or Healthchecks.io, or your router/NAS monitoring.
