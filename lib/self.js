'use strict';
// Tracks this server's own uptime. A heartbeat is written to disk every few seconds;
// on startup (or if the process was frozen/suspended) any gap since the last heartbeat
// is recorded as downtime.
const { DAY } = require('./store');

const MAX_EVENTS = 100;

class SelfTracker {
  constructor(store, notifier, { heartbeatMs = 15000, graceMs = 45000 } = {}) {
    this.store = store;
    this.notifier = notifier;
    this.heartbeatMs = heartbeatMs;
    this.graceMs = graceMs;
  }

  event(e) {
    const s = this.store.self;
    s.events.push(e);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  }

  start() {
    const now = Date.now();
    let s = this.store.self;
    if (!s) {
      s = this.store.self = { firstStart: now, lastHeartbeat: now, downtimes: [], restarts: 0, events: [] };
      this.event({ t: now, status: 'up', msg: 'First start' });
    } else {
      s.events = Array.isArray(s.events) ? s.events : [];
      s.downtimes = Array.isArray(s.downtimes) ? s.downtimes : [];
      if (!s.firstStart) s.firstStart = now;
      if (!s.lastHeartbeat) s.lastHeartbeat = now;
      s.restarts = (s.restarts || 0) + 1;
      const gap = now - s.lastHeartbeat;
      if (gap > this.graceMs) {
        const reason = s.cleanShutdown ? 'Stopped' : 'Crashed, killed, or host went offline';
        s.downtimes.push({ start: s.lastHeartbeat, end: now, reason });
        this.event({ t: s.lastHeartbeat, status: 'down', msg: reason });
        this.event({ t: now, status: 'up', msg: 'Started again' });
        setTimeout(() => this.notifier.selfRecovered(gap), 2000).unref();
      } else {
        this.event({ t: now, status: 'restart', msg: 'Quick restart (under grace period, not counted as downtime)' });
      }
    }
    s.cleanShutdown = false;
    s.startedAt = now;
    s.lastHeartbeat = now;
    this.store.saveSelf();
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
    this.timer.unref();
  }

  beat() {
    const s = this.store.self;
    const now = Date.now();
    // The process itself was frozen (host suspended, VM paused, event loop blocked).
    if (now - s.lastHeartbeat > this.graceMs) {
      s.downtimes.push({ start: s.lastHeartbeat, end: now, reason: 'Server was frozen or suspended' });
      this.event({ t: s.lastHeartbeat, status: 'down', msg: 'Server was frozen or suspended' });
      this.event({ t: now, status: 'up', msg: 'Resumed' });
    }
    s.lastHeartbeat = now;
    const cutoff = now - 90 * DAY;
    s.downtimes = s.downtimes.filter(d => d.end > cutoff);
    this.store.saveSelf();
  }

  shutdown() {
    clearInterval(this.timer);
    const s = this.store.self;
    if (!s) return;
    s.lastHeartbeat = Date.now();
    s.cleanShutdown = true;
    this.store.saveSelf();
  }
}

module.exports = { SelfTracker };
