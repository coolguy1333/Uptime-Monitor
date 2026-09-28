'use strict';
// Runs every monitor on its own interval and tracks status transitions.
const { runCheck } = require('./checks');

const CERT_THRESHOLDS = [14, 7, 3, 1]; // days before expiry to send a warning

class Scheduler {
  constructor(store, notifier) {
    this.store = store;
    this.notifier = notifier;
    this.timers = new Map();
    this.fails = new Map();     // id -> consecutive failures
    this.running = new Map();   // id -> promise of the check in progress
  }

  find(id) { return this.store.monitors.find(x => x.id === id); }

  start() {
    this.store.monitors.forEach((m, i) => this.schedule(m, 500 + i * 250));
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  schedule(m, delay = m.interval * 1000) {
    this.unschedule(m.id);
    if (m.paused) return;
    const t = setTimeout(() => { this.run(m.id).catch(err => console.error('[scheduler]', err)); }, delay);
    this.timers.set(m.id, t);
  }

  unschedule(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  remove(id) {
    this.unschedule(id);
    this.fails.delete(id);
  }

  // Forget the current up/down state (used when a monitor is paused or its target changes).
  reset(id) {
    this.fails.delete(id);
    const h = this.store.hist(id);
    h.status = 'pending';
    h.downSince = null;
    delete h.cert;
    delete h.certAlerted;
    this.store.historyDirty = true;
  }

  // Runs a check now. If one is already in progress, waits for that one instead.
  run(id) {
    if (this.running.has(id)) return this.running.get(id);
    const p = this._run(id).finally(() => {
      this.running.delete(id);
      const again = this.find(id);
      if (again) this.schedule(again);
    });
    this.running.set(id, p);
    return p;
  }

  async _run(id) {
    const m = this.find(id);
    if (!m) return;
    this.unschedule(id);
    const r = await runCheck(m);
    const current = this.find(id);
    if (!current) return; // deleted while the check was running
    if (current.type !== m.type || current.target !== m.target || current.port !== m.port) return; // edited mid-check
    const check = { t: Date.now(), ok: r.ok, ms: Math.round(r.ms * 10) / 10, msg: r.msg };
    if (r.code) check.code = r.code;
    this.store.record(id, check);
    const h = this.store.hist(id);
    if (r.cert) h.cert = r.cert;
    if (!current.paused) {
      this.transition(current, r);
      this.certWarning(current, h);
    }
  }

  transition(m, r) {
    const h = this.store.hist(m.id);
    const prev = h.status;
    if (r.ok) {
      this.fails.set(m.id, 0);
      if (prev !== 'up') {
        const downFor = h.downSince ? Date.now() - h.downSince : 0;
        h.status = 'up';
        this.store.addEvent(m.id, { t: Date.now(), status: 'up', msg: r.msg });
        if (prev === 'down') this.notifier.monitorUp(m, r.msg, downFor);
        h.downSince = null;
      }
    } else {
      const fails = (this.fails.get(m.id) || 0) + 1;
      this.fails.set(m.id, fails);
      if (prev !== 'down' && (fails === 1 || !h.downSince)) h.downSince = Date.now();
      if (fails > (m.retries || 0)) {
        if (prev !== 'down') {
          h.status = 'down';
          this.store.addEvent(m.id, { t: Date.now(), status: 'down', msg: r.msg });
          this.notifier.monitorDown(m, r.msg);
        }
      } else if (prev !== 'down') {
        h.status = 'pending';
      }
    }
    this.store.historyDirty = true;
  }

  // One warning per threshold (14, 7, 3, 1 days); resets after the certificate is renewed.
  certWarning(m, h) {
    if (!h.cert || typeof h.cert.daysLeft !== 'number') return;
    const days = h.cert.daysLeft;
    if (days > CERT_THRESHOLDS[0]) { delete h.certAlerted; return; }
    const threshold = CERT_THRESHOLDS.filter(t => days <= t).pop();
    if (threshold === undefined || (h.certAlerted !== undefined && h.certAlerted <= threshold)) return;
    h.certAlerted = threshold;
    this.store.historyDirty = true;
    this.notifier.certExpiring(m, h.cert);
  }
}

module.exports = { Scheduler };
