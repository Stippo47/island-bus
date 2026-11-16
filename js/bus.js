// Bus timetables: trips for a day, next departures, merged stop columns, and where buses should be.

export function shortStop(name) {
  const fixed = {
    'Visitor Info Centre': 'Ganges',
    'Fulford Ferry Term': 'Fulford Ferry',
    'Vesuvius Bay Ferry Term': 'Vesuvius Ferry',
    'Long Harbour at Scott Pnt': 'Long Harbour',
    'Cusheon Lake Road at Fulford-Ganges Road': 'Cusheon Lake Rd',
    'Beddis Road at Rourke Road': 'Beddis / Rourke',
    'Crofton Road at Hospital': 'Hospital',
    'North End at Upper Ganges': 'Upper Ganges',
    'Fernwood Dock': 'Fernwood Dock',
  };
  if (fixed[name]) return fixed[name];
  return name.replace(/^(Flfrd|Fulford)-Ganges at /, '').replace(/^Lower Ganges at /, 'Lower Ganges / ')
    .replace(/ Dr at /, ' at ').replace(/ at /, ' / ').replace(/ Pnt$/, ' Pt');
}

export function cleanHeadsign(h) {
  return (h || '').replace(/^.* - to /i, '').trim();
}

export const tripsFor = (bus, day) => bus.trips.filter(t => day.services.has(t.service));
export const firstDep = t => t.stops[0][1];
export const lastArr = t => t.stops[t.stops.length - 1][2];

// Keys like "117007#2" so loops that pass a stop twice keep both visits apart.
function keys(t) {
  const seen = {};
  return t.stops.map(s => `${s[0]}#${(seen[s[0]] = (seen[s[0]] || 0) + 1)}`);
}

export function columns(trips) {
  const cols = [];
  const sorted = [...trips].sort((a, b) => b.stops.length - a.stops.length);
  for (const t of sorted) {
    let last = -1;
    for (const k of keys(t)) {
      let i = cols.indexOf(k);
      if (i < 0) { cols.splice(last + 1, 0, k); i = last + 1; }
      last = i;
    }
  }
  return cols;
}

export function cells(trip, cols) {
  const ks = keys(trip);
  return cols.map(c => { const i = ks.indexOf(c); return i < 0 ? null : trip.stops[i][1]; });
}

// Direction labels for a route, made unique when two directions share a headsign.
export function directions(bus, routeId, trips) {
  const dirs = [...new Set(trips.filter(t => t.route === routeId).map(t => t.dir))].sort();
  const all = bus.trips.filter(t => t.route === routeId);
  const dirsAll = [...new Set(all.map(t => t.dir))].sort();
  const label = {};
  for (const d of dirsAll) {
    const ts = all.filter(t => t.dir === d);
    const loops = ts.filter(t => t.stops[0][0] === t.stops[t.stops.length - 1][0]).length;
    label[d] = loops > ts.length / 2 ? `Loop from ${shortStop(bus.stops[ts[0].stops[0][0]].name)}` : mode(ts.map(t => cleanHeadsign(t.headsign)));
  }
  const names = Object.values(label);
  if (new Set(names).size < names.length) {
    for (const d of dirsAll) {
      const t = all.find(x => x.dir === d);
      const other = all.find(x => x.dir !== d);
      const i = t.stops.findIndex((s, j) => !other || !other.stops[j] || other.stops[j][0] !== s[0]);
      const stop = bus.stops[t.stops[Math.max(i, 1)][0]];
      label[d] = `${label[d]} via ${shortStop(stop.name)}`;
    }
  }
  return { dirs: dirsAll, active: dirs, label };
}

function mode(arr) {
  const c = {};
  arr.forEach(x => (c[x] = (c[x] || 0) + 1));
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// Upcoming departures from one stop (the last stop of a trip is an arrival, not a departure).
export function departuresAt(trips, stopId, after = -1) {
  const out = [];
  for (const t of trips) {
    t.stops.forEach((s, i) => {
      if (s[0] === stopId && i < t.stops.length - 1 && s[1] >= after) out.push({ trip: t, time: s[1] });
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Arrivals at a stop (any visit), for ferry connections.
export function arrivalsAt(trips, stopId) {
  const out = [];
  for (const t of trips) t.stops.forEach((s, i) => { if (s[0] === stopId && i > 0) out.push({ trip: t, time: s[2] }); });
  return out.sort((a, b) => a.time - b.time);
}

// Where each running bus should be right now, by the timetable.
export function scheduledPositions(bus, trips, now) {
  const out = [];
  for (const t of trips) {
    if (now < firstDep(t) - 0.5 || now > lastArr(t) + 0.5) continue;
    const shape = bus.shapes[t.shape];
    if (!shape) continue;
    let dist = t.stops[0][3];
    const s = t.stops;
    for (let i = 0; i < s.length; i++) {
      const [, dep, arr, d] = s[i];
      if (now >= arr && now <= dep) { dist = d; break; }
      const next = s[i + 1];
      if (next && now > dep && now < next[2]) {
        const f = (now - dep) / Math.max(next[2] - dep, 0.01);
        dist = d + (next[3] - d) * f;
        break;
      }
      if (!next) dist = d;
    }
    const p = along(shape.pts, dist);
    if (p) out.push({ trip: t, x: p[0], y: p[1] });
  }
  return out;
}

function along(pts, dist) {
  if (!pts.length) return null;
  if (dist <= pts[0][2]) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][2] >= dist) {
      const a = pts[i - 1], b = pts[i];
      const f = (dist - a[2]) / Math.max(b[2] - a[2], 1);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  return pts[pts.length - 1];
}
