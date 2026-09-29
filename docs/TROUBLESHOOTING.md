# Troubleshooting

## Google sign-in problems

See the troubleshooting table in [GOOGLE_SIGNIN.md](GOOGLE_SIGNIN.md#troubleshooting). The common ones are `redirect_uri_mismatch` (register the exact URI printed in the startup log) and the app being in *Testing* without your account added as a test user.

## I don't know the admin password

- It is printed in the log on first start.
- It is saved in `admin-password.txt` in the data folder:
  - plain Node / Windows: `data/admin-password.txt`
  - systemd install: `/var/lib/uptime-monitor/admin-password.txt`
  - Docker: `docker compose exec uptime-monitor cat /data/admin-password.txt`
- To set your own, set `ADMIN_PASSWORD` and restart. To get a new random one, delete `admin-password.txt` and restart.

## Ping checks fail

**"Reachable via TCP 443 (ICMP ping isn't available here)"** — not an error. When ICMP can't be used, ping monitors automatically fall back to TCP connects on ports 443, 80 and 53. The host counts as up if any connects or actively refuses; it's down only if all three time out or fail to resolve. It's a reachability check rather than a true ping, and response times are TCP connect times. This happens when:
- the app isn't allowed to send ICMP (WebManager, and Docker without `NET_RAW`), or
- the `ping` program isn't installed (Debian/Ubuntu: `apt install iputils-ping`, Alpine: `apk add iputils`; the Docker image already includes it).

If you want real ICMP pings, the user running the app must be allowed to send them:
- **Docker/Podman:** add `cap_add: [NET_RAW]` under the service in `docker-compose.yml` (or `--cap-add NET_RAW`).
- **systemd:** the provided unit already grants `CAP_NET_RAW`. If you wrote your own unit, add `AmbientCapabilities=CAP_NET_RAW`.
- **Linux in general:** allow unprivileged ICMP for all groups:
  `echo 'net.ipv4.ping_group_range = 0 2147483647' | sudo tee /etc/sysctl.d/99-ping.conf && sudo sysctl --system`

**Host is up but ping says "No reply"** — many devices and cloud servers block ICMP (Windows PCs do by default). Use a TCP monitor on an open port instead (e.g. 22, 80, 443, 3389).

## An "Other servers" card says Unreachable

The card says why. Fix it on the server that shows the message:

| Message | What to do |
|---|---|
| Peer token rejected | `PEER_TOKEN` differs between the two servers. Set the exact same value on both (no spaces or quotes). |
| Not an Uptime Monitor server (HTTP 404 / unexpected response) | The address in `PEERS` isn't an Uptime Monitor. Check the address, and that the other server runs a version with peer support. |
| Redirected to https://… | Use the address it names (usually `https://` instead of `http://`) in `PEERS`. |
| Connection refused / timed out / DNS lookup failed | The other server is down, the port is wrong, or this server can't reach it. Try `curl <address>/api/health` from this machine. |
| Server not responding (HTTP 502/503/504) | The other server is restarting or its proxy can't reach it. It usually recovers by itself. |

`PEERS` lists the *other* servers (not this one), and each server must be able to reach the others' addresses. To sync monitors too, the same `PEER_TOKEN` is needed on every server.

## HTTPS site shows "Self-signed TLS certificate" or "Unable to verify TLS certificate"

Internal services (Proxmox on `:8006`, routers, NAS web UIs) often use self-signed certificates. Edit the monitor and tick **Ignore TLS/SSL errors**.

## A website is "down" with "HTTP 403" or "HTTP 429"

Some sites block automated requests or rate-limit them. Try `HEAD`, a longer interval, or add that code to *Accepted status codes* if a response at all is enough to prove it's up (e.g. `200-399,403`).

## Keyword not found, but I can see it in my browser

The monitor reads the raw HTML; it doesn't run JavaScript. Pick text that is in the page source (View Source in your browser), not text added by scripts.

## "Port 3000 is already in use"

Set another port: `PORT=8080 node server.js`, or change the left side of the Compose port mapping (`"8080:3000"`).

## Can't reach the dashboard from another device

- Check `HOST` isn't `127.0.0.1`.
- Allow the port in the firewall (`ufw allow 3000/tcp`; on Windows allow Node.js on private networks).
- In Docker, make sure the port is published (`-p 3000:3000`).

## Signed out unexpectedly

Sessions last 30 days and survive restarts. You are signed out if your email was removed from `ADMIN_EMAILS`, password login was turned off while you were signed in with the password, or `sessions.json` was deleted.

## Login doesn't stick behind a reverse proxy

If the site is served over HTTPS by a proxy, set `TRUST_PROXY=true`. Also make sure the proxy passes cookies and the `Host` header through unchanged.

## Docker: "permission denied" writing to /data

You bind-mounted a host folder owned by root. Either use the named volume from `docker-compose.yml`, or `sudo chown 1000:1000 ./data`.

## The "This server" uptime is lower than expected

Every time the app is stopped for more than 45 seconds — including while you update it, or while the host reboots — that time counts as downtime, because the status page really was unavailable. Restarts under 45 seconds are not counted. The event log on the card shows each outage and its cause.

## Data files got corrupted

On startup, an unreadable file is renamed to `<name>.corrupt-<timestamp>` and a fresh one is created, so the app still starts. Restore from a backup, or fix the JSON by hand and rename it back while the app is stopped.
