'use strict';
// Peer federation: polls a list of sibling Uptime Monitor instances' /api/peer-status
// endpoint so every instance in the group can show a combined "which servers are up"
// view. There is no leader - each instance independently polls the others, so no
// single instance being down loses the group's visibility into everyone else.
const crypto = require('crypto');
const { RateLimiter } = require('./ratelimit');

const POLL_MS = Math.max(1000, Number(process.env.PEER_POLL_MS) || 20000);
const TIMEOUT_MS = 10000;
const MAX_BODY = 1024 * 1024;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Node's fetch() throws a generic "fetch failed" for network errors, with the real
// reason in err.cause. Map it to the same friendly messages lib/checks.js uses for monitors.
function friendlyError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Timed out after ${TIMEOUT_MS / 1000}s`;
  const code = err && err.cause && err.cause.code;
  const map = {
    ENOTFOUND: 'DNS lookup failed - check the address in PEERS', EAI_AGAIN: 'DNS lookup timed out', ECONNREFUSED: 'Connection refused - is it running, and is the port right?',
    ECONNRESET: 'Connection reset', EHOSTUNREACH: 'Host unreachable', ENETUNREACH: 'Network unreachable',
    ETIMEDOUT: 'Connection timed out', CERT_HAS_EXPIRED: 'TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify TLS certificate',
  };
  return (code && map[code]) || err.message || String(err);
}

// Turns a non-OK answer into a message that says what to fix.
function httpProblem(res, url, body) {
  const s = res.status;
  if (s >= 300 && s < 400) {
    let where = res.headers.get('location') || '';
    try { where = new URL(where, url).origin; } catch { /* keep as is */ }
    return `Redirected${where ? ` to ${where}` : ''} - set PEERS to that address`;
  }
  if (s === 401) return 'Peer token rejected - PEER_TOKEN must be identical on both servers';
  if (s === 404) return 'Not an Uptime Monitor server (HTTP 404) - check the address in PEERS';
  if (s === 502 || s === 503 || s === 504) return `Server not responding (HTTP ${s}) - it may be restarting`;
  return str(body && body.error, 200) || `HTTP ${s}`;
}

// Reads a response body but gives up past `max` bytes, so a misbehaving peer can't exhaust memory.
async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel().catch(() => {}); throw new Error('Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Peers are only semi-trusted, and the dashboard renders these values, so keep just the fields
// the UI uses and force them to plain numbers.
function cleanSelf(s) {
  if (!s || typeof s !== 'object') return null;
  const u = s.uptime && typeof s.uptime === 'object' ? s.uptime : {};
  return {
    status: 'up',
    startedAt: num(s.startedAt),
    firstStart: num(s.firstStart),
    processUptime: num(s.processUptime) || 0,
    restarts: num(s.restarts) || 0,
    downtimeCount30d: num(s.downtimeCount30d) || 0,
    uptime: { '24h': num(u['24h']), '7d': num(u['7d']), '30d': num(u['30d']), '90d': num(u['90d']) },
    daily: (Array.isArray(s.daily) ? s.daily : []).slice(-90)
      .map(d => ({ t: num(d && d.t), pct: num(d && d.pct) })).filter(d => d.t !== null),
  };
}

class PeerHub {
  // onSync(monitors, deleted) is called with a peer's monitor list after each successful poll,
  // but only when a PEER_TOKEN is set (the list is only ever sent to token holders).
  constructor(store, { urls = [], token = '', onSync = null } = {}) {
    this.store = store;
    this.onSync = onSync;
    this.urls = [...new Set(urls)];
    this.token = token;
    this.tokenHash = token ? sha256(token) : null;
    this.remote = new Map();  // url -> { ok, name, version, self, error, checkedAt, lastSeen }
    this.timers = new Map();  // url -> pending poll timer
    this.stopped = false;
    this.failures = new RateLimiter(10); // wrong peer tokens per IP
  }

  peerId(url) {
    return `peer:${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
  }

  start() {
    this.stopped = false;
    this.urls.forEach((url, i) => this.scheduleNext(url, 1000 + i * 500));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  scheduleNext(url, delay) {
    if (this.stopped) return;
    const t = setTimeout(() => this.poll(url).finally(() => this.scheduleNext(url, POLL_MS)), delay);
    t.unref();
    this.timers.set(url, t);
  }

  async poll(url) {
    const id = this.peerId(url);
    const t0 = Date.now();
    const headers = { Accept: 'application/json', 'User-Agent': 'UptimeMonitor-Peer' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      // redirect: 'manual' so a redirect (e.g. http -> https) is reported instead of silently
      // dropping the Authorization header on the way.
      const res = await fetch(`${url}/api/peer-status`, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      let body = null;
      try { body = JSON.parse(await readCapped(res, MAX_BODY)); } catch { /* not JSON */ }
      if (!res.ok) throw new Error(httpProblem(res, url, body));
      const self = body && typeof body === 'object' ? cleanSelf(body.self) : null;
      if (!self) throw new Error('Not an Uptime Monitor server (unexpected response) - check the address in PEERS');
      const now = Date.now();
      this.remote.set(url, { ok: true, name: str(body.name, 100), version: str(body.version, 32), self, checkedAt: now, lastSeen: now });
      this.store.record(id, { t: now, ok: true, ms: now - t0 });
      if (this.token && this.onSync && Array.isArray(body.monitors)) {
        try { this.onSync(body.monitors, body.deleted); } catch (err) { console.error('[peers] Monitor sync failed:', err); }
      }
    } catch (err) {
      // Keep the last known name/self so the dashboard can still show "last seen" data
      // for a peer that has gone offline, instead of the card going blank.
      const msg = err.cause || err.name === 'TimeoutError' || err.name === 'AbortError' ? friendlyError(err) : err.message;
      const prev = this.remote.get(url) || {};
      this.remote.set(url, {
        ok: false,
        name: prev.name,
        version: prev.version,
        self: prev.self,
        error: msg,
        checkedAt: Date.now(),
        lastSeen: prev.lastSeen || null,
      });
      this.store.record(id, { t: Date.now(), ok: false, ms: 0, msg });
    }
  }

  // Snapshot for /api/status: one entry per configured peer.
  entries() {
    return this.urls.map(url => {
      const r = this.remote.get(url);
      const named = Boolean(r && r.name);
      return {
        url,
        id: this.peerId(url),
        named,
        name: named ? r.name : url.replace(/^https?:\/\//, ''),
        reachable: Boolean(r && r.ok),
        error: r && !r.ok ? r.error : null,
        checkedAt: (r && r.checkedAt) || null,
        lastSeen: (r && r.lastSeen) || null,
        version: (r && r.version) || null,
        self: (r && r.self) || null,
      };
    });
  }

  // Authenticates an inbound GET /api/peer-status request. When no token is configured
  // the endpoint is public (like /api/health) and this always returns true. Only wrong tokens
  // count against the rate limit, so a peer with the right token is never throttled.
  authorizeIncoming(req, ip) {
    if (!this.tokenHash) return true;
    if (this.failures.blocked(ip)) return false;
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const ok = crypto.timingSafeEqual(sha256(provided), this.tokenHash);
    if (!ok) this.failures.hit(ip);
    return ok;
  }
}

module.exports = { PeerHub };
