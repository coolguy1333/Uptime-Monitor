'use strict';
// Peer federation: polls a list of sibling Uptime Monitor instances' /api/peer-status
// endpoint so every instance in the group can show a combined "which servers are up"
// view. There is no leader - each instance independently polls the others, so no
// single instance being down loses the group's visibility into everyone else.
const crypto = require('crypto');

const POLL_MS = 20000;
const TIMEOUT_MS = 10000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();

// Node's fetch() throws a generic "fetch failed" for network errors, with the real
// reason in err.cause. Map it to the same friendly messages lib/checks.js uses for monitors.
function friendlyError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Timed out after ${TIMEOUT_MS / 1000}s`;
  const code = err && err.cause && err.cause.code;
  const map = {
    ENOTFOUND: 'DNS lookup failed', EAI_AGAIN: 'DNS lookup timed out', ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset', EHOSTUNREACH: 'Host unreachable', ENETUNREACH: 'Network unreachable',
    ETIMEDOUT: 'Connection timed out', CERT_HAS_EXPIRED: 'TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify TLS certificate',
  };
  return (code && map[code]) || err.message || String(err);
}

class PeerHub {
  constructor(store, { urls = [], token = '' } = {}) {
    this.store = store;
    this.urls = [...new Set(urls)];
    this.token = token;
    this.tokenHash = token ? sha256(token) : null;
    this.remote = new Map();  // url -> { ok, name, version, self, error, checkedAt }
    this.timers = [];
    this.fails = new Map();   // ip -> { count, reset } - failed incoming peer-token attempts
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, a] of this.fails) if (a.reset < now) this.fails.delete(k);
    }, 10 * 60e3);
    t.unref();
  }

  peerId(url) {
    return `peer:${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
  }

  start() {
    this.urls.forEach((url, i) => this.scheduleNext(url, 1000 + i * 500));
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  scheduleNext(url, delay) {
    const t = setTimeout(() => this.poll(url).finally(() => this.scheduleNext(url, POLL_MS)), delay);
    t.unref();
    this.timers.push(t);
  }

  async poll(url) {
    const id = this.peerId(url);
    const t0 = Date.now();
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const res = await fetch(`${url}/api/peer-status`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.remote.set(url, { ok: true, name: body.name, version: body.version, self: body.self, checkedAt: Date.now() });
      this.store.record(id, { t: Date.now(), ok: true, ms: Date.now() - t0 });
    } catch (err) {
      // Keep the last known name/self so the dashboard can still show "last seen" data
      // for a peer that has gone offline, instead of the card going blank.
      const msg = friendlyError(err);
      const prev = this.remote.get(url);
      this.remote.set(url, {
        ok: false,
        name: prev && prev.name,
        version: prev && prev.version,
        self: prev && prev.self,
        error: msg,
        checkedAt: Date.now(),
      });
      this.store.record(id, { t: Date.now(), ok: false, ms: 0, msg });
    }
  }

  // Snapshot for /api/status: one entry per configured peer.
  entries() {
    return this.urls.map(url => {
      const r = this.remote.get(url);
      return {
        url,
        id: this.peerId(url),
        name: (r && r.name) || url.replace(/^https?:\/\//, ''),
        reachable: Boolean(r && r.ok),
        error: r && !r.ok ? r.error : null,
        checkedAt: (r && r.checkedAt) || null,
        version: (r && r.version) || null,
        self: (r && r.self) || null,
      };
    });
  }

  // Authenticates an inbound GET /api/peer-status request. When no token is configured
  // the endpoint is public (like /api/health) and this always returns true. Rate-limits
  // failed attempts only, the same pattern used for Bearer API-token guesses in lib/auth.js,
  // so a peer with the right token is never throttled.
  authorizeIncoming(req, ip) {
    if (!this.tokenHash) return true;
    const a = this.fails.get(ip);
    if (a && a.reset > Date.now() && a.count > 10) return false;
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const ok = crypto.timingSafeEqual(sha256(provided), this.tokenHash);
    if (!ok) {
      const now = Date.now();
      if (!a || a.reset < now) this.fails.set(ip, { count: 1, reset: now + 60e3 });
      else a.count++;
    }
    return ok;
  }
}

module.exports = { PeerHub };
