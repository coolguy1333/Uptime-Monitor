'use strict';
// Two-way monitor sync between federated servers (see lib/peers.js). Each server keeps running
// its own checks and keeps its own history; only the monitor *definitions* are shared.
//   - every monitor has an `updatedAt`; the newest edit wins (so keep server clocks in sync)
//   - deletions are remembered as tombstones so a deleted monitor is not re-added by a peer
//   - two monitors with the same type/target/port but different ids are treated as the same one:
//     both servers deterministically keep the smaller id, so they converge
const ID_RE = /^[a-f0-9]{6,32}$/;
const MAX_MONITORS = 500;
const MAX_TOMBSTONES = 2000;

const keyOf = m => `${m.type}|${String(m.target).toLowerCase()}|${m.port ?? ''}`;
const stamp = m => Number(m.updatedAt) || Number(m.createdAt) || 0;

// ctx: { store, scheduler, validate(rawMonitor) -> { monitor, errors } }
function mergeMonitors(ctx, remote, remoteDeleted) {
  const { store, scheduler, validate } = ctx;
  const tomb = store.tombstones;
  let monitorsChanged = false;
  let tombChanged = false;

  const removeAt = idx => {
    const [m] = store.monitors.splice(idx, 1);
    scheduler.remove(m.id);
    store.deleteHistory(m.id);
    monitorsChanged = true;
  };

  if (remoteDeleted && typeof remoteDeleted === 'object') {
    for (const [id, at] of Object.entries(remoteDeleted).slice(0, MAX_TOMBSTONES)) {
      if (!ID_RE.test(id) || !Number.isFinite(at)) continue;
      if ((tomb[id] || 0) < at) { tomb[id] = at; tombChanged = true; }
      const idx = store.monitors.findIndex(m => m.id === id);
      if (idx !== -1 && stamp(store.monitors[idx]) < at) removeAt(idx);
    }
  }

  for (const r of (Array.isArray(remote) ? remote : []).slice(0, MAX_MONITORS)) {
    if (!r || typeof r !== 'object' || !ID_RE.test(String(r.id))) continue;
    const at = Number(r.updatedAt) || Number(r.createdAt) || 0;
    if (tomb[r.id]) {
      if (tomb[r.id] >= at) continue;            // deleted after its last edit
      delete tomb[r.id]; tombChanged = true;     // edited after being deleted: bring it back
    }
    const { monitor: v, errors } = validate(r);
    if (errors.length) continue;

    let local = store.monitors.find(m => m.id === r.id);
    if (!local) {
      const dup = store.monitors.find(m => keyOf(m) === keyOf(v));
      if (dup) {
        if (dup.id < r.id) continue;             // the peer will adopt our id
        adoptId(ctx, dup, r.id);
        monitorsChanged = true;
        local = dup;
      }
    }
    if (!local) {
      v.id = r.id;
      v.createdAt = Number(r.createdAt) || Date.now();
      v.updatedAt = at;
      store.monitors.push(v);
      scheduler.schedule(v, 500 + Math.floor(Math.random() * 2000));
      monitorsChanged = true;
      continue;
    }
    if (at > stamp(local)) {
      const idx = store.monitors.indexOf(local);
      const next = { ...v, id: local.id, createdAt: local.createdAt, updatedAt: at };
      const targetChanged = next.type !== local.type || next.target !== local.target || next.port !== local.port;
      store.monitors[idx] = next;
      if (targetChanged || (next.paused && !local.paused)) scheduler.reset(next.id);
      scheduler.schedule(next, 200);
      monitorsChanged = true;
    }
  }

  if (monitorsChanged) store.saveMonitors();
  if (tombChanged) store.saveTombstones();
  return monitorsChanged || tombChanged;
}

// Give a monitor a new id, carrying its history over.
function adoptId({ store, scheduler }, m, newId) {
  const old = m.id;
  scheduler.remove(old);
  if (store.history[old]) {
    store.history[newId] = store.history[old];
    delete store.history[old];
    store.historyDirty = true;
  }
  m.id = newId;
  scheduler.schedule(m, 500);
}

module.exports = { mergeMonitors };
