'use strict';
// Check implementations. Each returns a Promise<{ ok, ms, msg, code?, cert? }> and never rejects.
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const DAY = 24 * 3600e3;
const UA = 'UptimeMonitor/1.0 (+self-hosted)';
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const HOST_RE = /^[a-zA-Z0-9._:%-]+$/;

const now = () => Number(process.hrtime.bigint() / 1000000n);

function friendlyError(err) {
  const map = {
    ENOTFOUND: 'DNS lookup failed',
    EAI_AGAIN: 'DNS lookup timed out',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    ETIMEDOUT: 'Connection timed out',
    CERT_HAS_EXPIRED: 'TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify TLS certificate',
  };
  return map[err.code] || err.message || String(err);
}

// "200-299,301,404" -> matcher
function statusAccepted(code, spec) {
  for (const part of String(spec || '200-399').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (m && code >= +m[1] && code <= +m[2]) return true;
    if (/^\d{3}$/.test(p) && code === +p) return true;
    if (/^\dxx$/i.test(p) && Math.floor(code / 100) === +p[0]) return true;
  }
  return false;
}

function httpCheck(m) {
  return new Promise(resolve => {
    const t0 = now();
    const timeoutMs = (m.timeout || 10) * 1000;
    let done = false;
    let current = null;
    let redirects = 0;

    const finish = (ok, msg, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (current) current.destroy();
      resolve({ ok, ms: now() - t0, msg, ...extra });
    };
    const deadline = setTimeout(() => finish(false, `Timed out after ${m.timeout || 10}s`), timeoutMs);

    const go = urlStr => {
      let u;
      try { u = new URL(urlStr); } catch { return finish(false, 'Invalid URL'); }
      const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!lib) return finish(false, `Unsupported protocol ${u.protocol}`);
      const method = (m.method || 'GET').toUpperCase();
      const req = lib.request(u, {
        method,
        agent: false,
        rejectUnauthorized: !m.ignoreTls,
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache' },
      }, res => {
        if (req !== current) return res.resume();
        const code = res.statusCode;
        let cert;
        if (u.protocol === 'https:' && typeof res.socket.getPeerCertificate === 'function') {
          const c = res.socket.getPeerCertificate();
          if (c && c.valid_to) {
            const validTo = new Date(c.valid_to);
            cert = { validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - Date.now()) / DAY), issuer: c.issuer && (c.issuer.O || c.issuer.CN) };
          }
        }
        if (REDIRECT_CODES.has(code) && res.headers.location && m.followRedirects !== false) {
          res.resume();
          if (++redirects > 10) return finish(false, 'Too many redirects');
          return go(new URL(res.headers.location, u).toString());
        }
        const accepted = statusAccepted(code, m.acceptedStatus);
        const keyword = (m.keyword || '').trim();
        if (!keyword || method === 'HEAD') {
          res.resume();
          return finish(accepted, `HTTP ${code}${accepted ? '' : ' (not accepted)'}`, { code, cert });
        }
        // Decompress if the server compressed the body (needed for keyword matching).
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => { if (body.length < 5e6) body += chunk; });
        stream.on('error', err => finish(false, `Could not read response: ${friendlyError(err)}`, { code, cert }));
        res.on('error', err => finish(false, friendlyError(err), { code, cert }));
        stream.on('end', () => {
          if (!accepted) return finish(false, `HTTP ${code} (not accepted)`, { code, cert });
          const found = body.toLowerCase().includes(keyword.toLowerCase());
          const ok = m.invertKeyword ? !found : found;
          const msg = m.invertKeyword
            ? (found ? `Keyword "${keyword}" found (should be absent)` : `HTTP ${code}, keyword absent`)
            : (found ? `HTTP ${code}, keyword found` : `Keyword "${keyword}" not found`);
          finish(ok, msg, { code, cert });
        });
      });
      current = req;
      req.on('error', err => { if (req === current) finish(false, friendlyError(err)); });
      req.end();
    };

    go(m.target);
  });
}

function tcpCheck(m) {
  return new Promise(resolve => {
    const t0 = now();
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve({ ok: false, ms: 0, msg: 'Invalid port' });
    const socket = net.connect({ host: m.target, port });
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: now() - t0, msg });
    };
    socket.setTimeout((m.timeout || 10) * 1000, () => finish(false, `Timed out after ${m.timeout || 10}s`));
    socket.once('connect', () => finish(true, `Port ${port} open`));
    socket.once('error', err => finish(false, friendlyError(err)));
  });
}

// ICMP ping using the system `ping` binary (no root needed for the Node process).
function pingCheck(m) {
  return new Promise(resolve => {
    const host = String(m.target || '').trim();
    if (!HOST_RE.test(host) || host.startsWith('-')) return resolve({ ok: false, ms: 0, msg: 'Invalid host' });
    const timeout = Math.max(1, Math.round(m.timeout || 5));
    const isWin = process.platform === 'win32';
    let args;
    if (isWin) args = ['-n', '1', '-w', String(timeout * 1000), host];
    else if (process.platform === 'darwin') args = ['-c', '1', '-t', String(timeout), host];
    else args = ['-c', '1', '-W', String(timeout), host];

    const t0 = now();
    let out = '';
    let done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(killer); resolve(r); } };
    let child;
    try {
      child = spawn('ping', args, { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, ms: 0, msg: `Cannot run ping: ${err.message}` });
    }
    const killer = setTimeout(() => { child.kill(); finish({ ok: false, ms: now() - t0, msg: `Timed out after ${timeout}s` }); }, timeout * 1000 + 3000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', err => finish({
      ok: false, ms: 0,
      msg: err.code === 'ENOENT' ? 'ping command not installed on this server' : `ping failed: ${err.message}`,
    }));
    child.on('close', code => {
      // Windows ping exits 0 for "Destination host unreachable" replies, so also require a TTL in the reply.
      const ok = code === 0 && (!isWin || /TTL=/i.test(out));
      // "time=12.3 ms" (Linux/macOS), "time<1ms" / "Zeit=12ms" / "temps=12 ms" (Windows, any language)
      const match = out.match(/[=<]\s*([\d.,]+)\s*ms\b/i);
      const ms = match ? parseFloat(match[1].replace(',', '.')) : now() - t0;
      if (ok) return finish({ ok: true, ms, msg: 'Reply received' });
      let msg = 'No reply';
      if (/unknown host|could not find host|name or service not known|cannot resolve/i.test(out)) msg = 'DNS lookup failed';
      else if (/unreachable/i.test(out)) msg = 'Destination unreachable';
      else if (/operation not permitted|permission denied/i.test(out)) msg = 'ping not permitted (see docs: ICMP permissions)';
      finish({ ok: false, ms: now() - t0, msg });
    });
  });
}

async function runCheck(m) {
  try {
    switch (m.type) {
      case 'http': return await httpCheck(m);
      case 'tcp': return await tcpCheck(m);
      case 'ping': return await pingCheck(m);
      default: return { ok: false, ms: 0, msg: `Unknown monitor type "${m.type}"` };
    }
  } catch (err) {
    return { ok: false, ms: 0, msg: `Check crashed: ${err.message}` };
  }
}

module.exports = { runCheck, statusAccepted, HOST_RE };
