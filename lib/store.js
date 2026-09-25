'use strict';
// JSON-file storage. No database needed: everything lives in DATA_DIR.
//   monitors.json  - monitor definitions
//   settings.json  - site settings (title, webhooks, ...)
//   history.json   - check results (raw for 24h, hourly rollups for 90 days)
//   self.json      - this server's own uptime record (heartbeats, downtimes)
const fs = require('fs');
const path = require('path');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RAW_RETENTION = DAY;
const HOURLY_RETENTION = 90 * DAY;
const MAX_EVENTS = 100;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, backup); } catch { /* ignore */ }
      console.error(`[store] Could not parse ${file} (${err.message}). Moved to ${backup}.`);
    }
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(data);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse renames while another process (e.g. antivirus) has the file open.
    try { fs.writeFileSync(file, json); } catch (e) { console.error(`[store] Failed to write ${file}: ${e.message}`); }
  }
}

class Store {
  constructor(dir, defaults = {}) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = {
      monitors: path.join(dir, 'monitors.json'),
      settings: path.join(dir, 'settings.json'),
      history: path.join(dir, 'history.json'),
      self: path.join(dir, 'self.json'),
    };
    const monitors = readJson(this.files.monitors, null);
    this.firstRun = monitors === null;
    this.monitors = monitors || [];
    this.settings = Object.assign({ title: 'Uptime Monitor', webhooks: [], publicShowTargets: false, publicDashboard: true }, defaults.settings, readJson(this.files.settings, {}));
    this.history = readJson(this.files.history, {});
    this.self = readJson(this.files.self, null);
    this.historyDirty = false;
  }

  saveMonitors() { writeJsonAtomic(this.files.monitors, this.monitors); }
  saveSettings() { writeJsonAtomic(this.files.settings, this.settings); }
  saveSelf() { writeJsonAtomic(this.files.self, this.self); }
  saveHistory(force = false) {
    if (!this.historyDirty && !force) return;
    writeJsonAtomic(this.files.history, this.history);
    this.historyDirty = false;
  }

  // ---------- monitor history ----------
  hist(id) {
    if (!this.history[id]) this.history[id] = { raw: [], hourly: [], events: [], status: 'pending', downSince: null };
    return this.history[id];
  }

  deleteHistory(id) { delete this.history[id]; this.historyDirty = true; }

  record(id, check) {
    const h = this.hist(id);
    h.raw.push(check);
    const rawCutoff = check.t - RAW_RETENTION;
    while (h.raw.length && h.raw[0].t < rawCutoff) h.raw.shift();

    const hourStart = Math.floor(check.t / HOUR) * HOUR;
    let bucket = h.hourly[h.hourly.length - 1];
    if (!bucket || bucket.h !== hourStart) {
      bucket = { h: hourStart, n: 0, up: 0, ms: 0, msn: 0 };
      h.hourly.push(bucket);
      const hourlyCutoff = check.t - HOURLY_RETENTION;
      while (h.hourly.length && h.hourly[0].h < hourlyCutoff) h.hourly.shift();
    }
    bucket.n++;
    if (check.ok) bucket.up++;
    if (check.ok && typeof check.ms === 'number') { bucket.ms += check.ms; bucket.msn++; }
    this.historyDirty = true;
  }

  addEvent(id, event) {
    const h = this.hist(id);
    h.events.push(event);
    if (h.events.length > MAX_EVENTS) h.events.splice(0, h.events.length - MAX_EVENTS);
    this.historyDirty = true;
  }

  // Uptime percentage over the last `windowMs`, or null when there is no data.
  uptime(id, windowMs, now = Date.now()) {
    const h = this.history[id];
    if (!h) return null;
    let n = 0, up = 0;
    if (windowMs <= RAW_RETENTION) {
      const cutoff = now - windowMs;
      for (const c of h.raw) if (c.t >= cutoff) { n++; if (c.ok) up++; }
    } else {
      const cutoff = now - windowMs;
      for (const b of h.hourly) if (b.h + HOUR > cutoff) { n += b.n; up += b.up; }
    }
    return n ? (up / n) * 100 : null;
  }

  // `days` rolling 24h buckets ending now (oldest first): { t, n, up, pct }
  daily(id, days = 90, now = Date.now()) {
    const out = [];
    const start = now - days * DAY;
    for (let i = 0; i < days; i++) out.push({ t: start + i * DAY, n: 0, up: 0 });
    const h = this.history[id];
    if (h) {
      for (const b of h.hourly) {
        // Place each hourly bucket by its midpoint, but never past "now" (the current hour is partial).
        const idx = Math.floor((Math.min(b.h + HOUR / 2, now - 1) - start) / DAY);
        if (idx >= 0 && idx < days) { out[idx].n += b.n; out[idx].up += b.up; }
      }
    }
    return out.map(d => ({ ...d, pct: d.n ? (d.up / d.n) * 100 : null }));
  }

  // ---------- self uptime ----------
  // Downtime of this server within [now - windowMs, now], using recorded downtime periods.
  selfUptime(windowMs, now = Date.now()) {
    const s = this.self;
    if (!s) return null;
    const winStart = Math.max(now - windowMs, s.firstStart);
    const covered = now - winStart;
    if (covered <= 0) return 100;
    let down = 0;
    for (const d of s.downtimes) {
      const a = Math.max(d.start, winStart), b = Math.min(d.end, now);
      if (b > a) down += b - a;
    }
    return Math.max(0, ((covered - down) / covered) * 100);
  }

  selfDaily(days = 90, now = Date.now()) {
    const s = this.self;
    const start = now - days * DAY;
    const out = [];
    for (let i = 0; i < days; i++) {
      const a0 = start + i * DAY, b0 = a0 + DAY;
      const a = Math.max(a0, s ? s.firstStart : Infinity);
      if (!s || a >= b0) { out.push({ t: a0, pct: null }); continue; }
      let down = 0;
      for (const d of s.downtimes) {
        const x = Math.max(d.start, a), y = Math.min(d.end, b0, now);
        if (y > x) down += y - x;
      }
      const covered = Math.min(b0, now) - a;
      out.push({ t: a0, pct: covered > 0 ? Math.max(0, ((covered - down) / covered) * 100) : null });
    }
    return out;
  }
}

module.exports = { Store, HOUR, DAY, HOURLY_RETENTION };
