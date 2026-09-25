# Google sign-in

Admins can sign in with their Google account instead of a password. Only the accounts you list in `ADMIN_EMAILS` are let in; everyone else gets "not allowed".

How it works: standard OAuth 2.0 / OpenID Connect authorization-code flow with PKCE, a one-time `state` bound to a browser cookie, and a `nonce`. The ID token is fetched directly from Google's token endpoint with your client secret, and its issuer, audience, expiry, nonce and verified email are checked. Nothing is stored except a hashed session token and your email and name.

## 1. Pick the address you'll sign in from

Google only accepts these redirect addresses:

- **`https://` on a real domain**, e.g. `https://status.example.com` (the domain must end in a public suffix such as `.com`, `.net` or `.dev`, so `.lan` and `.local` don't work).
- **`http://localhost:<port>`** (or `http://127.0.0.1:<port>`), which only works on the machine running the monitor.

A raw LAN IP like `http://192.168.1.50:3000` is **not** allowed. For a homelab, the usual options are:

| Option | Sign-in address |
|---|---|
| Reverse proxy with a real domain and HTTPS (Caddy, Nginx Proxy Manager, Traefik) | `https://status.yourdomain.com` |
| Cloudflare Tunnel (no port forwarding needed) | `https://status.yourdomain.com` |
| Tailscale with HTTPS certificates (MagicDNS) | `https://uptime.your-tailnet.ts.net` |
| Only sign in on the monitor's own machine | `http://localhost:3000` |

You can register several redirect URIs on one Google client (e.g. both your domain and `localhost`).

Viewing the public dashboard works from anywhere, including LAN IPs. This restriction only affects signing in.

## 2. Create the Google OAuth client

1. Open <https://console.cloud.google.com/> and create a project (e.g. "Uptime Monitor"), or pick an existing one.
2. Go to **Google Auth Platform** (search for "OAuth consent screen" or "Google Auth Platform").
   - **Branding:** app name (e.g. "Uptime Monitor"), your support email, and developer contact email. Save.
   - **Audience:** choose **External** (or **Internal** if you use Google Workspace and only want your organization).
     While the app is in **Testing**, only the **Test users** you add here can sign in, so add your own Google address. You can also click **Publish app**. Apps that only ask for name and email (`openid email profile`) usually don't need Google's verification.
3. Go to **Clients → Create client**:
   - Application type: **Web application**
   - Name: anything
   - **Authorized redirect URIs:** add `<your address>/api/auth/google/callback`, for example
     - `https://status.example.com/api/auth/google/callback`
     - `http://localhost:3000/api/auth/google/callback`
   - Authorized JavaScript origins: not needed.
4. Click **Create** and copy the **Client ID** and **Client secret**. Newer Google projects only show the secret once, so save it now.

## 3. Configure Uptime Monitor

Set these environment variables (in `.env`, `/etc/uptime-monitor.env`, or `docker-compose.yml`):

```ini
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
ADMIN_EMAILS=you@gmail.com, partner@gmail.com

# Strongly recommended: the exact address you registered above (no trailing path)
PUBLIC_URL=https://status.example.com

# Behind a reverse proxy / tunnel:
TRUST_PROXY=true
```

Restart. The log shows:

```
Google sign-in: enabled for you@gmail.com
  Authorized redirect URI to register in Google Cloud: https://status.example.com/api/auth/google/callback
Password login: disabled (API bearer token still works)
```

Click **Sign in → Sign in with Google**.

### Variables

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID. Google sign-in turns on when both ID and secret are set. |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret. |
| `ADMIN_EMAILS` | Comma-separated Google accounts allowed to sign in. An entry like `@example.com` allows every account of that **Google Workspace** domain (checked with Google's `hd` claim, so it can't be faked with a Gmail address). |
| `PUBLIC_URL` | The public base URL, e.g. `https://status.example.com` or `https://example.com/status`. Used to build the redirect URI. If unset, it is worked out from the request's `Host` header (plus `X-Forwarded-*` when `TRUST_PROXY=true`). |
| `PASSWORD_LOGIN` | Password login is **off by default when Google sign-in is configured**. Set `true` to allow both. |

### Notes

- **Removing someone:** take them out of `ADMIN_EMAILS` and restart. Their existing sessions are revoked at startup.
- **Sessions** last 30 days and survive restarts (stored hashed in `DATA_DIR/sessions.json`). Delete that file and restart to sign everyone out.
- **Scripts / API:** `Authorization: Bearer <ADMIN_PASSWORD>` keeps working even when password login is disabled. The password acts as an API token (see `admin-password.txt`).
- **Locked out?** Set `PASSWORD_LOGIN=true`, restart, and sign in with the password from `admin-password.txt`.

## Troubleshooting

| Message / symptom | Fix |
|---|---|
| Google says **"Error 400: redirect_uri_mismatch"** | The redirect URI Uptime Monitor sent isn't registered. Copy the one printed in the startup log (or set `PUBLIC_URL` to your exact address) and add it under **Clients → your client → Authorized redirect URIs**. It must match exactly: scheme, host, port, and no trailing slash. Changes can take a few minutes. |
| Google says **"Access blocked: app has not completed verification"** or you can't pick your account | The app is in *Testing* and your account isn't a test user. Add it under **Audience → Test users**, or publish the app. |
| "That Google account is not allowed to sign in" | Add the email to `ADMIN_EMAILS` and restart. |
| "Sign-in expired or was started in another tab" | The sign-in took over 10 minutes, cookies are blocked, or the browser went back to a different address than it started from (e.g. started on `http://192.168…`, came back on `https://…`). Always open the dashboard on the same address as `PUBLIC_URL`. |
| "Could not verify with Google" | Wrong `GOOGLE_CLIENT_SECRET`, or the server can't reach `oauth2.googleapis.com` (check outbound internet / firewall / DNS). The server log has details. |
| Signed in, but immediately signed out again behind a proxy | Set `TRUST_PROXY=true` and `PUBLIC_URL`, and make sure the proxy passes cookies through. |
