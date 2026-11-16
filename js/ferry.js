// Ferries to and from Salt Spring. Saved sailings come from data/ferries.json (refreshed daily);
// today's sailings are also asked live from the open BC Ferries API when there's signal.
import { iso, fromIso, fmt, until, esc, store, ago, dayLabel, WEEKDAY_LONG, sameDay } from './util.js';
import { holidayName } from './days.js';
import { departuresAt, arrivalsAt } from './bus.js';

const API = 'https://www.bcferriesapi.ca/v2/noncapacity/';
const LIVE_KEY = 'ssi-ferry-live';
const ISLAND = ['FUL', 'VES', 'PLH'];
const SHORT = { POB: 'Pender', PVB: 'Mayne', PSB: 'Galiano', PST: 'Saturna', TSA: 'Tsawwassen', SWB: 'Swartz Bay' };
const island = c => SHORT[c] || c;

export const SECTIONS = [
  { id: 'ful', title: 'Fulford Harbour ⇄ Swartz Bay', out: 'FULSWB', back: 'SWBFUL', home: 'FUL', away: 'SWB', bus: { stop: '117000', route: '2-SSI' } },
  { id: 'ves', title: 'Vesuvius Bay ⇄ Crofton', out: 'VESCFT', back: 'CFTVES', home: 'VES', away: 'CFT', bus: { stop: '117013', route: '3-SSI' } },
  { id: 'plh', title: 'Long Harbour ⇄ Tsawwassen & the Gulf Islands', home: 'PLH', bus: { stop: '117011', route: '4-SSI' } },
];

function toMin(t) {
  const m = /(\d{1,2}):(\d{2})\s*([ap])m/i.exec(t || '');
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return h * 60 + +m[2];
}

export function liveSaved() { return store(LIVE_KEY); }

// Ask the API for today's sailings; keep only Salt Spring's routes.
export async function fetchLive() {
  const res = await fetch(API, { cache: 'no-store' });
  if (!res.ok) throw new Error(`BC Ferries API ${res.status}`);
  const api = await res.json();
  const routes = {};
  for (const r of api.routes || []) {
    if (!ISLAND.includes(r.fromTerminalCode) && !ISLAND.includes(r.toTerminalCode)) continue;
    if (!['available', 'no-service'].includes(r.dataStatus)) continue;
    routes[r.routeCode] = {
      date: r.serviceDate,
      noService: r.dataStatus === 'no-service',
      notices: (r.notices || []).map(n => ({ title: (n.title || '').trim(), body: (n.body || '').trim() })),
      sailings: (r.sailings || []).map(s => ({
        dep: toMin(s.scheduledTime || s.time),
        arr: toMin(s.arrivalTime),
        via: (s.stops || []).filter(x => x.type === 'stop').map(x => x.terminalName),
        status: s.status,
        cancelled: s.status === 'cancelled',
        actualDep: toMin(s.actualDepartureTime),
        eta: toMin(s.actualArrivalTime || s.estimatedArrivalTime),
        vessel: s.vesselName || '',
      })).filter(s => s.dep != null).sort((a, b) => a.dep - b.dep),
    };
  }
  const live = { at: Date.now(), routes };
  store(LIVE_KEY, live);
  return live;
}

// Sailings for one route on one day, saying where they came from.
export function sailingsFor(ferries, live, code, date, today) {
  const isToday = sameDay(date, today);
  const lr = live?.routes?.[code];
  const rec = ferries.routes[code];
  if (!rec) return null;
  const key = iso(date);
  const sea = seasonal(rec, date);
  if (isToday && lr && lr.date === key) return withDG({ ...lr, source: 'live', at: live.at }, sea);
  if (rec.days[key]) return withDG({ ...rec.days[key], source: 'saved', from: key }, sea);
  if (sea) return { sailings: sea, source: 'seasonal', range: rec.seasonal };
  // No record of this date: the most recent day like it (same weekday, then the same
  // kind of day, then any), never a holiday standing in for an ordinary day or back.
  const want = !!holidayName(date);
  const group = d => [0, 6].includes(d.getDay()) ? d.getDay() : 'weekday';
  const days = Object.keys(rec.days).sort().reverse().filter(k => !!holidayName(fromIso(k)) === want);
  const pick = days.find(k => fromIso(k).getDay() === date.getDay())
    || days.find(k => group(fromIso(k)) === group(date));
  if (pick) return { ...rec.days[pick], source: 'guess', from: pick, sameWeekday: fromIso(pick).getDay() === date.getDay() };
  return null;
}

// BC Ferries' weekly table for the day, if the day falls inside its dates.
function seasonal(rec, date) {
  const sea = rec.seasonal;
  const key = iso(date);
  if (!sea || key < sea.from || key > sea.to) return null;
  return sea.days[['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()]] || [];
}

// The live and daily data leave out dangerous-goods-only sailings; add them back, marked.
function withDG(res, sea) {
  const dg = (sea || []).filter(s => s.dg && !res.sailings.some(x => x.dep === s.dep));
  if (!dg.length) return res;
  return { ...res, sailings: [...res.sailings, ...dg].sort((a, b) => a.dep - b.dep) };
}

function statusBadge(s) {
  if (s.dg) return '<span class="badge warn">Dangerous goods only · no passengers</span>';
  if (s.cancelled) return '<span class="badge bad">Cancelled</span>';
  if (s.status === 'arrived') return '<span class="badge">Arrived</span>';
  if (s.status === 'departed') {
    const late = s.actualDep != null ? s.actualDep - s.dep : 0;
    return `<span class="badge ${late > 5 ? 'warn' : ''}">Left ${s.actualDep != null ? fmt(s.actualDep, true) : ''}</span>`;
  }
  return '';
}

function sourceLine(res, date) {
  if (!res) return '<p class="src warn">No schedule saved for this day yet. Check the BC Ferries page below.</p>';
  if (res.source === 'live') return `<p class="src live">● Live from BC Ferries · ${ago(res.at)}</p>`;
  if (res.source === 'saved') return `<p class="src">Saved schedule for ${dayLabel(fromIso(res.from))}</p>`;
  if (res.source === 'seasonal') return `<p class="src">BC Ferries seasonal schedule, ${dayLabel(fromIso(res.range.from))} – ${dayLabel(fromIso(res.range.to))}</p>`;
  return `<p class="src warn">No saved schedule for this day yet — showing ${res.sameWeekday ? `last ${WEEKDAY_LONG[date.getDay()]}'s` : `${dayLabel(fromIso(res.from))}'s`} sailings. Check before relying on it.</p>`;
}

function busFor(trips, stop, route) {
  const t = trips.filter(x => x.route === route);
  return { from: departuresAt(t, stop), to: arrivalsAt(t, stop) };
}

function column(title, res, now, isToday, extra) {
  if (!res) return `<div class="fcol"><h4>${esc(title)}</h4><p class="muted">No data</p></div>`;
  if (res.noService || !res.sailings.length) return `<div class="fcol"><h4>${esc(title)}</h4><p class="muted">No sailings</p></div>`;
  let nextDone = false;
  const rows = res.sailings.map(s => {
    const past = isToday && s.dep < now && !(s.status === 'scheduled' && s.dep > now - 2);
    let cls = past ? 'past' : '';
    if (isToday && !past && !nextDone && !s.cancelled && !s.dg) { cls = 'next'; nextDone = true; }
    return `<li class="${cls}${s.cancelled ? ' cancelled' : ''}${s.dg ? ' dg' : ''}">
      <span class="t">${fmt(s.dep)}</span>
      <span class="sub">${s.arr != null ? `arr ${fmt(s.arr, true)}` : ''}${cls === 'next' ? ` · <b>${until(s.dep, now)}</b>` : ''}</span>
      ${statusBadge(s)}${extra && !s.dg ? extra(s) : ''}</li>`;
  }).join('');
  return `<div class="fcol"><h4>${esc(title)}</h4><ul class="sailings">${rows}</ul></div>`;
}

function notices(list) {
  const seen = new Set();
  const out = (list || []).filter(n => { const k = n.title || n.body.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!out.length) return '';
  return out.map(n => {
    const title = n.title || n.body.split('\n').find(l => l.trim() && !/^(Updated|Issued):/i.test(l.trim())) || 'Notice';
    return `<details class="notice"><summary>${esc(title)}</summary><p>${esc(n.body).replace(/\n/g, '<br>')}</p></details>`;
  }).join('');
}

function longHarbour(ferries, live, date, today, now, trips) {
  const isToday = sameDay(date, today);
  const codes = Object.keys(ferries.routes).concat(Object.keys(live?.routes || {}));
  const outCodes = [...new Set(codes.filter(c => c.startsWith('PLH')))];
  const inCodes = [...new Set(codes.filter(c => c.endsWith('PLH')))];
  const name = c => ferries.names[c] || c;
  const gather = (list, key) => {
    const groups = new Map();
    let src = null;
    const found = list.map(c => [c, sailingsFor(ferries, live, c, date, today)]).filter(([, r]) => r);
    const good = found.filter(([, r]) => r.source !== 'guess');
    for (const [c, res] of good.length ? good : found) {
      if (!src || (src.source !== 'seasonal' && res.source === 'seasonal')) src = res;
      for (const s of res.sailings) {
        const k = key(s);
        if (!groups.has(k)) groups.set(k, { time: k, legs: [], sailing: s });
        groups.get(k).legs.push({ code: c, s });
      }
    }
    return { src, groups: [...groups.values()].sort((a, b) => a.time - b.time) };
  };
  const out = gather(outCodes, s => s.dep);
  const inn = gather(inCodes, s => s.arr);
  const bus = busFor(trips, '117011', '4-SSI');
  const render = (g, leaving) => {
    if (!g.groups.length) return g.src ? '<p class="muted">No sailings</p>' : '<p class="muted">—</p>';
    let nextDone = false;
    return `<ul class="sailings wide">${g.groups.map(x => {
      const past = isToday && x.time < now;
      let cls = past ? 'past' : '';
      if (isToday && !past && !nextDone) { cls = 'next'; nextDone = true; }
      const legs = x.legs.map(l => leaving
        ? { name: island(l.code.slice(3)), t: l.s.arr }
        : { name: island(l.code.slice(0, 3)), t: l.s.dep }).sort((a, b) => leaving ? a.t - b.t : b.t - a.t);
      const stops = x.legs.length === 1 && x.sailing.via ? x.sailing.via.map(v => esc(v.replace(/ Island \(.*\)$/, ''))) : [];
      if (stops.length && !leaving) stops.reverse();
      const legText = [...stops, ...legs.map(l => `${esc(l.name)} ${fmt(l.t, true)}`)].join(" · ");
      const conn = leaving ? lastBusBefore(bus.to, x.time) : firstBusAfter(bus.from, x.time);
      return `<li class="${cls}"><span class="t">${fmt(x.time)}</span>
        <span class="sub">${leaving ? '→' : '←'} ${legText}${cls === 'next' ? ` · <b>${until(x.time, now)}</b>` : ''}</span>
        ${statusBadge(x.sailing)}${conn}</li>`;
    }).join('')}</ul>`;
  };
  const notes = [...(out.src?.notices || []), ...(inn.src?.notices || [])];
  const rec = ferries.routes[outCodes[0]] || {};
  return `<section class="fsec">
    <h3>Long Harbour ⇄ Tsawwassen &amp; the Gulf Islands</h3>
    ${sourceLine(out.src || inn.src, date)}
    <h4>Leave Long Harbour</h4>${render(out, true)}
    <h4>Arrive at Long Harbour</h4>${render(inn, false)}
    ${notices(notes.length ? notes : rec.notices)}
    <a class="ext" href="https://www.bcferries.com/routes-fares/schedules/seasonal/PLH-TSA" target="_blank" rel="noopener">BC Ferries page ↗</a>
  </section>`;
}

function firstBusAfter(list, t) {
  const b = list.find(x => x.time >= t + 3);
  return b && b.time - t <= 45 ? `<span class="conn">Bus ${esc(b.trip.route.split('-')[0])} leaves ${fmt(b.time, true)}</span>` : '';
}
function lastBusBefore(list, t) {
  const b = [...list].reverse().find(x => x.time <= t - 5);
  return b && t - b.time <= 45 ? `<span class="conn">Bus ${esc(b.trip.route.split('-')[0])} gets there ${fmt(b.time, true)}</span>` : '';
}

export function renderFerries(el, { ferries, live, date, today, now, trips, liveState }) {
  const isToday = sameDay(date, today);
  const hol = holidayName(date);
  let html = '';
  if (isToday) {
    html += `<div class="live-bar">${liveState === 'loading' ? 'Checking BC Ferries…'
      : liveState === 'error' ? 'Offline — showing saved sailings.'
      : live ? `Live data ${ago(live.at)}` : 'Saved sailings'}
      <button class="refresh" data-act="ferry-refresh">Refresh</button></div>`;
  }
  if (hol && !isToday) html += `<p class="src warn">${esc(hol)}: ferries often run a holiday schedule. Check bcferries.com.</p>`;
  for (const sec of SECTIONS) {
    if (sec.id === 'plh') { html += longHarbour(ferries, live, date, today, now, trips); continue; }
    const out = sailingsFor(ferries, live, sec.out, date, today);
    const back = sailingsFor(ferries, live, sec.back, date, today);
    const names = ferries.names;
    const bus = busFor(trips, sec.bus.stop, sec.bus.route);
    const num = sec.bus.route.split('-')[0];
    const rec = ferries.routes[sec.out] || {};
    html += `<section class="fsec">
      <h3>${esc(sec.title)}</h3>
      ${sourceLine(out || back, date)}
      <div class="fcols">
        ${column(`Leave ${names[sec.home]}`, out, now, isToday, s => lastBusBefore(bus.to, s.dep))}
        ${column(`Leave ${names[sec.away]}`, back, now, isToday, s => s.arr != null ? firstBusAfter(bus.from, s.arr) : '')}
      </div>
      <p class="hint">Under each sailing: the Route ${num} bus that meets it at ${esc(names[sec.home])}.</p>
      ${notices((out && out.notices) || rec.notices)}
      ${rec.source ? `<a class="ext" href="${esc(rec.source)}" target="_blank" rel="noopener">BC Ferries page ↗</a>` : ''}
    </section>`;
  }
  html += `<p class="foot">Ferry times from the open <a href="https://www.bcferriesapi.ca/" target="_blank" rel="noopener">BC Ferries API</a> (unofficial). Saved copy updated ${ago(Date.parse(ferries.generated))}.</p>`;
  el.innerHTML = html;
}
