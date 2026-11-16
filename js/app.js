// Island Bus: Salt Spring Island buses and ferries, offline first.
import { fmt, until, esc, store, midnight, addDays, sameDay, nowMin, dayLabel, WEEKDAY, MONTH, ago, iso, fromIso } from './util.js';
import { busDay, busWarning, upcoming, KIND_NAME } from './days.js';
import { tripsFor, columns, cells, directions, departuresAt, scheduledPositions, shortStop, cleanHeadsign, firstDep, lastArr } from './bus.js';
import { IslandMap } from './map.js';
import { renderFerries, fetchLive, liveSaved } from './ferry.js';

const VERSION = '0.2.0';
const DAYS_SHOWN = 14;
const params = new URLSearchParams(location.search);

// The looks. Each is only colours and type in style.css ([data-look=...]).
const LOOKS = [
  { id: 'plain', name: 'Plain', bar: '#101113', light: false },
  { id: 'signal', name: 'Signal', bar: '#ffffff', light: true },
  { id: 'chart', name: 'Chart', bar: '#f3ecdc', light: true },
  { id: 'board', name: 'Departures', bar: '#000000', light: false },
  { id: 'forest', name: 'Forest', bar: '#0f1d17', light: false },
];

const S = {
  tab: store('ssi-tab') || 'bus',
  date: null,          // the day being looked at (local midnight)
  route: null,
  dir: {},
  pinned: store('ssi-stop') || null,
  earlier: false,
  bus: null, ferries: null, mapData: null, map: null,
  live: liveSaved(), liveState: null,
  look: params.get('look') || store('ssi-look') || 'plain',
};

function applyLook(id) {
  const look = LOOKS.find(l => l.id === id) || LOOKS[0];
  S.look = look.id;
  store('ssi-look', look.id);
  document.documentElement.dataset.look = look.id;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', look.bar);
}

const lookPicker = () => `<div class="looks"><span>Look</span>${LOOKS.map(l =>
  `<button class="${l.id === S.look ? 'on' : ''}" data-act="look" data-look="${l.id}">${l.name}</button>`).join('')}</div>`;

const $ = s => document.querySelector(s);
const today = () => midnight(new Date());
const isToday = () => sameDay(S.date, today());
const routeById = id => S.bus.routes.find(r => r.id === id);
const arrow = l => (/^Loop/.test(l) ? '⟳ ' : '→ ') + esc(l);
const pill = r => `<span class="pill" style="--c:${r.color};--t:${r.text}">${esc(r.num)}</span>`;

async function load(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function start() {
  // Offline copy (left off on the local test server unless ?sw is in the address)
  const local = ['localhost', '127.0.0.1'].includes(location.hostname) && !location.search.includes('sw');
  if ('serviceWorker' in navigator && !local) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    [S.bus, S.ferries, S.mapData] = await Promise.all([load('data/bus.json'), load('data/ferries.json'), load('data/map.json')]);
  } catch (e) {
    $('#bus-body').innerHTML = `<p class="src bad">Couldn't load the timetable (${esc(e.message)}). Open the app once with signal so it can save a copy.</p>`;
    return;
  }
  S.date = today();
  applyLook(S.look);
  if (params.get('tab')) S.tab = params.get('tab');
  if (params.get('route')) S.route = params.get('route');
  S.map = new IslandMap($('#map'), S.mapData, S.bus, {
    onStop: id => openStop(id),
    onTerminal: () => setTab('ferry'),
  });
  S.map.setPinned(S.pinned);
  wire();
  setTab(S.tab, true);
  render();
  if (params.get('shot') === 'route') $('#bus-body').scrollIntoView({ block: 'start' });
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function wire() {
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'day') { S.date = fromIso(a.dataset.date); S.earlier = false; render(); }
    if (act === 'route') { S.route = S.route === a.dataset.route || !a.dataset.route ? null : a.dataset.route; S.earlier = false; render(); if (S.route) $('#bus-body').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (act === 'dir') { S.dir[S.route] = +a.dataset.dir; render(); }
    if (act === 'earlier') { S.earlier = !S.earlier; render(); }
    if (act === 'stop') openStop(a.dataset.stop);
    if (act === 'pin') { S.pinned = S.pinned === a.dataset.stop ? null : a.dataset.stop; store('ssi-stop', S.pinned); S.map.setPinned(S.pinned); closeSheet(); render(); }
    if (act === 'close-sheet') closeSheet();
    if (act === 'ferry-refresh') refreshLive(true);
    if (act === 'pick-date') pickDate();
    if (act === 'look') { applyLook(a.dataset.look); render(); }
  });
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
}

function pickDate() {
  const input = document.createElement('input');
  input.type = 'date';
  input.value = iso(S.date);
  input.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(input);
  input.onchange = () => { if (input.value) { S.date = fromIso(input.value); render(); } input.remove(); };
  input.onblur = () => setTimeout(() => input.remove(), 500);
  input.showPicker ? input.showPicker() : input.click();
}

function setTab(tab, first) {
  S.tab = tab;
  store('ssi-tab', tab);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#bus-view').hidden = tab !== 'bus';
  $('#ferry-view').hidden = tab !== 'ferry';
  if (tab === 'ferry') refreshLive(false);
  if (!first) { render(); window.scrollTo(0, 0); }
}

async function refreshLive(force) {
  if (!navigator.onLine && !force) return;
  if (!force && S.live && Date.now() - S.live.at < 3 * 60000) return;
  if (S.liveState === 'loading') return;
  S.liveState = 'loading';
  if (S.tab === 'ferry') render();
  try { S.live = await fetchLive(); S.liveState = 'ok'; }
  catch { S.liveState = 'error'; }
  render();
}

let lastDay = null;
function tick() {
  const t = today();
  if (lastDay && !sameDay(lastDay, t) && sameDay(S.date, lastDay)) S.date = t;   // past midnight: follow today
  lastDay = t;
  render();
}

function render() {
  if (!S.bus) return;
  const now = new Date();
  $('#clock').innerHTML = fmt(now.getHours() * 60 + now.getMinutes());
  renderDays();
  const day = busDay(S.bus, S.date);
  renderBanner(day);
  const trips = tripsFor(S.bus, day);
  if (S.tab === 'bus') renderBus(day, trips);
  else {
    renderFerries($('#ferry-view'), { ferries: S.ferries, live: S.live, date: S.date, today: today(), now: isToday() ? nowMin() : -1, trips, liveState: S.liveState });
    $('#ferry-view').insertAdjacentHTML('beforeend', lookPicker());
  }
}

function renderDays() {
  const t = today();
  let html = '';
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const d = addDays(t, i);
    const day = busDay(S.bus, d);
    const flag = day.kind === 'none' ? 'none' : day.special ? 'special' : day.holiday ? 'holiday' : '';
    const kind = { none: 'No bus', weekday: 'Wkdy', saturday: 'Sat', sunday: 'Sun' }[day.kind];
    html += `<button class="day ${sameDay(d, S.date) ? 'on' : ''} ${flag}" data-act="day" data-date="${iso(d)}" role="tab">
      <span class="dw">${i === 0 ? 'Today' : WEEKDAY[d.getDay()]}</span><span class="dn">${d.getDate()}</span><span class="dk">${kind}</span></button>`;
  }
  const inStrip = [...Array(DAYS_SHOWN).keys()].some(i => sameDay(addDays(t, i), S.date));
  html += `<button class="day pick ${inStrip ? '' : 'on'}" data-act="pick-date"><span class="dw">${inStrip ? 'Other' : WEEKDAY[S.date.getDay()]}</span><span class="dn">${inStrip ? '📅' : S.date.getDate()}</span><span class="dk">${inStrip ? 'date' : MONTH[S.date.getMonth()]}</span></button>`;
  const el = $('#days');
  const keep = el.scrollLeft;
  el.innerHTML = html;
  el.scrollLeft = keep;
}

function renderBanner(day) {
  const parts = [];
  const w = busWarning(day);
  if (!isToday()) parts.push(`<div class="banner viewing"><span>Showing <b>${dayLabel(S.date)}</b> · ${day.kind === 'none' ? 'no buses' : `${KIND_NAME[day.kind]} buses`}</span><button data-act="day" data-date="${iso(today())}">Back to today</button></div>`);
  if (w) parts.push(`<div class="banner ${w.level}">${esc(w.text)}</div>`);
  if (isToday()) {
    for (const u of upcoming(S.bus, today(), 10).slice(0, 2)) {
      const what = u.day.kind === 'none' ? 'no buses' : `${KIND_NAME[u.day.kind]} schedule`;
      parts.push(`<button class="banner soon" data-act="day" data-date="${iso(u.date)}">Coming up: <b>${dayLabel(u.date)}</b>${u.day.holiday ? ` (${esc(u.day.holiday)})` : ''} — ${what}</button>`);
    }
  }
  $('#banner').innerHTML = parts.join('');
}

// ---------- buses ----------

function renderBus(day, trips) {
  const now = isToday() ? nowMin() : -1;
  S.map.setRoute(S.route);
  S.map.drawVehicles(isToday() ? scheduledPositions(S.bus, trips, now) : []);
  S.map.setNote(isToday() ? 'Buses shown where the timetable puts them' : '');

  let html = `<div class="chips">${S.bus.routes.map(r =>
    `<button class="chip ${S.route === r.id ? 'on' : ''}" data-act="route" data-route="${r.id}" style="--c:${r.color};--t:${r.text}">${pill(r)}<span>${esc(r.name)}</span></button>`).join('')}</div>`;

  if (S.pinned && S.bus.stops[S.pinned]) html += stopPanel(S.pinned, trips, now, true);

  if (day.kind === 'none') html += `<p class="empty">No buses run on ${dayLabel(S.date)}.</p>`;
  else if (S.route) html += timetable(S.route, trips, now);
  else html += S.bus.routes.map(r => routeCard(r, trips, now)).join('');

  html += `<p class="foot">Timetable from BC Transit's open data, valid to ${feedEnd()}. Checked for updates ${ago(Date.parse(S.ferries.generated))}. Not affiliated with BC Transit · v${VERSION}</p>`;
  $('#bus-body').innerHTML = html + lookPicker();
}

function feedEnd() {
  const e = S.bus.feedEnd;
  return e ? dayLabel(new Date(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6))) + ` ${e.slice(0, 4)}` : 'unknown';
}

function routeCard(r, trips, now) {
  const mine = trips.filter(t => t.route === r.id);
  const { dirs, label } = directions(S.bus, r.id, mine);
  let body;
  if (!mine.length) body = '<p class="muted">No trips this day</p>';
  else body = dirs.filter(d => mine.some(t => t.dir === d)).map(d => {
    const ts = mine.filter(t => t.dir === d).sort((a, b) => firstDep(a) - firstDep(b));
    const from = shortStop(S.bus.stops[ts[0].stops[0][0]].name);
    if (now >= 0) {
      const running = ts.filter(t => firstDep(t) <= now && lastArr(t) >= now);
      const next = ts.find(t => firstDep(t) > now);
      const runTxt = running.length ? `<span class="running">● on the road</span>` : '';
      const nextTxt = next ? `<b>${fmt(firstDep(next))}</b> from ${esc(from)} <span class="in">${until(firstDep(next), now)}</span>`
        : `<span class="muted">No more trips today</span>`;
      return `<div class="dirline"><span class="to">${arrow(label[d])}</span><span class="when">${nextTxt} ${runTxt}</span></div>`;
    }
    return `<div class="dirline"><span class="to">${arrow(label[d])}</span><span class="when">${ts.length} trips · ${fmt(firstDep(ts[0]), true)} – ${fmt(firstDep(ts.at(-1)), true)}</span></div>`;
  }).join('');
  return `<button class="card route" data-act="route" data-route="${r.id}" style="--c:${r.color}">
    <div class="card-head">${pill(r)}<h2>${esc(r.name)}</h2><span class="chev">›</span></div>${body}</button>`;
}

function timetable(routeId, trips, now) {
  const r = routeById(routeId);
  const mine = trips.filter(t => t.route === routeId);
  const { dirs, label } = directions(S.bus, routeId, mine);
  const avail = dirs.filter(d => mine.some(t => t.dir === d));
  let dir = S.dir[routeId];
  if (!avail.includes(dir)) dir = (now >= 0 && avail.find(d => mine.some(t => t.dir === d && lastArr(t) >= now))) ?? avail[0];
  const head = `<div class="tt-head" style="--c:${r.color}">${pill(r)}<h2>${esc(r.name)}</h2>
    <button class="x" data-act="route" data-route="" aria-label="All routes">All routes</button></div>`;
  if (!mine.length) return head + '<p class="empty">No trips on this route this day.</p>';
  const seg = avail.length > 1 ? `<div class="seg">${avail.map(d =>
    `<button class="${d === dir ? 'on' : ''}" data-act="dir" data-dir="${d}">${arrow(label[d])}</button>`).join('')}</div>` : `<p class="tt-dir">${arrow(label[dir])}</p>`;
  const ts = mine.filter(t => t.dir === dir).sort((a, b) => firstDep(a) - firstDep(b));
  const cols = columns(ts);
  const nextIdx = now >= 0 ? ts.findIndex(t => lastArr(t) >= now) : -1;   // first trip not finished
  const upIdx = now >= 0 ? ts.findIndex(t => firstDep(t) > now) : -1;     // first trip not started
  const hiddenCount = now >= 0 && !S.earlier ? Math.max(nextIdx < 0 ? ts.length : nextIdx, 0) : 0;
  const rows = ts.map((t, i) => {
    if (i < hiddenCount) return '';
    const running = now >= 0 && firstDep(t) <= now && lastArr(t) >= now;
    const past = now >= 0 && lastArr(t) < now;
    const cls = running ? 'running' : i === upIdx ? 'next' : past ? 'past' : '';
    return `<tr class="${cls}">${cells(t, cols).map((c, j) => {
      const passed = now >= 0 && c != null && c < now;
      return `<td class="${passed && running ? 'gone' : ''}">${c == null ? '<span class="skip">–</span>' : fmt(c, true)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const header = cols.map(k => {
    const id = k.split('#')[0];
    return `<th><button data-act="stop" data-stop="${id}">${esc(shortStop(S.bus.stops[id].name))}</button></th>`;
  }).join('');
  const earlier = now >= 0 && (hiddenCount > 0 || S.earlier) && nextIdx !== 0
    ? `<button class="earlier" data-act="earlier">${S.earlier ? 'Hide earlier trips' : `Show ${hiddenCount} earlier trip${hiddenCount === 1 ? '' : 's'}`}</button>` : '';
  const noneLeft = now >= 0 && nextIdx < 0 ? '<p class="muted pad">No more trips today.</p>' : '';
  return `${head}${seg}${earlier}${noneLeft}
    ${rows ? `<div class="tt-wrap"><table class="tt" style="--c:${r.color}"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <p class="hint">Tap a stop name for every bus from it. Green bar = on the road now · coloured row = next bus.</p>`;
}

function stopPanel(stopId, trips, now, pinnedView) {
  const stop = S.bus.stops[stopId];
  const list = departuresAt(trips, stopId, now >= 0 ? now - 0.5 : -1);
  const max = pinnedView ? 4 : 40;
  const items = list.slice(0, max).map(x => {
    const r = routeById(x.trip.route);
    return `<li>${pill(r)}<span class="to">→ ${esc(cleanHeadsign(x.trip.headsign))}</span><span class="t">${fmt(x.time)}</span>${now >= 0 ? `<span class="in">${until(x.time, now)}</span>` : ''}</li>`;
  }).join('');
  const empty = `<p class="muted">${now >= 0 ? 'No more buses from here today.' : 'No buses from here this day.'}</p>`;
  return `<div class="stop-panel ${pinnedView ? 'pinned' : ''}">
    <div class="sp-head"><h3>${pinnedView ? '★ ' : ''}${esc(shortStop(stop.name))}</h3>
      ${pinnedView ? `<button data-act="stop" data-stop="${stopId}">All</button>` : ''}</div>
    ${pinnedView ? '' : `<p class="muted small">${esc(stop.name)} · stop ${esc(stop.code)}</p>`}
    ${items ? `<ul class="deps">${items}</ul>` : empty}</div>`;
}

function openStop(id) {
  const day = busDay(S.bus, S.date);
  const trips = tripsFor(S.bus, day);
  const now = isToday() ? nowMin() : -1;
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="sheet-card">
    <div class="sheet-bar"><button data-act="pin" data-stop="${id}">${S.pinned === id ? '★ Pinned' : '☆ Pin to top'}</button>
    <button data-act="close-sheet">Close</button></div>
    ${stopPanel(id, trips, now, false)}
    <p class="muted small pad">${isToday() ? 'Upcoming today' : dayLabel(S.date)}</p></div>`;
  sheet.hidden = false;
}

function closeSheet() { $('#sheet').hidden = true; }

start();
