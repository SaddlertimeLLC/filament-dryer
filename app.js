'use strict';

// Rule-of-thumb drying settings. Target % = moisture (by mass of dry filament) considered "dry enough".
const MATERIALS = {
  PLA:   { temp: 45, target: 0.05, hint: 'PLA: 40–50 °C. Softens around 55 °C, so keep the spool well below that.' },
  PETG:  { temp: 65, target: 0.05, hint: 'PETG: 60–65 °C.' },
  ABS:   { temp: 80, target: 0.10, hint: 'ABS: 70–80 °C.' },
  ASA:   { temp: 80, target: 0.10, hint: 'ASA: 70–80 °C.' },
  TPU:   { temp: 50, target: 0.10, hint: 'TPU/TPE: 45–55 °C. Very hygroscopic.' },
  Nylon: { temp: 75, target: 0.20, hint: 'Nylon/PA: 70–80 °C. Can hold several % water, so expect long dry times.' },
  PC:    { temp: 80, target: 0.05, hint: 'PC: 75–90 °C. Check that your spool plastic can handle that temperature.' },
  PVA:   { temp: 50, target: 0.20, hint: 'PVA/BVOH: 45–55 °C. Extremely hygroscopic.' },
  Other: { temp: 50, target: 0.10, hint: 'Check the manufacturer\'s drying recommendation.' },
};

const STORE_KEY = 'fdl.sessions.v1';
const $ = id => document.getElementById(id);
let sessions = load();
let current = null;
let tickTimer = null;
let wakeLockObj = null;

function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } }
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(sessions)); }
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };

// ---------- time helpers ----------
function ovenMs(s, now = Date.now()) { return s.ovenMs + (s.runStart ? now - s.runStart : 0); }
function fmtClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function fmtHours(h) {
  if (h == null || !isFinite(h)) return '–';
  const m = Math.round(h * 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
const fmtG = (g, d = 1) => g == null || !isFinite(g) ? '–' : `${g.toFixed(d)} g`;
const fmtPct = p => p == null || !isFinite(p) ? '–' : `${p.toFixed(p < 1 ? 3 : 2)}%`;

// ---------- routing ----------
function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  current = m ? sessions.find(s => s.id === m[1]) : null;
  clearInterval(tickTimer);
  if (current) {
    $('homeView').classList.add('hidden'); $('sessionView').classList.remove('hidden');
    $('backBtn').classList.remove('hidden'); $('title').textContent = current.name;
    renderSession();
    tickTimer = setInterval(tick, 1000);
  } else {
    $('sessionView').classList.add('hidden'); $('homeView').classList.remove('hidden');
    $('backBtn').classList.add('hidden'); $('title').textContent = 'Filament Dryer';
    renderHome();
  }
  window.scrollTo(0, 0);
}

// ---------- home ----------
function initForm() {
  const sel = $('nMaterial');
  sel.innerHTML = Object.keys(MATERIALS).map(k => `<option>${k}</option>`).join('');
  const last = sessions[0];
  if (last) { sel.value = last.material; $('nTare').value = last.tare || ''; $('nInterval').value = last.intervalMin; $('nRes').value = last.scaleRes; }
  applyMaterial();
  sel.addEventListener('change', applyMaterial);
}
function applyMaterial() {
  const m = MATERIALS[$('nMaterial').value];
  $('nTemp').value = m.temp; $('nTarget').value = m.target; $('matHint').textContent = m.hint;
}

function renderHome() {
  const ul = $('historyList');
  if (!sessions.length) { ul.innerHTML = '<li class="sub">No sessions yet.</li>'; return; }
  ul.innerHTML = sessions.map(s => {
    const e = s.entries, a = analyzeSession(s);
    const st = s.status === 'done' ? 'done' : s.status === 'out' ? 'out of oven' : 'drying';
    return `<li data-id="${s.id}"><div><div>${esc(s.name)}</div><div class="sub">${s.material} · ${new Date(s.createdAt).toLocaleString()} · ${st}</div></div>
      <div class="sub" style="text-align:right">${fmtHours(ovenMs(s) / 3.6e6)}<br>${e.length > 1 ? '−' + fmtG(e[0].w - e[e.length - 1].w) : ''}${a.moistureNowPct != null ? ' · ' + fmtPct(a.moistureNowPct) : ''}</div></li>`;
  }).join('');
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startSession() {
  const w0 = num($('nStart').value);
  if (w0 == null || w0 <= 0) { $('nStart').focus(); alert('Enter the starting weight of the spool.'); return; }
  const material = $('nMaterial').value;
  const s = {
    id: Date.now().toString(36),
    name: $('nName').value.trim() || `${material} ${new Date().toLocaleDateString()}`,
    material,
    tempC: num($('nTemp').value),
    targetPct: num($('nTarget').value) ?? MATERIALS[material].target,
    tare: num($('nTare').value) ?? 0,
    intervalMin: num($('nInterval').value) || 30,
    scaleRes: num($('nRes').value) || 1,
    createdAt: Date.now(),
    status: 'drying',
    ovenMs: 0,
    runStart: Date.now(),
    notified: false,
    entries: [{ t: 0, w: w0, at: Date.now() }],
  };
  sessions.unshift(s); save();
  $('nName').value = ''; $('nStart').value = '';
  requestNotify();
  location.hash = `#/s/${s.id}`;
}

// ---------- session ----------
function analyzeSession(s) {
  return DryFit.analyze(s.entries.map(e => ({ t: e.t, w: e.w })), {
    tare: s.tare, targetPct: s.targetPct, scaleRes: s.scaleRes, intervalMin: s.intervalMin,
  });
}

function renderSession() {
  const s = current;
  const btns = $('actionBtns');
  if (s.status === 'drying') {
    btns.innerHTML = `<button class="primary big" id="outBtn">Took it out &ndash; weigh</button>`;
    $('outBtn').onclick = takeOut;
  } else if (s.status === 'out') {
    btns.innerHTML = `<button class="ok big" id="inBtn">Back in oven &ndash; resume</button>
      <button id="weighBtn">Enter / redo weight</button><button id="finishBtn">Finish drying</button>`;
    $('inBtn').onclick = putBack; $('weighBtn').onclick = () => askWeight(); $('finishBtn').onclick = finish;
  } else {
    btns.innerHTML = `<button id="reopenBtn">Resume this session</button>`;
    $('reopenBtn').onclick = () => { s.status = 'out'; save(); renderSession(); };
  }
  const a = analyzeSession(s);
  renderVerdict(s, a); renderStats(s, a); renderLog(s, a); renderChart(s, a);
  tick();
}

function tick() {
  const s = current; if (!s) return;
  const now = Date.now();
  $('ovenTime').textContent = fmtClock(ovenMs(s, now));
  const lbl = $('statusLabel');
  lbl.className = 'status ' + s.status;
  if (s.status === 'drying') {
    lbl.textContent = `In oven${s.tempC ? ` · ${s.tempC} °C` : ''}`;
    const due = s.runStart + s.intervalMin * 60000 - now;
    $('subTimer').textContent = due > 0 ? `Next weigh in ${fmtClock(due).replace(/^0:/, '')}` : `Weigh now! (${fmtClock(-due).replace(/^0:/, '')} overdue)`;
    if (due <= 0 && !s.notified) { s.notified = true; save(); remind(s); }
  } else if (s.status === 'out') {
    lbl.textContent = 'Out of oven · timer paused';
    $('subTimer').textContent = 'Out-of-oven time is not counted';
  } else {
    lbl.textContent = 'Finished';
    $('subTimer').textContent = `${s.entries.length} weigh-ins`;
  }
}

function takeOut() {
  const s = current, now = Date.now();
  s.ovenMs += now - s.runStart; s.runStart = null; s.status = 'out'; save();
  closeNotifications();
  renderSession();
  askWeight(true);
}
function putBack() {
  const s = current;
  const lastT = s.entries[s.entries.length - 1].t;
  if (s.ovenMs / 3.6e6 > lastT + 1e-6 && !confirm('No weight was logged for this removal. Resume anyway?')) return;
  s.runStart = Date.now(); s.status = 'drying'; s.notified = false; save();
  renderSession();
}
function finish() { current.status = 'done'; save(); renderSession(); }

function askWeight(fresh) {
  const s = current, t = s.ovenMs / 3.6e6;
  const last = s.entries[s.entries.length - 1];
  const redo = Math.abs(last.t - t) < 1e-6 && s.entries.length > 1;
  const prev = redo ? s.entries[s.entries.length - 2] : last;
  $('weightDlgInfo').textContent = `Oven time ${fmtHours(t)} · previous ${fmtG(prev.w)}${redo ? ' · replaces the last entry' : ''}`;
  $('weightInput').value = redo ? last.w : '';
  const dlg = $('weightDlg');
  dlg.returnValue = '';
  dlg.showModal();
  setTimeout(() => $('weightInput').focus(), 50);
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const w = num($('weightInput').value);
    if (w == null || w <= 0) return;
    if (redo) s.entries[s.entries.length - 1] = { t, w, at: Date.now() };
    else if (Math.abs(last.t - t) < 1e-6) { alert('No oven time has passed since the last weigh-in.'); return; }
    else s.entries.push({ t, w, at: Date.now() });
    save(); renderSession();
  };
}

function renderVerdict(s, a) {
  const v = $('verdict');
  const n = s.entries.length;
  let cls = '', txt;
  if (n < 3) {
    txt = `Collecting data. ${3 - n} more weigh-in${3 - n > 1 ? 's' : ''} needed before projecting.`;
  } else if (!a.fit) {
    txt = 'Can\'t fit a drying curve. The weights aren\'t going down consistently. Check the scale, or log a few more points.';
  } else if (a.badTare) {
    txt = 'The empty-spool weight looks too high for these readings. Fix it below.';
  } else if (a.reachedTarget) {
    cls = 'good'; txt = `✅ Dry enough. Projected moisture ${fmtPct(a.moistureFitNowPct)} is at or below your target of ${s.targetPct}%.`;
  } else if (a.belowScale) {
    cls = 'good'; txt = `✅ Diminishing returns. Only about ${fmtG(a.nextIntervalLoss, 2)} would come off in the next ${s.intervalMin} min, less than your scale can detect (±${s.scaleRes} g). More drying isn't worth it.`;
  } else {
    cls = 'mid';
    const stopH = Math.min(a.hoursToTarget, a.hoursToMeasurable);
    txt = `${a.fit.unreliable ? '~' : ''}${fmtHours(stopH)} more in the oven ${a.hoursToTarget <= a.hoursToMeasurable ? `to reach ${s.targetPct}%` : 'until each weigh-in would show less change than your scale can detect'}.`;
    if (a.fit.unreliable) txt += ' (Rough: the curve hasn\'t started flattening yet, so keep logging.)';
  }
  v.className = 'verdict ' + cls; v.textContent = txt;
}

function renderStats(s, a) {
  const items = [
    ['Total lost', fmtG(a.totalLoss)],
    ['Last rate', a.lastRate != null ? `${a.lastRate.toFixed(2)} g/h` : '–'],
    ['Moisture now (est.)', fmtPct(a.moistureNowPct)],
    ['Starting moisture (est.)', fmtPct(a.moistureStartPct)],
    ['Projected dry weight', fmtG(a.dryWeight)],
    ['Water left to remove', fmtG(a.remainingWater, 2)],
    ['Removed so far', a.removedPct != null ? `${a.removedPct.toFixed(0)}%` : '–'],
    [`Loss next ${s.intervalMin} min`, fmtG(a.nextIntervalLoss, 2)],
  ];
  $('stats').innerHTML = items.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') +
    `<div class="stat" style="grid-column:1/-1"><div class="k">Settings (tap to edit)</div><div class="v" style="font-size:.9rem" id="editSettings">
      ${s.material} · target ${s.targetPct}% · empty spool ${s.tare || '?'} g · every ${s.intervalMin} min · scale ±${s.scaleRes} g</div></div>`;
  $('editSettings').parentElement.onclick = () => editSettings(s);
}

function editSettings(s) {
  const t = prompt('Target moisture %', s.targetPct); if (t === null) return;
  const tare = prompt('Empty spool weight (g), 0 if unknown', s.tare); if (tare === null) return;
  const iv = prompt('Weigh every (minutes)', s.intervalMin); if (iv === null) return;
  const res = prompt('Scale resolution (g)', s.scaleRes); if (res === null) return;
  s.targetPct = num(t) ?? s.targetPct; s.tare = num(tare) ?? s.tare;
  s.intervalMin = num(iv) || s.intervalMin; s.scaleRes = num(res) || s.scaleRes;
  save(); renderSession();
}

function renderLog(s, a) {
  const w0 = s.entries[0].w;
  const filDry = a.dryWeight != null ? a.dryWeight - s.tare : null;
  $('logBody').innerHTML = s.entries.map((e, i) => `<tr><td>${fmtHours(e.t)}</td><td>${e.w.toFixed(1)}</td><td>${i ? (w0 - e.w).toFixed(1) : ''}</td>
    <td>${filDry > 0 ? fmtPct(Math.max(0, (e.w - a.dryWeight) / filDry * 100)) : '–'}</td>
    <td>${i ? `<button data-del="${i}" aria-label="Delete">✕</button>` : ''}</td></tr>`).join('');
  $('logBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm('Delete this weigh-in?')) return;
    s.entries.splice(+b.dataset.del, 1); save(); renderSession();
  });
}

function renderChart(s, a) {
  const W = 600, H = 300, L = 52, R = 12, T = 12, B = 30;
  const pts = s.entries;
  const tNow = Math.max(ovenMs(s) / 3.6e6, pts[pts.length - 1].t);
  let tMax = Math.max(tNow, 0.5);
  if (a.fit) {
    const stop = Math.min(a.tTarget || Infinity, a.tMeasurable || Infinity);
    tMax = Math.max(tMax, Math.min(isFinite(stop) ? stop * 1.15 : tMax, tNow * 3 + 1));
  }
  const ws = pts.map(p => p.w);
  if (a.targetWeight) ws.push(a.targetWeight);
  if (a.dryWeight) ws.push(a.dryWeight);
  let yMin = Math.min(...ws), yMax = Math.max(...ws);
  const pad = Math.max((yMax - yMin) * 0.1, 0.5);
  yMin -= pad; yMax += pad;
  const X = t => L + (t / tMax) * (W - L - R);
  const Y = w => T + (1 - (w - yMin) / (yMax - yMin)) * (H - T - B);
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (const v of niceTicks(yMin, yMax, 5)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#30363d"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
  for (const v of niceTicks(0, tMax, 6)) svg += `<line x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${H - B}" stroke="#21262d"/><text x="${X(v)}" y="${H - B + 16}" text-anchor="middle">${+v.toFixed(2)}h</text>`;
  if (a.dryWeight) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(a.dryWeight)}" y2="${Y(a.dryWeight)}" stroke="var(--dry)" stroke-dasharray="2 4" stroke-width="2"/>`;
  if (a.targetWeight) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(a.targetWeight)}" y2="${Y(a.targetWeight)}" stroke="var(--target)" stroke-dasharray="6 4" stroke-width="2"/>`;
  if (a.fit) {
    let d = '';
    for (let i = 0; i <= 120; i++) { const t = tMax * i / 120; d += `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(DryFit.predict(a.fit, t)).toFixed(1)}`; }
    svg += `<path d="${d}" fill="none" stroke="var(--fit)" stroke-width="2" stroke-dasharray="6 4"/>`;
  }
  if (s.status !== 'done') svg += `<line x1="${X(tNow)}" x2="${X(tNow)}" y1="${T}" y2="${H - B}" stroke="#8b949e" stroke-dasharray="1 3"/>`;
  svg += `<polyline points="${pts.map(p => `${X(p.t)},${Y(p.w)}`).join(' ')}" fill="none" stroke="#e6edf3" stroke-width="1.5"/>`;
  svg += pts.map(p => `<circle cx="${X(p.t)}" cy="${Y(p.w)}" r="4.5" fill="#e6edf3"/>`).join('');
  svg += '</svg>';
  $('chart').innerHTML = svg;
}
function niceTicks(min, max, count) {
  const span = max - min || 1, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

function exportCsv() {
  const s = current, a = analyzeSession(s);
  const rows = [['oven_hours', 'weight_g', 'loss_g', 'moisture_pct_est', 'timestamp']];
  const filDry = a.dryWeight != null ? a.dryWeight - s.tare : null;
  s.entries.forEach(e => rows.push([e.t.toFixed(4), e.w, (s.entries[0].w - e.w).toFixed(2),
    filDry > 0 ? ((e.w - a.dryWeight) / filDry * 100).toFixed(4) : '', new Date(e.at).toISOString()]));
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${s.name.replace(/[^\w-]+/g, '_')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- reminders ----------
function requestNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(updateNotifBtn);
}
function updateNotifBtn() {
  $('notifBtn').classList.toggle('hidden', !('Notification' in window) || Notification.permission !== 'default');
}
async function remind(s) {
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body: `${s.name}: ${s.intervalMin} min in oven. Time to weigh it.`, tag: 'weigh', renotify: true, requireInteraction: true, icon: 'icons/icon-192.png', vibrate: [400, 200, 400] };
    try { const reg = await navigator.serviceWorker?.ready; if (reg) reg.showNotification('Time to weigh the spool', opts); else new Notification('Time to weigh the spool', opts); }
    catch { /* notifications unavailable */ }
  }
}
async function closeNotifications() {
  try { const reg = await navigator.serviceWorker?.getRegistration(); (await reg?.getNotifications({ tag: 'weigh' }))?.forEach(n => n.close()); } catch { }
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach(off => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime + off); g.gain.setValueAtTime(0, ctx.currentTime + off + 0.2);
      o.start(ctx.currentTime + off); o.stop(ctx.currentTime + off + 0.25);
    });
  } catch { }
}
async function setWakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator) { wakeLockObj = await navigator.wakeLock.request('screen'); wakeLockObj.addEventListener('release', () => { wakeLockObj = null; }); }
    else if (!on && wakeLockObj) { await wakeLockObj.release(); wakeLockObj = null; }
  } catch { $('wakeLock').checked = false; }
}

// ---------- wiring ----------
$('startBtn').onclick = startSession;
$('backBtn').onclick = () => { location.hash = '#/'; };
$('historyList').onclick = e => { const li = e.target.closest('li[data-id]'); if (li) location.hash = `#/s/${li.dataset.id}`; };
$('exportBtn').onclick = exportCsv;
$('deleteSessionBtn').onclick = () => {
  if (!confirm(`Delete "${current.name}"?`)) return;
  sessions = sessions.filter(s => s !== current); save(); location.hash = '#/';
};
$('notifBtn').onclick = requestNotify;
$('wakeLock').checked = localStorage.getItem('fdl.wake') === '1';
$('wakeLock').onchange = e => { localStorage.setItem('fdl.wake', e.target.checked ? '1' : '0'); setWakeLock(e.target.checked); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if ($('wakeLock').checked && !wakeLockObj) setWakeLock(true); if (current) tick(); }
});
window.addEventListener('hashchange', route);
window.addEventListener('storage', () => { sessions = load(); route(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
initForm();
updateNotifBtn();
if ($('wakeLock').checked) setWakeLock(true);
if (!location.hash) { const active = sessions.find(s => s.status !== 'done'); if (active) location.hash = `#/s/${active.id}`; }
route();
