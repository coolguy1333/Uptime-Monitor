'use strict';
// Authentication: Google sign-in (OAuth 2.0 / OpenID Connect, authorization code + PKCE)
// and/or a single admin password. Sessions are cookie based and survive restarts.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL = 30 * 24 * 3600e3;
const OAUTH_TTL = 10 * 60e3;
const COOKIE = 'um_session';
const STATE_COOKIE = 'um_oauth';

const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const sha256 = s => crypto.createHash('sha256').update(s).digest();
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const b64url = buf => Buffer.from(buf).toString('base64url');
const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());

class AuthError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

class Auth {
  constructor(dataDir) {
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.sessions = new Map();   // sha256(token) -> { exp, user }
    this.attempts = new Map();   // ip -> { count, reset }
    this.pending = new Map();    // oauth state -> { verifier, nonce, exp }

    // --- admin password (password login and "Authorization: Bearer" API access)
    let password = process.env.ADMIN_PASSWORD;
    this.source = 'ADMIN_PASSWORD environment variable';
    if (!password) {
      const file = path.join(dataDir, 'admin-password.txt');
      this.source = file;
      try {
        password = fs.readFileSync(file, 'utf8').trim();
      } catch {
        password = crypto.randomBytes(12).toString('base64url');
        fs.writeFileSync(file, password + '\n', { mode: 0o600 });
        this.generated = true;
      }
    }
    this.hash = sha256(password);
    this.password = password;

    // --- Google sign-in
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    this.google = clientId && clientSecret ? { clientId, clientSecret, admins } : null;
    if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
      console.warn('[auth] Google sign-in needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET - it is disabled.');
    }
    if (this.google && !admins.length) {
      console.warn('[auth] Google sign-in is enabled but ADMIN_EMAILS is empty, so nobody can sign in with Google.');
    }

    // Password login is on by default only when Google sign-in is not configured.
    this.passwordLogin = process.env.PASSWORD_LOGIN !== undefined && process.env.PASSWORD_LOGIN !== ''
      ? truthy(process.env.PASSWORD_LOGIN)
      : !this.google;

    this.loadSessions();
    const t = setInterval(() => this.cleanup(), 10 * 60e3);
    t.unref();
  }

  methods() {
    return { google: Boolean(this.google), password: this.passwordLogin };
  }

  // ------------------------------------------------------------ password
  check(password) {
    return crypto.timingSafeEqual(sha256(String(password || '')), this.hash);
  }

  rateLimited(ip) {
    const now = Date.now();
    const a = this.attempts.get(ip);
    if (!a || a.reset < now) { this.attempts.set(ip, { count: 1, reset: now + 60e3 }); return false; }
    a.count++;
    return a.count > 10;
  }

  // ------------------------------------------------------------ sessions
  loadSessions() {
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) if (v && v.exp > now) this.sessions.set(k, v);
    } catch { /* no sessions yet */ }
  }

  saveSessions() {
    const obj = Object.fromEntries(this.sessions);
    try {
      fs.writeFileSync(this.sessionsFile + '.tmp', JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(this.sessionsFile + '.tmp', this.sessionsFile);
    } catch (err) {
      try { fs.writeFileSync(this.sessionsFile, JSON.stringify(obj), { mode: 0o600 }); } catch { console.error(`[auth] Could not save sessions: ${err.message}`); }
    }
  }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sha256hex(token), { exp: Date.now() + SESSION_TTL, user });
    this.saveSessions();
    return token;
  }

  destroySession(token) {
    if (this.sessions.delete(sha256hex(token))) this.saveSessions();
  }

  // Sign out every session of a user who is no longer allowed.
  revokeDisallowed() {
    if (!this.google) return;
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (s.user && s.user.method === 'google' && !this.isAllowedEmail(s.user.email, s.user.hd)) { this.sessions.delete(k); changed = true; }
      if (s.user && s.user.method === 'password' && !this.passwordLogin) { this.sessions.delete(k); changed = true; }
    }
    if (changed) this.saveSessions();
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of this.sessions) if (s.exp < now) { this.sessions.delete(k); changed = true; }
    if (changed) this.saveSessions();
    for (const [k, a] of this.attempts) if (a.reset < now) this.attempts.delete(k);
    for (const [k, p] of this.pending) if (p.exp < now) this.pending.delete(k);
  }

  cookieValue(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  tokenFrom(req) { return this.cookieValue(req, COOKIE); }

  // Returns the signed-in user, or null.
  user(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return this.check(header.slice(7)) ? { name: 'API token', method: 'token' } : null;
    const token = this.tokenFrom(req);
    if (!token) return null;
    const key = sha256hex(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(key); return null; }
    return s.user;
  }

  isAuthed(req) { return Boolean(this.user(req)); }

  cookie(token, secure) {
    const maxAge = token ? SESSION_TTL / 1000 : 0;
    // Lax (not Strict) so the cookie survives the redirect back from Google.
    return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  // ------------------------------------------------------------ Google
  isAllowedEmail(email, hd) {
    if (!this.google || !email) return false;
    email = String(email).toLowerCase();
    return this.google.admins.some(entry =>
      entry.startsWith('@') ? (hd && `@${String(hd).toLowerCase()}` === entry) : entry === email);
  }

  // Builds the Google sign-in URL. Returns { url, cookie }.
  googleStart(redirectUri, secure) {
    if (!this.google) throw new AuthError('google_disabled');
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const nonce = b64url(crypto.randomBytes(16));
    this.pending.set(state, { verifier, nonce, redirectUri, exp: Date.now() + OAUTH_TTL });
    const params = new URLSearchParams({
      client_id: this.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    const cookie = `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TTL / 1000}${secure ? '; Secure' : ''}`;
    return { url: `${GOOGLE_AUTH_URL}?${params}`, cookie };
  }

  clearStateCookie(secure) {
    return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  // Handles the redirect back from Google. Returns the user or throws AuthError.
  async googleCallback(req, query) {
    if (!this.google) throw new AuthError('google_disabled');
    if (query.get('error')) throw new AuthError(query.get('error') === 'access_denied' ? 'cancelled' : 'google_error', query.get('error'));
    const state = query.get('state');
    const code = query.get('code');
    const cookieState = this.cookieValue(req, STATE_COOKIE);
    const pending = state && this.pending.get(state);
    if (!state || !code || !pending || cookieState !== state || pending.exp < Date.now()) throw new AuthError('invalid_state');
    this.pending.delete(state);

    let tokens;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: this.google.clientId,
          client_secret: this.google.clientSecret,
          redirect_uri: pending.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      tokens = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(tokens.error_description || tokens.error || `HTTP ${res.status}`);
    } catch (err) {
      console.error(`[auth] Google token exchange failed: ${err.message}`);
      throw new AuthError('token_exchange_failed', err.message);
    }

    // The ID token came straight from Google's token endpoint over HTTPS, authenticated with
    // our client secret, so its signature does not need to be re-verified (per Google's docs).
    // The claims are still checked.
    let claims;
    try {
      claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8'));
    } catch {
      throw new AuthError('bad_id_token');
    }
    const now = Math.floor(Date.now() / 1000);
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(this.google.clientId) : claims.aud === this.google.clientId;
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !audOk || !(claims.exp > now) || claims.nonce !== pending.nonce) {
      throw new AuthError('bad_id_token');
    }
    if (!claims.email || claims.email_verified === false || claims.email_verified === 'false') throw new AuthError('email_not_verified');
    if (!this.isAllowedEmail(claims.email, claims.hd)) {
      console.warn(`[auth] Google sign-in refused for ${claims.email} (not in ADMIN_EMAILS)`);
      throw new AuthError('not_allowed', claims.email);
    }
    console.log(`[auth] ${claims.email} signed in with Google`);
    return { method: 'google', email: claims.email, name: claims.name || claims.email, picture: claims.picture || null, hd: claims.hd || null, sub: claims.sub };
  }
}

module.exports = { Auth, AuthError };
