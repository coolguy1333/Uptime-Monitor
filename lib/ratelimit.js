'use strict';
// Fixed-window counter per key (usually a client IP). hit() records one event, blocked() says
// whether the key has used up its budget for the current window. Callers decide what counts:
// e.g. only *failed* password guesses, so a correct login is never throttled.
class RateLimiter {
  constructor(limit, windowMs = 60e3) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map(); // key -> { count, reset }
    setInterval(() => this.sweep(), windowMs * 5).unref();
  }

  blocked(key) {
    const e = this.entries.get(key);
    return Boolean(e && e.reset > Date.now() && e.count >= this.limit);
  }

  hit(key) {
    const now = Date.now();
    const e = this.entries.get(key);
    if (!e || e.reset <= now) this.entries.set(key, { count: 1, reset: now + this.windowMs });
    else e.count++;
  }

  clear(key) { this.entries.delete(key); }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.reset <= now) this.entries.delete(k);
  }
}

module.exports = { RateLimiter };
