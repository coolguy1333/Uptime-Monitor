'use strict';
// Webhook notifications. Supports Discord, Slack, ntfy and generic JSON webhooks.

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function send(url, event) {
  const text = event.text;
  let body, headers = { 'Content-Type': 'application/json' };
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) {
    body = JSON.stringify({ content: text });
  } else if (/hooks\.slack\.com/i.test(url)) {
    body = JSON.stringify({ text });
  } else if (/ntfy/i.test(url)) {
    // HTTP headers can't carry emoji/UTF-8 directly: drop the emoji (ntfy tags add one) and
    // RFC 2047-encode anything else outside printable ASCII (ntfy decodes it).
    const plainTitle = event.title.replace(/^\S+\s/, '');
    const title = /^[\x20-\x7e]*$/.test(plainTitle) ? plainTitle : `=?UTF-8?B?${Buffer.from(plainTitle).toString('base64')}?=`;
    body = text.split('\n').slice(1).join('\n') || text;
    headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: title,
      Priority: event.status === 'down' ? 'high' : 'default',
      Tags: { down: 'rotating_light', warning: 'warning' }[event.status] || 'white_check_mark',
    };
  } else {
    body = JSON.stringify(event);
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

class Notifier {
  constructor(store) { this.store = store; }

  urls() {
    const fromEnv = (process.env.NOTIFY_WEBHOOK_URL || '').split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([...fromEnv, ...(this.store.settings.webhooks || [])])];
  }

  // Returns [{url, ok, error}] - used by the "send test" button.
  async emit(event) {
    const results = [];
    for (const url of this.urls()) {
      try {
        await send(url, event);
        results.push({ url, ok: true });
      } catch (err) {
        console.error(`[notify] Webhook failed (${url.replace(/\/[^/]{12,}$/, '/…')}): ${err.message}`);
        results.push({ url, ok: false, error: err.message });
      }
    }
    return results;
  }

  monitorDown(m, msg) {
    const title = `🔴 ${m.name} is DOWN`;
    return this.emit({ event: 'monitor_down', status: 'down', title, text: `${title}\n${msg}`, monitor: pick(m), message: msg, time: new Date().toISOString() });
  }

  monitorUp(m, msg, downForMs) {
    const title = `🟢 ${m.name} is UP`;
    const extra = downForMs ? ` (was down for ${formatDuration(downForMs)})` : '';
    return this.emit({ event: 'monitor_up', status: 'up', title, text: `${title}${extra}\n${msg}`, monitor: pick(m), message: msg, downForMs, time: new Date().toISOString() });
  }

  certExpiring(m, cert) {
    const d = cert.daysLeft;
    const when = d < 0 ? `expired ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'expires today' : `expires in ${d} day${d === 1 ? '' : 's'}`;
    const title = `🟠 TLS certificate for ${m.name} ${when}`;
    const text = `${title}\nValid until ${cert.validTo}${cert.issuer ? ` (issuer: ${cert.issuer})` : ''}`;
    return this.emit({ event: 'cert_expiring', status: 'warning', title, text, monitor: pick(m), cert, time: new Date().toISOString() });
  }

  selfRecovered(downForMs) {
    const title = `🟡 ${this.store.settings.title} restarted`;
    const text = `${title} after being offline for ${formatDuration(downForMs)}. Checks have resumed.`;
    return this.emit({ event: 'self_recovered', status: 'up', title, text, downForMs, time: new Date().toISOString() });
  }

  test() {
    const title = `✅ Test notification from ${this.store.settings.title}`;
    return this.emit({ event: 'test', status: 'up', title, text: `${title}\nWebhooks are working.`, time: new Date().toISOString() });
  }
}

function pick(m) { return { id: m.id, name: m.name, type: m.type, target: m.target, port: m.port }; }

module.exports = { Notifier, formatDuration };
