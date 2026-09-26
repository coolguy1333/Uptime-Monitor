#!/usr/bin/env node
'use strict';
/*
 * Uptime Monitor - self-hosted uptime & status dashboard.
 * Zero dependencies: needs only Node.js 18+.
 *   node server.js
 * See README.md for configuration.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Load .env before anything reads process.env.
loadDotEnv(path.join(__dirname, '.env'));

const { Store, DAY } = require('./lib/store');
const { Notifier } = require('./lib/notify');
const { Scheduler } = require('./lib/scheduler');
const { SelfTracker } = require('./lib/self');
const { Auth, AuthError } = require('./lib/auth');
const { HOST_RE } = require('./lib/checks');
const { PeerHub } = require('./lib/peers');

const truthy = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());

const VERSION = require('./package.json').version;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
// Relative DATA_DIR values are relative to this folder, not to wherever the app was started from.
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const TRUST_PROXY = truthy(process.env.TRUST_PROXY);
const ALLOW_EMBED = truthy(process.env.ALLOW_EMBED);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Other Uptime Monitor instances to federate with (see docs/CONFIGURATION.md#peer-servers).
// A URL matching our own PUBLIC_URL is dropped so a copy-pasted PEERS list can't make an
// instance poll itself.
const PEER_URLS = (process.env.PEERS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean).filter(u => u !== PUBLIC_URL);
const PEER_TOKEN = (process.env.PEER_TOKEN || '').trim();

const settingsDefaults = {};
if (process.env.SITE_TITLE) settingsDefaults.title = process.env.SITE_TITLE;
if (process.env.PUBLIC_DASHBOARD) settingsDefaults.publicDashboard = !/^(0|false|no|off)$/i.test(process.env.PUBLIC_DASHBOARD.trim());

const store = new Store(DATA_DIR, { settings: settingsDefaults });
const notifier = new Notifier(store);
const scheduler = new Scheduler(store, notifier);
const selfTracker = new SelfTracker(store, notifier);
const auth = new Auth(DATA_DIR);
auth.revokeDisallowed();
const peerHub = new PeerHub(store, { urls: PEER_URLS, token: PEER_TOKEN });
if (PEER_URLS.length && !PEER_TOKEN) {
  console.warn('[peers] PEERS is set without PEER_TOKEN - /api/peer-status is public and unauthenticated. Set PEER_TOKEN to restrict it to your own servers.');
}

if (store.firstRun) {
  store.monitors = [
    newMonitor({ name: 'Example website', type: 'http', target: 'https://example.com' }),
    newMonitor({ name: 'Cloudflare DNS (ping)', type: 'ping', target: '1.1.1.1' }),
    newMonitor({ name: 'Google DNS (TCP 53)', type: 'tcp', target: '8.8.8.8', port: 53 }),
  ];
  store.saveMonitors();
  store.saveSettings();
}

// ---------------------------------------------------------------- helpers

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // inline comment on an unquoted value
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function newMonitor(fields) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: '', type: 'http', target: '', port: null,
    interval: 60, timeout: 10, retries: 1,
    method: 'GET', acceptedStatus: '200-399', keyword: '', invertKeyword: false,
    ignoreTls: false, followRedirects: true, paused: false,
    createdAt: Date.now(),
    ...fields,
  };
}

const int = (v, min, max, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const bool = v => (typeof v === 'string' ? truthy(v) : Boolean(v));

function validateMonitor(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { monitor: base, errors: ['Expected a JSON object'] };
  const m = { ...base };
  const errors = [];
  const str = (v, max) => String(v ?? '').trim().slice(0, max);

  if ('name' in input) m.name = str(input.name, 100);
  if (!m.name) errors.push('Name is required');

  if ('type' in input) m.type = String(input.type);
  if (!['http', 'tcp', 'ping'].includes(m.type)) errors.push('Type must be http, tcp or ping');

  if ('port' in input) m.port = input.port === '' || input.port == null ? null : Number(input.port);
  if ('target' in input) m.target = str(input.target, 2000);

  if (!m.target) errors.push('Target is required');
  else if (m.type === 'http') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(m.target) && !/^https?:\/\//i.test(m.target)) errors.push('Only http:// and https:// URLs are supported');
    else {
      if (!/^https?:\/\//i.test(m.target)) m.target = 'https://' + m.target;
      try { new URL(m.target); } catch { errors.push('Target must be a valid URL'); }
    }
  } else {
    // Be forgiving: accept "https://host/path", "host:port" and "[::1]" and reduce them to a host.
    let t = m.target;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        t = u.hostname;
        if (m.type === 'tcp' && m.port == null) m.port = Number(u.port) || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null);
      } catch { /* validated below */ }
    }
    const hostPort = t.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
    if (hostPort && !/:.*:/.test(t.replace(/^\[.*\]/, ''))) {
      t = hostPort[1];
      if (m.type === 'tcp' && m.port == null) m.port = Number(hostPort[2]);
    }
    t = t.replace(/^\[(.*)\]$/, '$1');
    m.target = t;
    if (!HOST_RE.test(t) || t.startsWith('-')) errors.push('Target must be a hostname or IP address (no spaces)');
  }

  if (m.type === 'tcp' && !(Number.isInteger(m.port) && m.port >= 1 && m.port <= 65535)) errors.push('TCP monitors need a port between 1 and 65535');
  if (m.type !== 'tcp') m.port = null;

  m.interval = 'interval' in input ? int(input.interval, 10, 86400, 60) : m.interval;
  m.timeout = 'timeout' in input ? int(input.timeout, 1, 120, 10) : m.timeout;
  m.retries = 'retries' in input ? int(input.retries, 0, 10, 1) : m.retries;
  for (const k of ['interval', 'timeout', 'retries']) if (Number.isNaN(m[k])) errors.push(`${k} must be a number`);

  if ('method' in input) m.method = String(input.method).toUpperCase();
  if (!['GET', 'HEAD'].includes(m.method)) errors.push('Method must be GET or HEAD');

  if ('acceptedStatus' in input) m.acceptedStatus = str(input.acceptedStatus, 100) || '200-399';
  if (!/^\s*(\d{3}(\s*-\s*\d{3})?|\dxx)(\s*,\s*(\d{3}(\s*-\s*\d{3})?|\dxx))*\s*,?\s*$/i.test(m.acceptedStatus)) errors.push('Accepted status codes look like "200-299, 301" or "2xx"');

  if ('keyword' in input) m.keyword = str(input.keyword, 200);
  for (const k of ['invertKeyword', 'ignoreTls', 'followRedirects', 'paused']) if (k in input) m[k] = bool(input[k]);

  return { monitor: m, errors };
}

function round(n, d = 2) { return n == null ? null : Math.round(n * 10 ** d) / 10 ** d; }

function uptimeSet(fn) {
  return { '24h': round(fn(DAY)), '7d': round(fn(7 * DAY)), '30d': round(fn(30 * DAY)), '90d': round(fn(90 * DAY)) };
}

function showTargets(authed) { return authed || store.settings.publicShowTargets; }

function monitorSummary(m, authed) {
  const h = store.history[m.id] || { raw: [], status: 'pending' };
  const last = h.raw[h.raw.length - 1];
  const cutoff = Date.now() - DAY;
  const dayChecks = h.raw.filter(c => c.t >= cutoff && c.ok && typeof c.ms === 'number');
  const avg = dayChecks.length ? dayChecks.reduce((a, c) => a + c.ms, 0) / dayChecks.length : null;
  const out = {
    id: m.id,
    name: m.name,
    type: m.type,
    interval: m.interval,
    paused: m.paused,
    status: m.paused ? 'paused' : (h.status || 'pending'),
    downSince: !m.paused && h.status === 'down' ? h.downSince : null,
    last: last ? { t: last.t, ok: last.ok, ms: last.ms, msg: last.msg } : null,
    avgMs24h: round(avg, 1),
    uptime: uptimeSet(w => store.uptime(m.id, w)),
    recent: h.raw.slice(-60).map(c => ({ t: c.t, ok: c.ok, ms: c.ms, msg: c.msg })),
    cert: h.cert || null,
  };
  if (showTargets(authed)) { out.target = m.target; out.port = m.port; }
  if (authed) out.config = m;
  return out;
}

function downsample(checks, maxPoints) {
  if (checks.length <= maxPoints) return checks.map(c => ({ t: c.t, ok: c.ok, ms: c.ms }));
  const size = Math.ceil(checks.length / maxPoints);
  const out = [];
  for (let i = 0; i < checks.length; i += size) {
    const group = checks.slice(i, i + size);
    const okOnes = group.filter(c => c.ok && typeof c.ms === 'number');
    out.push({
      t: group[group.length - 1].t,
      ok: group.every(c => c.ok),
      ms: okOnes.length ? round(okOnes.reduce((a, c) => a + c.ms, 0) / okOnes.length, 1) : null,
    });
  }
  return out;
}

function selfSummary(authed) {
  const s = store.self;
  const now = Date.now();
  const out = {
    status: 'up',
    startedAt: s.startedAt,
    firstStart: s.firstStart,
    processUptime: Math.round(process.uptime()),
    restarts: s.restarts,
    uptime: uptimeSet(w => store.selfUptime(w, now)),
    daily: store.selfDaily(90, now),
    lastDowntime: s.downtimes.length ? s.downtimes[s.downtimes.length - 1] : null,
    downtimeCount30d: s.downtimes.filter(d => d.end > now - 30 * DAY).length,
    events: s.events.slice(-20).reverse(),
    version: VERSION,
  };
  if (authed) {
    const mem = process.memoryUsage();
    out.host = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${process.arch})`,
      node: process.version,
      osUptime: Math.round(os.uptime()),
      loadavg: process.platform === 'win32' ? null : os.loadavg().map(n => round(n)),
      memoryRss: mem.rss,
      systemMemory: { total: os.totalmem(), free: os.freemem() },
      cpus: os.cpus().length,
      dataDir: DATA_DIR,
    };
  }
  return out;
}

// One entry per configured peer: what it last reported about itself (`self`, absent until the
// first successful poll, kept around afterwards even if the peer later goes unreachable), plus
// the uptime of that peer as observed from here (`observedUptime` - what fraction of our polls
// reached it), which keeps working even if the peer's own self-tracking data can't be reached.
function peerSummaries() {
  return peerHub.entries().map(p => ({
    url: p.url,
    name: p.name,
    reachable: p.reachable,
    error: p.error,
    checkedAt: p.checkedAt,
    version: p.version,
    self: p.self,
    observedUptime: uptimeSet(w => store.uptime(p.id, w)),
  }));
}

// ---------------------------------------------------------------- http plumbing

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self'; form-action 'self'; base-uri 'none'" +
    (ALLOW_EMBED ? '' : "; frame-ancestors 'none'"),
  ...(ALLOW_EMBED ? {} : { 'X-Frame-Options': 'DENY' }),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 100 * 1024) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      if (!data || typeof data !== 'object') return reject(Object.assign(new Error('Expected a JSON object'), { status: 400 }));
      resolve(data);
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  if (PUBLIC_URL.startsWith('https://')) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Base URL of this site as seen by the browser (used for the Google redirect URI).
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${PORT}`;
  return `${isSecure(req) ? 'https' : 'http'}://${String(host).split(',')[0].trim()}`;
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Always revalidate so updates show up immediately (the files are tiny).
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const user = auth.user(req, clientIp(req));
  const authed = Boolean(user);
  const method = req.method;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const needAuth = () => { if (!authed) { send(res, 401, { error: 'Login required' }); return true; } return false; };
  const needJson = () => {
    // Cheap CSRF protection: browsers cannot send application/json cross-site without a CORS preflight.
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) { send(res, 415, { error: 'Content-Type must be application/json' }); return true; }
    return false;
  };
  const canView = authed || store.settings.publicDashboard;

  // Health check for Docker / external monitors. Always public.
  if (p === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    return send(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), version: VERSION, time: new Date().toISOString() });
  }

  // What sibling instances poll to federate with this one. Public unless PEER_TOKEN is set;
  // never includes monitors, targets or host details - only this server's own uptime record.
  if (p === '/api/peer-status' && (method === 'GET' || method === 'HEAD')) {
    if (!peerHub.authorizeIncoming(req, clientIp(req))) return send(res, 401, { error: 'Invalid or missing peer token' });
    return send(res, 200, { name: store.settings.title, version: VERSION, time: Date.now(), self: selfSummary(false) });
  }

  if (p === '/api/status' && method === 'GET') {
    const base = {
      title: store.settings.title,
      authed,
      user: user ? { name: user.name, email: user.email || null, picture: user.picture || null, method: user.method } : null,
      auth: auth.methods(),
      publicDashboard: store.settings.publicDashboard,
      version: VERSION,
      serverTime: Date.now(),
    };
    if (!canView) return send(res, 200, { ...base, locked: true });
    const monitors = store.monitors.map(m => monitorSummary(m, authed));
    const counts = { up: 0, down: 0, pending: 0, paused: 0 };
    for (const m of monitors) counts[m.status] = (counts[m.status] || 0) + 1;
    return send(res, 200, { ...base, self: selfSummary(authed), counts, monitors, peers: peerSummaries() });
  }

  // ---- password login
  if (p === '/api/login' && method === 'POST') {
    if (needJson()) return;
    if (!auth.passwordLogin) return send(res, 403, { error: 'Password login is disabled. Sign in with Google.' });
    if (auth.rateLimited(clientIp(req))) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const body = await readBody(req);
    if (!auth.check(body.password)) return send(res, 401, { error: 'Wrong password' });
    const token = auth.createSession({ method: 'password', name: 'Admin' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(token, isSecure(req)) });
  }

  // ---- Google sign-in
  if (p === '/api/auth/google' && method === 'GET') {
    const home = PUBLIC_URL ? `${PUBLIC_URL}/` : '../../';
    if (!auth.google) return redirect(res, `${home}?login_error=google_disabled`);
    if (auth.rateLimited(clientIp(req))) return redirect(res, `${home}?login_error=rate_limited`);
    const { url: googleUrl, cookie } = auth.googleStart(`${baseUrl(req)}/api/auth/google/callback`, isSecure(req));
    return redirect(res, googleUrl, { 'Set-Cookie': cookie });
  }

  if (p === '/api/auth/google/callback' && method === 'GET') {
    const home = PUBLIC_URL ? `${PUBLIC_URL}/` : '../../../';
    const clear = auth.clearStateCookie(isSecure(req));
    try {
      const u = await auth.googleCallback(req, url.searchParams);
      const token = auth.createSession(u);
      return redirect(res, home, { 'Set-Cookie': [clear, auth.cookie(token, isSecure(req))] });
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'google_error';
      if (!(err instanceof AuthError)) console.error('[auth]', err);
      return redirect(res, `${home}?login_error=${encodeURIComponent(code)}`, { 'Set-Cookie': clear });
    }
  }

  if (p === '/api/logout' && method === 'POST') {
    const token = auth.tokenFrom(req);
    if (token) auth.destroySession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(null, isSecure(req)) });
  }

  // ---- settings
  if (p === '/api/settings') {
    if (needAuth()) return;
    if (method === 'GET') {
      return send(res, 200, {
        ...store.settings,
        envWebhooks: Boolean(process.env.NOTIFY_WEBHOOK_URL),
        auth: { ...auth.methods(), adminEmails: auth.google ? auth.google.admins : [], passwordSource: auth.source },
      });
    }
    if (method === 'PUT') {
      if (needJson()) return;
      const body = await readBody(req);
      const s = store.settings;
      if ('webhooks' in body) {
        const list = (Array.isArray(body.webhooks) ? body.webhooks : String(body.webhooks ?? '').split(/\r?\n/)).map(u => String(u).trim()).filter(Boolean);
        for (const u of list) {
          let ok = /^https?:\/\//i.test(u);
          try { new URL(u); } catch { ok = false; }
          if (!ok) return send(res, 400, { error: `Invalid webhook URL: ${u}` });
        }
        s.webhooks = list.slice(0, 20);
      }
      if ('title' in body) s.title = String(body.title ?? '').trim().slice(0, 100) || 'Uptime Monitor';
      if ('publicShowTargets' in body) s.publicShowTargets = bool(body.publicShowTargets);
      if ('publicDashboard' in body) s.publicDashboard = bool(body.publicDashboard);
      store.saveSettings();
      return send(res, 200, s);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (p === '/api/settings/test-notification' && method === 'POST') {
    if (needAuth() || needJson()) return;
    if (!notifier.urls().length) return send(res, 400, { error: 'No webhooks configured' });
    return send(res, 200, { results: await notifier.test() });
  }

  if (p === '/api/export' && method === 'GET') {
    if (needAuth()) return;
    return send(res, 200, { version: VERSION, exportedAt: new Date().toISOString(), settings: store.settings, monitors: store.monitors },
      { 'Content-Disposition': 'attachment; filename="uptime-monitor-export.json"' });
  }

  if (p === '/api/import' && method === 'POST') {
    if (needAuth() || needJson()) return;
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : body.monitors;
    if (!Array.isArray(list)) return send(res, 400, { error: 'Expected { "monitors": [...] }' });
    if (list.length > 500) return send(res, 400, { error: 'Too many monitors in one import (max 500)' });
    const added = [];
    for (const [i, item] of list.entries()) {
      const { monitor, errors } = validateMonitor(item, newMonitor({}));
      if (errors.length) return send(res, 400, { error: `Monitor #${i + 1}${item && item.name ? ` (${item.name})` : ''}: ${errors.join(', ')}` });
      added.push(monitor);
    }
    store.monitors.push(...added);
    store.saveMonitors();
    added.forEach((m, i) => scheduler.schedule(m, 500 + i * 250));
    return send(res, 200, { imported: added.length });
  }

  // ---- monitors
  if (p === '/api/monitors') {
    if (method === 'GET') {
      if (!canView) return send(res, 401, { error: 'Login required' });
      return send(res, 200, store.monitors.map(m => monitorSummary(m, authed)));
    }
    if (method === 'POST') {
      if (needAuth() || needJson()) return;
      const body = await readBody(req);
      const { monitor, errors } = validateMonitor(body, newMonitor({}));
      if (errors.length) return send(res, 400, { error: errors.join('. ') });
      store.monitors.push(monitor);
      store.saveMonitors();
      scheduler.schedule(monitor, 100);
      return send(res, 201, monitorSummary(monitor, true));
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const match = p.match(/^\/api\/monitors\/([a-f0-9]+)(\/check)?$/);
  if (match) {
    const id = match[1];
    const idx = store.monitors.findIndex(m => m.id === id);
    if (idx === -1) return send(res, canView ? 404 : 401, { error: canView ? 'Monitor not found' : 'Login required' });
    const m = store.monitors[idx];

    if (match[2]) {
      if (method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      if (needAuth() || needJson()) return;
      await scheduler.run(id);
      return send(res, 200, monitorSummary(store.monitors.find(x => x.id === id) || m, true));
    }

    if (method === 'GET') {
      if (!canView) return send(res, 401, { error: 'Login required' });
      const h = store.history[id] || { raw: [], events: [] };
      return send(res, 200, {
        ...monitorSummary(m, authed),
        checks24h: downsample(h.raw.filter(c => c.t >= Date.now() - DAY), 288),
        daily: store.daily(id, 90),
        events: (h.events || []).slice(-30).reverse(),
      });
    }
    if (method === 'PUT') {
      if (needAuth() || needJson()) return;
      const body = await readBody(req);
      const { monitor, errors } = validateMonitor(body, m);
      if (errors.length) return send(res, 400, { error: errors.join('. ') });
      const targetChanged = monitor.type !== m.type || monitor.target !== m.target || monitor.port !== m.port;
      const pausedNow = monitor.paused && !m.paused;
      store.monitors[idx] = monitor;
      store.saveMonitors();
      if (targetChanged || pausedNow) scheduler.reset(id);
      scheduler.schedule(monitor, 200);
      return send(res, 200, monitorSummary(monitor, true));
    }
    if (method === 'DELETE') {
      if (needAuth()) return;
      store.monitors.splice(idx, 1);
      scheduler.remove(id);
      store.deleteHistory(id);
      store.saveMonitors();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!err.status) console.error('[http]', err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Internal server error' });
  }
});

// ---------------------------------------------------------------- lifecycle

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT to a different value.`);
  else if (err.code === 'EACCES') console.error(`No permission to listen on port ${PORT}. Use a port above 1024.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Start monitoring only once the web server is up.
  selfTracker.start();
  scheduler.start();
  if (PEER_URLS.length) peerHub.start();
  setInterval(() => store.saveHistory(), 30e3).unref();

  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Uptime Monitor v${VERSION} running at http://${shown}:${PORT}`);
  if (PUBLIC_URL) console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Monitoring ${store.monitors.length} target(s).`);
  if (PEER_URLS.length) console.log(`Federated with ${PEER_URLS.length} peer server(s): ${PEER_URLS.join(', ')}`);
  const m = auth.methods();
  if (m.google) {
    console.log(`Google sign-in: enabled for ${auth.google.admins.join(', ') || '(nobody - set ADMIN_EMAILS)'}`);
    console.log(`  Authorized redirect URI to register in Google Cloud: ${PUBLIC_URL || `http://localhost:${PORT}`}/api/auth/google/callback`);
  }
  console.log(`Password login: ${m.password ? 'enabled' : 'disabled'} (API bearer token still works)`);
  if (auth.generated) {
    console.log('');
    console.log('  An admin password / API token was generated for you:');
    console.log(`    ${auth.password}`);
    console.log(`  It is saved in ${auth.source}. Set ADMIN_PASSWORD to use your own.`);
    console.log('');
  } else {
    console.log(`Admin password source: ${auth.source}`);
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, saving data and shutting down...`);
  scheduler.stop();
  peerHub.stop();
  store.saveHistory(true);
  selfTracker.shutdown();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', err => console.error('[uncaught]', err));
process.on('unhandledRejection', err => console.error('[unhandled]', err));
