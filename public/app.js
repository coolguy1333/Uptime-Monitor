'use strict';
/* Uptime Monitor dashboard - vanilla JS, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const REFRESH_MS = 10000;
const DAY = 86400e3;

const state = {
  data: null,
  open: new Set(),
  details: new Map(),
  editingId: null,
};

// ------------------------------------------------------------------ utils
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function ago(t) {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 5) return 'just now';
  return `${duration(s).split(' ').slice(0, 2).join(' ')} ago`;
}

const fmtDate = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function pct(v) {
  if (v == null) return '<span class="muted">—</span>';
  const cls = v >= 99 ? 'pct-good' : v >= 95 ? 'pct-warn' : 'pct-bad';
  const txt = v === 100 ? '100' : v >= 99.99 ? v.toFixed(3) : v.toFixed(2);
  return `<span class="${cls}">${txt}%</span>`;
}

function ms(v) {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = ''; }, isError ? 6000 : 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    // Session expired or revoked while the page was open: refresh the UI and offer to sign in again.
    if (res.status === 401 && state.data && state.data.authed && !path.includes('login')) {
      state.data.authed = false;
      setTimeout(() => { refresh(); openLogin(); }, 0);
    }
    throw err;
  }
  return data;
}

const typeLabel = { http: 'HTTP', ping: 'PING', tcp: 'TCP' };
function targetText(m) {
  if (!m.target) return '';
  if (m.type !== 'tcp') return m.target;
  return m.target.includes(':') ? `[${m.target}]:${m.port}` : `${m.target}:${m.port}`;
}

// ------------------------------------------------------------------ rendering
function daysBars(days, { label = true } = {}) {
  const bars = days.map(d => {
    let cls = '', tip;
    if (d.pct == null) tip = `${fmtDay(d.t)}: no data`;
    else {
      cls = d.pct >= 99.9 ? 'up' : d.pct >= 95 ? 'partial' : 'down';
      tip = `${fmtDay(d.t)}: ${d.pct.toFixed(2)}% uptime`;
    }
    return `<span class="${cls}" title="${esc(tip)}"></span>`;
  }).join('');
  const legend = label ? `<div class="bars-legend"><span>${days.length} days ago</span><span>Today</span></div>` : '';
  return `<div class="bars">${bars}</div>${legend}`;
}

function recentBars(checks, count = 40) {
  const pad = Math.max(0, count - checks.length);
  const items = checks.slice(-count);
  let html = '<span></span>'.repeat(pad);
  html += items.map(c => `<span class="${c.ok ? 'up' : 'down'}" title="${esc(`${fmtDate(c.t)} — ${c.ok ? ms(c.ms) : c.msg || 'failed'}`)}"></span>`).join('');
  return `<div class="bars small">${html}</div>`;
}

function renderOverall(d) {
  const el = $('#overall');
  const c = d.counts;
  const total = d.monitors.length;
  let cls = 'ok', title = 'All systems operational';
  if (c.down) { cls = 'bad'; title = `${c.down} monitor${c.down > 1 ? 's' : ''} down`; }
  else if (c.pending) { cls = 'warn'; title = 'Some checks are pending'; }
  else if (!total) { cls = ''; title = 'No monitors configured'; }
  else if (!c.up && c.paused === total) { cls = ''; title = 'All monitors are paused'; }
  el.className = `overall ${cls}`;
  $('.overall-title', el).textContent = title;
  const parts = [`${c.up || 0} up`];
  if (c.down) parts.push(`${c.down} down`);
  if (c.pending) parts.push(`${c.pending} pending`);
  if (c.paused) parts.push(`${c.paused} paused`);
  $('.overall-sub', el).textContent = `${parts.join(' · ')} — updated ${new Date().toLocaleTimeString()}`;
  document.title = c.down ? `(${c.down} down) ${d.title}` : d.title;
}

function renderSelf(d) {
  const s = d.self;
  const el = $('#self');
  el.hidden = false;
  const events = s.events.map(e => `<li><time>${esc(fmtDate(e.t))}</time><span class="tag ${e.status}">${esc(e.status)}</span><span>${esc(e.msg)}</span></li>`).join('');
  const host = s.host ? `
    <div class="meta">
      <span>Host <b>${esc(s.host.hostname)}</b></span>
      <span>${esc(s.host.platform)}</span>
      <span>Node <b>${esc(s.host.node)}</b></span>
      <span>Host uptime <b>${duration(s.host.osUptime)}</b></span>
      ${s.host.loadavg ? `<span>Load <b>${s.host.loadavg.join(' / ')}</b></span>` : ''}
      <span>Memory <b>${bytes(s.host.memoryRss)}</b> (system ${bytes(s.host.systemMemory.total - s.host.systemMemory.free)} / ${bytes(s.host.systemMemory.total)})</span>
    </div>` : '';
  el.innerHTML = `
    <div class="self-top">
      <div>
        <div class="self-label">This server</div>
        <div class="self-uptime"><span class="dot up" style="display:inline-block;margin-right:10px;vertical-align:2px"></span>Online for <span id="selfUptime">${duration(s.processUptime)}</span></div>
        <div class="self-since">Started ${esc(fmtDate(s.startedAt))} · monitoring since ${esc(fmtDate(s.firstStart))}</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">24 hours</div><div class="v">${pct(s.uptime['24h'])}</div></div>
        <div class="stat"><div class="k">7 days</div><div class="v">${pct(s.uptime['7d'])}</div></div>
        <div class="stat"><div class="k">30 days</div><div class="v">${pct(s.uptime['30d'])}</div></div>
        <div class="stat"><div class="k">90 days</div><div class="v">${pct(s.uptime['90d'])}</div></div>
      </div>
    </div>
    <div>${daysBars(s.daily)}</div>
    <div class="meta">
      <span>Restarts <b>${s.restarts}</b></span>
      <span>Outages (30d) <b>${s.downtimeCount30d}</b></span>
      <span>Last outage <b>${s.lastDowntime ? `${esc(fmtDate(s.lastDowntime.start))} (${duration((s.lastDowntime.end - s.lastDowntime.start) / 1000)})` : 'none'}</b></span>
    </div>
    ${host}
    ${events ? `<details><summary>Server events</summary><ul class="events">${events}</ul></details>` : ''}`;
  state.selfBase = { uptime: s.processUptime, at: Date.now() };
}

function renderPeers(d) {
  const el = $('#peers');
  const peers = d.peers || [];
  el.hidden = peers.length === 0;
  if (!peers.length) return;
  $('#peerList').innerHTML = peers.map(peerCard).join('');
}

function peerCard(p) {
  const s = p.self;
  const uptime = s ? s.uptime : p.observedUptime;
  const label = p.name || p.url;
  const status = p.reachable
    ? (s ? `Online for ${duration(s.processUptime)}` : 'Reachable')
    : `Unreachable${p.checkedAt ? ` — last seen ${ago(p.checkedAt)}` : ''}${p.error ? ` (${p.error})` : ''}`;
  return `
  <article class="card peer">
    <div class="peer-top">
      <div class="peer-id">
        <span class="dot ${p.reachable ? 'up' : 'down'}" title="${esc(p.reachable ? 'reachable' : 'unreachable')}"></span>
        <div>
          <div class="peer-name">${esc(label)}</div>
          <div class="peer-status muted">${esc(status)}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">24h</div><div class="v">${pct(uptime['24h'])}</div></div>
        <div class="stat"><div class="k">7d</div><div class="v">${pct(uptime['7d'])}</div></div>
        <div class="stat"><div class="k">30d</div><div class="v">${pct(uptime['30d'])}</div></div>
        <div class="stat"><div class="k">90d</div><div class="v">${pct(uptime['90d'])}</div></div>
      </div>
    </div>
    ${s ? `<div>${daysBars(s.daily, { label: false })}</div>` : '<p class="muted">No status reported by this peer yet.</p>'}
  </article>`;
}

function monitorRow(m) {
  const open = state.open.has(m.id);
  const sub = m.target ? `<span class="badge">${typeLabel[m.type]}</span>${esc(targetText(m))}` : `<span class="badge">${typeLabel[m.type]}</span>${esc(statusText(m))}`;
  return `
  <article class="card monitor${open ? ' open' : ''}" data-id="${m.id}">
    <div class="monitor-row" data-action="toggle" role="button" tabindex="0" aria-expanded="${open}">
      <span class="dot ${m.status}" title="${esc(m.status)}"></span>
      <span style="min-width:0">
        <div class="m-name">${esc(m.name)}</div>
        <div class="m-sub">${sub}</div>
      </span>
      <span class="m-bars">${recentBars(m.recent)}</span>
      <span class="m-num m-ping"><div class="v">${m.last && m.last.ok ? ms(m.last.ms) : '—'}</div><div class="k">response</div></span>
      <span class="m-num"><div class="v">${pct(m.uptime['24h'])}</div><div class="k">24h</div></span>
      <span class="chev">›</span>
    </div>
    ${open ? `<div class="detail" id="detail-${m.id}">${detailHtml(m)}</div>` : ''}
  </article>`;
}

function statusText(m) {
  if (m.status === 'paused') return 'Paused';
  if (m.status === 'down') return m.downSince ? `Down for ${duration((Date.now() - m.downSince) / 1000)}` : 'Down';
  if (m.status === 'pending') return m.last ? `Retrying — ${m.last.msg}` : 'Waiting for first check';
  return m.last ? m.last.msg : 'Up';
}

function chartSvg(points) {
  const W = 600, H = 150, padB = 18, padT = 10;
  if (!points.length) return '<p class="muted">No data yet.</p>';
  const t1 = Date.now(), t0 = t1 - DAY;
  const vals = points.filter(p => p.ms != null).map(p => p.ms);
  const max = Math.max(10, ...vals) * 1.15;
  const x = t => ((t - t0) / (t1 - t0)) * W;
  const y = v => padT + (1 - v / max) * (H - padB - padT);
  let path = '', area = '', started = false, firstX = 0, lastX = 0;
  for (const p of points) {
    if (p.ms == null) continue;
    const px = x(p.t).toFixed(1), py = y(p.ms).toFixed(1);
    if (!started) { path += `M${px},${py}`; firstX = px; started = true; } else path += `L${px},${py}`;
    lastX = px;
  }
  if (started) area = `${path}L${lastX},${H - padB}L${firstX},${H - padB}Z`;
  const lastOk = [...points].reverse().find(p => p.ms != null);
  const dot = lastOk ? `<circle class="dot-last" cx="${x(lastOk.t).toFixed(1)}" cy="${y(lastOk.ms).toFixed(1)}" r="3"></circle>` : '';
  const fails = points.filter(p => !p.ok).map(p => `<rect class="fail" x="${(x(p.t) - 1.5).toFixed(1)}" y="${H - padB - 6}" width="3" height="6"></rect>`).join('');
  const grid = [0.25, 0.5, 0.75].map(f => `<line class="grid" x1="0" x2="${W}" y1="${(padT + f * (H - padB - padT)).toFixed(1)}" y2="${(padT + f * (H - padB - padT)).toFixed(1)}"/>`).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Response time over the last 24 hours">
      ${grid}
      <line class="grid" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
      ${fails}
      ${dot}
    </svg>
    <div class="bars-legend"><span>24h ago</span><span>${vals.length ? `peak ${ms(Math.max(...vals))}` : 'no successful checks'}</span><span>now</span></div>`;
}

function detailHtml(m) {
  const d = state.details.get(m.id);
  const authed = state.data.authed;
  const cert = m.cert ? `<div class="stat"><div class="k">TLS cert expires</div><div class="v ${m.cert.daysLeft < 14 ? 'pct-bad' : m.cert.daysLeft < 30 ? 'pct-warn' : ''}">${m.cert.daysLeft} days</div></div>` : '';
  const err = m.last && !m.last.ok ? `<div class="error-line">Last check failed: ${esc(m.last.msg)}</div>` : '';
  const actions = authed ? `
    <div class="detail-actions">
      <button class="btn small" data-action="check">Check now</button>
      <button class="btn small" data-action="edit">Edit</button>
      <button class="btn small" data-action="pause">${m.paused ? 'Resume' : 'Pause'}</button>
      <span class="spacer"></span>
      <button class="btn small danger" data-action="delete">Delete</button>
    </div>` : '';
  const events = d && d.events.length
    ? `<ul class="events">${d.events.slice(0, 12).map(e => `<li><time>${esc(fmtDate(e.t))}</time><span class="tag ${e.status}">${esc(e.status)}</span><span>${esc(e.msg)}</span></li>`).join('')}</ul>`
    : '<p class="muted">No status changes yet.</p>';
  return `
    ${err}
    <div class="stats">
      <div class="stat"><div class="k">Status</div><div class="v" title="${esc(statusText(m))}">${esc(statusText(m).slice(0, 40)) || '—'}</div></div>
      <div class="stat"><div class="k">Response</div><div class="v">${m.last && m.last.ok ? ms(m.last.ms) : '—'}</div></div>
      <div class="stat"><div class="k">Avg (24h)</div><div class="v">${ms(m.avgMs24h)}</div></div>
      <div class="stat"><div class="k">Uptime 7d</div><div class="v">${pct(m.uptime['7d'])}</div></div>
      <div class="stat"><div class="k">Uptime 30d</div><div class="v">${pct(m.uptime['30d'])}</div></div>
      <div class="stat"><div class="k">Uptime 90d</div><div class="v">${pct(m.uptime['90d'])}</div></div>
      ${cert}
    </div>
    <div>
      <h3>Response time (24h) · checked every ${duration(m.interval)} · last ${ago(m.last && m.last.t)}</h3>
      <div class="chart" data-chart="${m.id}">${d ? chartSvg(d.checks24h) : '<p class="muted">Loading…</p>'}</div>
    </div>
    <div class="two-col">
      <div><h3>Last 90 days</h3>${d ? daysBars(d.daily) : ''}</div>
      <div><h3>Recent events</h3>${events}</div>
    </div>
    ${actions}`;
}

function renderMonitors(d) {
  const q = $('#search').value.trim().toLowerCase();
  const f = $('#statusFilter').value;
  const order = { down: 0, pending: 1, up: 2, paused: 3 };
  const list = d.monitors
    .filter(m => (!q || m.name.toLowerCase().includes(q) || (m.target || '').toLowerCase().includes(q)) && (!f || m.status === f))
    .sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  $('#monitors').innerHTML = list.map(monitorRow).join('');
  $('#empty').hidden = d.monitors.length > 0;
  $$('.chart').forEach(attachChartHover);
}

function render() {
  const d = state.data;
  if (!d) return;
  $('#siteTitle').textContent = d.title;
  $('#loginBtn').textContent = d.authed ? 'Log out' : 'Sign in';
  renderUser(d);
  $('#addBtn').hidden = !d.authed;
  $('#settingsBtn').hidden = !d.authed;
  $('#footerInfo').textContent = `Uptime Monitor v${d.version}`;
  $('#locked').hidden = !d.locked;
  $('#overall').hidden = !!d.locked;
  $('#monitorSection').hidden = !!d.locked;
  if (d.locked) { $('#self').hidden = true; $('#peers').hidden = true; document.title = d.title; return; }
  renderOverall(d);
  renderSelf(d);
  renderPeers(d);
  renderMonitors(d);
  $('#empty [data-action="add"]').hidden = !d.authed;
}

function renderUser(d) {
  const chip = $('#userChip');
  const u = d.user;
  if (!d.authed || !u || u.method === 'token') { chip.hidden = true; chip.innerHTML = ''; return; }
  const label = u.email || u.name || 'Admin';
  const avatar = u.picture
    ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar">${esc(label.charAt(0).toUpperCase())}</span>`;
  chip.innerHTML = `${avatar}<span class="who">${esc(label)}</span>`;
  chip.title = `Signed in as ${label}`;
  chip.hidden = false;
}

function openLogin() {
  const m = (state.data && state.data.auth) || { google: false, password: true };
  $('#googleLogin').hidden = !m.google;
  $('#loginGoogleHint').hidden = !m.google;
  $('#loginForm').hidden = !m.password;
  $('#loginDivider').hidden = !(m.google && m.password);
  $('#loginNone').hidden = m.google || m.password;
  $('#loginGoogleOnlyActions').hidden = m.password;
  openDialog('#loginDialog');
  if (m.password) $('#loginForm').password.focus();
}

const LOGIN_ERRORS = {
  not_allowed: 'That Google account is not allowed to sign in. Ask the admin to add it to ADMIN_EMAILS.',
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'Sign-in expired or was started in another tab. Please try again.',
  token_exchange_failed: 'Google sign-in failed (could not verify with Google). Check GOOGLE_CLIENT_SECRET and the redirect URI.',
  bad_id_token: 'Google sign-in failed (invalid response).',
  email_not_verified: 'Your Google email address is not verified.',
  google_disabled: 'Google sign-in is not configured on this server.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  google_error: 'Google reported an error during sign-in.',
};

function showLoginErrorFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  if (!code) return;
  toast(LOGIN_ERRORS[code] || `Sign-in failed (${code})`, true);
  params.delete('login_error');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
}

// ------------------------------------------------------------------ chart hover
function attachChartHover(el) {
  const id = el.dataset.chart;
  const d = state.details.get(id);
  const svg = $('svg', el);
  if (!d || !svg) return;
  const pts = d.checks24h;
  el.onmousemove = e => {
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const t = Date.now() - DAY + frac * DAY;
    let best = null;
    for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (!best) return;
    let tip = $('.chart-tip', el), cur = $('.chart-cursor', el);
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; el.append(tip); }
    if (!cur) { cur = document.createElement('div'); cur.className = 'chart-cursor'; el.append(cur); }
    const left = ((best.t - (Date.now() - DAY)) / DAY) * rect.width;
    tip.style.left = cur.style.left = `${left}px`;
    tip.textContent = `${fmtTime(best.t)} · ${best.ok ? ms(best.ms) : 'failed'}`;
  };
  el.onmouseleave = () => { $('.chart-tip', el)?.remove(); $('.chart-cursor', el)?.remove(); };
}

// ------------------------------------------------------------------ data loading
async function refresh() {
  try {
    state.data = await api('api/status');
    await Promise.all([...state.open].map(loadDetail));
    render();
  } catch (err) {
    const el = $('#overall');
    el.className = 'overall bad';
    $('.overall-title', el).textContent = 'Cannot reach the monitor server';
    $('.overall-sub', el).textContent = err.message;
  }
}

async function loadDetail(id) {
  try {
    state.details.set(id, await api(`api/monitors/${id}`));
  } catch {
    state.open.delete(id);
  }
}

// Tick the self-uptime counter every second without refetching.
setInterval(() => {
  const el = $('#selfUptime');
  if (el && state.selfBase) el.textContent = duration(state.selfBase.uptime + (Date.now() - state.selfBase.at) / 1000);
}, 1000);

// ------------------------------------------------------------------ dialogs
function openDialog(id) {
  const dlg = $(id);
  $('.form-error', dlg).textContent = '';
  dlg.showModal();
  return dlg;
}

$$('dialog').forEach(dlg => {
  dlg.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) dlg.close();
    if (e.target === dlg) dlg.close(); // click on backdrop
  });
});

function syncTypeFields() {
  const form = $('#monitorForm');
  const type = form.type.value;
  $$('[data-show]', form).forEach(el => { el.hidden = el.dataset.show !== type; });
  const label = { http: 'URL', ping: 'IP address or hostname', tcp: 'IP address or hostname' }[type];
  const ph = { http: 'https://example.com', ping: '192.168.1.1', tcp: '192.168.1.10' }[type];
  $('#targetLabel').textContent = label;
  form.target.placeholder = ph;
}
$('#monitorForm').type.addEventListener('change', syncTypeFields);

function openMonitorDialog(m) {
  const form = $('#monitorForm');
  form.reset();
  state.editingId = m ? m.id : null;
  $('#monitorDialogTitle').textContent = m ? `Edit ${m.name}` : 'Add monitor';
  const c = m ? m.config : { interval: 60, timeout: 10, retries: 1, method: 'GET', acceptedStatus: '200-399', followRedirects: true, type: 'http' };
  for (const el of form.elements) {
    if (!el.name || !(el.name in c)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(c[el.name]);
    else el.value = c[el.name] ?? '';
  }
  syncTypeFields();
  openDialog('#monitorDialog');
  form.name.focus();
}

$('#monitorForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const btn = $('[type=submit]', form);
  btn.disabled = true;
  try {
    const saved = state.editingId
      ? await api(`api/monitors/${state.editingId}`, { method: 'PUT', body })
      : await api('api/monitors', { method: 'POST', body });
    $('#monitorDialog').close();
    toast(state.editingId ? 'Monitor updated' : 'Monitor added');
    state.open.add(saved.id);
    setTimeout(refresh, 1500);
    refresh();
  } catch (err) {
    $('.form-error', form).textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('api/login', { method: 'POST', body: { password: form.password.value } });
    $('#loginDialog').close();
    form.reset();
    toast('Logged in');
    refresh();
  } catch (err) {
    $('.form-error', form).textContent = err.message;
  }
});

async function logout() {
  await api('api/logout', { method: 'POST', body: {} }).catch(() => {});
  $('#settingsDialog').close();
  toast('Logged out');
  refresh();
}

async function openSettings() {
  try {
    const s = await api('api/settings');
    const form = $('#settingsForm');
    form.title.value = s.title;
    form.webhooks.value = (s.webhooks || []).join('\n');
    form.publicDashboard.checked = s.publicDashboard;
    form.publicShowTargets.checked = s.publicShowTargets;
    $('#envWebhookHint').hidden = !s.envWebhooks;
    const a = s.auth || {};
    const who = state.data && state.data.user;
    $('#authInfo').innerHTML = [
      who ? `<div>Signed in as <b>${esc(who.email || who.name)}</b>${who.method === 'google' ? ' (Google)' : who.method === 'password' ? ' (password)' : ''}</div>` : '',
      `<div>Google sign-in: <b>${a.google ? 'on' : 'off'}</b>${a.google ? ` — admins: ${esc((a.adminEmails || []).join(', ') || 'none (set ADMIN_EMAILS)')}` : ' — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ADMIN_EMAILS to enable'}</div>`,
      `<div>Password login: <b>${a.password ? 'on' : 'off'}</b> · API token / password from ${esc(a.passwordSource || '')}</div>`,
    ].join('');
    openDialog('#settingsDialog');
  } catch (err) { toast(err.message, true); }
}

$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('api/settings', {
      method: 'PUT',
      body: { title: form.title.value, webhooks: form.webhooks.value, publicDashboard: form.publicDashboard.checked, publicShowTargets: form.publicShowTargets.checked },
    });
    $('#settingsDialog').close();
    toast('Settings saved');
    refresh();
  } catch (err) { $('.form-error', form).textContent = err.message; }
});

$('#testNotifyBtn').addEventListener('click', async () => {
  const form = $('#settingsForm');
  try {
    // Save first so the test uses what is in the box.
    await api('api/settings', { method: 'PUT', body: { webhooks: form.webhooks.value } });
    const r = await api('api/settings/test-notification', { method: 'POST', body: {} });
    const failed = r.results.filter(x => !x.ok);
    if (failed.length) $('.form-error', form).textContent = `Failed: ${failed.map(f => `${f.url} (${f.error})`).join(', ')}`;
    else toast(`Test sent to ${r.results.length} webhook(s)`);
  } catch (err) { $('.form-error', form).textContent = err.message; }
});

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const r = await api('api/import', { method: 'POST', body: { monitors: Array.isArray(json) ? json : json.monitors } });
    toast(`Imported ${r.imported} monitor(s)`);
    refresh();
  } catch (err) { $('.form-error', $('#settingsForm')).textContent = `Import failed: ${err.message}`; }
});

$('#logoutBtn').addEventListener('click', logout);

// ------------------------------------------------------------------ actions
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.monitor');
  const id = card && card.dataset.id;
  const m = id && state.data.monitors.find(x => x.id === id);
  const action = btn.dataset.action;

  if (action === 'login') return openLogin();
  if (action === 'add') return openMonitorDialog(null);
  if (!m) return;

  if (action === 'toggle') {
    if (state.open.has(id)) { state.open.delete(id); renderMonitors(state.data); return; }
    state.open.add(id);
    renderMonitors(state.data);
    await loadDetail(id);
    renderMonitors(state.data);
    return;
  }
  if (action === 'edit') return openMonitorDialog(m);
  try {
    if (action === 'check') {
      btn.disabled = true;
      btn.textContent = 'Checking…';
      const r = await api(`api/monitors/${id}/check`, { method: 'POST', body: {} });
      toast(r.last ? `${r.name}: ${r.last.ok ? 'up' : 'down'} — ${r.last.msg}` : 'Checked', r.last && !r.last.ok);
    } else if (action === 'pause') {
      await api(`api/monitors/${id}`, { method: 'PUT', body: { paused: !m.paused } });
      toast(m.paused ? 'Monitor resumed' : 'Monitor paused');
    } else if (action === 'delete') {
      if (!confirm(`Delete "${m.name}" and all of its history?`)) return;
      await api(`api/monitors/${id}`, { method: 'DELETE' });
      state.open.delete(id);
      state.details.delete(id);
      toast('Monitor deleted');
    }
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
});

document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.monitor-row')) { e.preventDefault(); e.target.click(); }
});
$('#addBtn').addEventListener('click', () => openMonitorDialog(null));
$('#settingsBtn').addEventListener('click', openSettings);
$('#loginBtn').addEventListener('click', () => (state.data && state.data.authed ? logout() : openLogin()));
$('#search').addEventListener('input', () => state.data && renderMonitors(state.data));
$('#statusFilter').addEventListener('change', () => state.data && renderMonitors(state.data));

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('um-theme')); } catch { /* storage unavailable */ }
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('um-theme', next); } catch { /* ignore */ }
});

// ------------------------------------------------------------------ boot
showLoginErrorFromUrl();
refresh();
setInterval(() => { if (!document.hidden && !$('dialog[open]')) refresh(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
