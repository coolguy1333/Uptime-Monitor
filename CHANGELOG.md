# Changelog

## 1.2.0

### Added
- **Multiple servers.** Point servers at each other with `PEERS` (and a shared `PEER_TOKEN`) and every dashboard shows an **Other servers** panel with each server's status and uptime. Give each server a name with `SERVER_NAME` or in Settings. See `docs/CONFIGURATION.md#peer-servers-multi-server--federation`.
- **Monitor sync.** With the same `PEER_TOKEN` on every server, monitors you add, edit, pause or delete on one server appear on all of them. Each server still runs its own checks and keeps its own history.
- Ping monitors fall back to TCP checks (ports 443, 80, 53) when ICMP isn't available, for example inside WebManager or a container without `NET_RAW`, or when the `ping` program isn't installed.
- `webmanager.json`, so the app deploys as an app in WebManager.
- The top banner also reports servers that are unreachable, and the monitor and settings screens explain what is synced and what the fields do.
- Clear messages when a peer can't be reached: wrong token, wrong address, redirect, refused, not responding.
- Ping "Status" is now a short label, with the full last-check message on its own line.

### Fixed
- Behind a reverse proxy, login rate limits could be bypassed by sending a fake `X-Forwarded-For` header. Wrong guesses of the admin password and of the API token now share one budget of 10 per minute per address, successful logins are never counted, and Google sign-in has its own limit.
- The admin password and API token could be guessed without limit through the `Authorization` header.
- `/api/peer-status` requests were counted as failed admin logins.
- Editing a monitor while a peer sync or another request changed the list could overwrite the wrong monitor.
- Imports larger than 100 KB failed with a dropped connection; the limit is now 2 MB and oversized requests get a proper error.
- Peer data is validated before it reaches the dashboard, peer responses are size-limited, and a peer with a wrong clock can no longer win every conflict or delete monitors.
- A poll timer leaked on every peer poll.
- Peer addresses were shown to public visitors even with "Show URLs / IP addresses to public visitors" off.
- `/api/logout` skipped the JSON content-type check.
- Data files that parse but have the wrong shape (for example `null`) no longer crash startup; history left by deleted monitors is cleaned up.
- The CDN in front of WebManager cached the page's script for 4 hours, so updates didn't show. The page now loads them under a versioned address.
- `/api/status` is computed at most every 2 seconds, so a busy public dashboard is cheap to serve.
- Idle keep-alive connections no longer end just before a reverse proxy reuses them.

## 1.1.0

### Added
- **Sign in with Google** (OAuth 2.0 / OpenID Connect with PKCE). Only accounts in `ADMIN_EMAILS` can sign in; `@domain.com` entries allow a whole Google Workspace domain. See `docs/GOOGLE_SIGNIN.md`.
- New settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `PUBLIC_URL`, `PASSWORD_LOGIN`, `ALLOW_EMBED`.
- Sessions survive restarts (hashed tokens in `sessions.json`). Sessions of removed admins are revoked at startup.
- The signed-in user is shown in the header, and Settings shows how sign-in is set up.
- TLS certificate expiry alerts at 14, 7, 3 and 1 days left.
- `GET /api/monitors` lists all monitors.
- TCP targets accept `host:port`, `[ipv6]:port` or a URL; ping targets accept a URL. The host (and port) are pulled out automatically.

### Fixed
- Keyword checks failed on gzip, deflate and brotli responses (the body is now decompressed).
- ntfy notifications failed, because emoji in the `Title` header aren't allowed in HTTP headers.
- Ping response times weren't read on non-English Windows (e.g. `Zeit=12ms`).
- Today's bar in the 90-day history was empty during the first half of each hour.
- On phones, the page scrolled sideways because the 90-day bars were too wide.
- A relative `DATA_DIR` depended on the folder the app was started from; it now always means the app folder.
- `.env` was loaded after some settings had already been read. It also now handles `export`, inline comments and a UTF-8 BOM.
- Clicking **Check now** while a check was already running returned stale data; it now waits for that check.
- Manually checking a paused monitor could send down/up alerts.
- Pausing a monitor, or changing its target, kept the old up/down state, cert info and "down since" time.
- Deep links like `/foo/bar` loaded a broken page; they now return 404.
- Sending `null`, strings or arrays as JSON bodies caused 500 errors.
- `"false"` strings were treated as `true` for boolean fields in the API.
- `ftp://…` targets were silently turned into `https://ftp://…`.
- Invalid accepted-status lists such as `200-,` were accepted.
- The installer stopped when `apt-get update` hit an unrelated broken repository.
- Closing the console window on Windows (`SIGHUP`/`SIGBREAK`) didn't save history.
- Stale static files could be cached for 5 minutes after an update.
- The login rate-limit table was never cleaned up.
- An older `self.json` without some fields could crash startup.

## 1.0.0
- First release.
