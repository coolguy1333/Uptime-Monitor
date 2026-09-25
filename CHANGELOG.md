# Changelog

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
