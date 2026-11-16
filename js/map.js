// The island map: land, route lines, stops, ferry terminals and the buses where the timetable
// says they are. Drag to move, pinch or double-tap to zoom. Works with no signal.
import { shortStop } from './bus.js';
import { esc } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const HOME = { x: 60, y: 120, w: 1110, h: 1400 };
const PLACES = [
  ['117007', 'Ganges'], ['117000', 'Fulford'], ['117013', 'Vesuvius'], ['117014', 'Fernwood'],
];
const FERRY_LINES = [['FUL', 'SWB'], ['VES', 'CFT']];

export class IslandMap {
  constructor(el, map, bus, { onStop, onTerminal }) {
    this.el = el;
    this.bus = bus;
    this.onStop = onStop;
    this.onTerminal = onTerminal;
    this.vb = { ...HOME };
    this.route = null;
    const routeOf = {};
    for (const t of bus.trips) (routeOf[t.shape] ||= t.route);
    const colour = Object.fromEntries(bus.routes.map(r => [r.id, r.color]));
    const usedStops = new Set(bus.trips.flatMap(t => t.stops.map(s => s[0])));
    const stopRoutes = {};
    for (const t of bus.trips) for (const s of t.stops) (stopRoutes[s[0]] ||= new Set()).add(t.route);
    this.stopRoutes = stopRoutes;

    const T = map.terminals;
    el.innerHTML = `
      <svg xmlns="${NS}" class="island" preserveAspectRatio="xMidYMid meet">
        <rect class="water" x="-4000" y="-4000" width="10000" height="10000"/>
        <g class="land">${map.land.map(d => `<path d="${d}"/>`).join('')}</g>
        <g class="ferry-lines">${FERRY_LINES.map(([a, b]) => `<line x1="${T[a].x}" y1="${T[a].y}" x2="${T[b].x}" y2="${T[b].y}"/>`).join('')}
          <line x1="${T.PLH.x}" y1="${T.PLH.y}" x2="${map.width + 40}" y2="${T.PLH.y + 160}"/></g>
        <g class="routes">${Object.entries(bus.shapes).map(([id, s]) =>
          `<path data-route="${routeOf[id]}" d="${s.d}" stroke="${colour[routeOf[id]] || '#999'}"/>`).join('')}</g>
        <g class="terminals">${Object.entries(T).map(([code, t]) =>
          `<g class="terminal" data-terminal="${code}" transform="translate(${t.x} ${t.y})"><rect class="mk"/><text class="lbl">${esc(t.name)}</text></g>`).join('')}</g>
        <g class="stops">${[...usedStops].map(id => { const s = bus.stops[id]; return s ?
          `<g class="stop" data-stop="${id}" transform="translate(${s.x} ${s.y})"><circle class="hit"/><circle class="mk"/></g>` : ''; }).join('')}</g>
        <g class="places">${PLACES.map(([id, n]) => { const s = bus.stops[id]; return s ?
          `<text class="place" x="${s.x}" y="${s.y}">${n}</text>` : ''; }).join('')}</g>
        <g class="vehicles"></g>
      </svg>
      <div class="map-tools">
        <button class="map-home" aria-label="Whole island">⤢</button>
      </div>
      <div class="map-note"></div>
      <div class="map-credit">Map © OpenStreetMap contributors</div>`;
    this.svg = el.querySelector('svg');
    this.colour = colour;
    el.querySelector('.map-home').onclick = () => { this.vb = { ...HOME }; this.apply(); };
    this.gestures();
    new ResizeObserver(() => this.apply()).observe(el);
    this.apply();
  }

  apply() {
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    const px = this.svg.clientWidth || 1, py = this.svg.clientHeight || 1;
    const u = Math.max(w / px, h / py);   // map units per screen pixel
    this.u = u;
    this.svg.style.setProperty('--u', u);
    const zoomed = u < 1.6;
    this.svg.classList.toggle('zoomed', zoomed);
    for (const g of this.svg.querySelectorAll('.stop')) {
      g.querySelector('.mk').setAttribute('r', 4.2 * u);
      g.querySelector('.hit').setAttribute('r', 14 * u);
    }
    for (const g of this.svg.querySelectorAll('.terminal')) {
      const r = g.querySelector('.mk');
      r.setAttribute('x', -6 * u); r.setAttribute('y', -6 * u); r.setAttribute('width', 12 * u); r.setAttribute('height', 12 * u);
      r.setAttribute('rx', 3 * u);
      const t = g.querySelector('.lbl');
      t.setAttribute('x', 9 * u); t.setAttribute('y', 4 * u); t.setAttribute('font-size', 11.5 * u);
    }
    for (const t of this.svg.querySelectorAll('.place')) { t.setAttribute('font-size', 13 * u); t.setAttribute('dy', -9 * u); }
    this.drawVehicles(this.vehicles || []);
  }

  setRoute(id) {
    this.route = id;
    this.svg.classList.toggle('one-route', !!id);
    for (const p of this.svg.querySelectorAll('.routes path')) p.classList.toggle('on', p.dataset.route === id);
    for (const g of this.svg.querySelectorAll('.stop')) g.classList.toggle('dim', !!id && !this.stopRoutes[g.dataset.stop]?.has(id));
    // bring the chosen route's lines to the top
    const layer = this.svg.querySelector('.routes');
    for (const p of [...layer.children]) if (p.dataset.route === id) layer.appendChild(p);
  }

  setPinned(stopId) {
    for (const g of this.svg.querySelectorAll('.stop')) g.classList.toggle('pinned', g.dataset.stop === stopId);
  }

  setNote(html) { this.el.querySelector('.map-note').innerHTML = html || ''; }

  drawVehicles(list) {
    this.vehicles = list;
    const u = this.u || 1;
    const layer = this.svg.querySelector('.vehicles');
    const routes = Object.fromEntries(this.bus.routes.map(r => [r.id, r]));
    layer.innerHTML = list.map(v => {
      const r = routes[v.trip.route];
      const dim = this.route && this.route !== v.trip.route ? ' dim' : '';
      return `<g class="vehicle${dim}" transform="translate(${v.x.toFixed(1)} ${v.y.toFixed(1)})">
        <circle r="${11 * u}" fill="${r.color}"/><text font-size="${12 * u}" dy="${4.3 * u}" fill="${r.text}">${esc(r.num)}</text></g>`;
    }).join('');
  }

  gestures() {
    const svg = this.svg;
    const pts = new Map();
    let start = null, lastTap = 0, moved = 0;
    const toMap = (cx, cy) => {
      const r = svg.getBoundingClientRect();
      const { x, y, w, h } = this.vb;
      const u = this.u;
      const ox = x + w / 2 - (r.width / 2) * u, oy = y + h / 2 - (r.height / 2) * u;
      return [ox + (cx - r.left) * u, oy + (cy - r.top) * u];
    };
    const zoomAt = (cx, cy, f) => {
      const [mx, my] = toMap(cx, cy);
      const w = Math.min(Math.max(this.vb.w / f, 120), 2400);
      const k = w / this.vb.w;
      this.vb = { x: mx - (mx - this.vb.x) * k, y: my - (my - this.vb.y) * k, w, h: this.vb.h * k };
      this.apply();
    };
    svg.addEventListener('pointerdown', e => {
      svg.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 1) { moved = 0; start = [e.clientX, e.clientY]; }
    });
    svg.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      if (pts.size === 1) {
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        moved += Math.abs(dx) + Math.abs(dy);
        this.vb.x -= dx * this.u; this.vb.y -= dy * this.u;
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        this.apply();
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const before = Math.hypot(a[0] - b[0], a[1] - b[1]);
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        const [c, d] = [...pts.values()];
        const after = Math.hypot(c[0] - d[0], c[1] - d[1]);
        moved += 99;
        if (before > 0) zoomAt((c[0] + d[0]) / 2, (c[1] + d[1]) / 2, after / before);
      }
    });
    const end = e => {
      if (!pts.has(e.pointerId)) return;
      const single = pts.size === 1;
      pts.delete(e.pointerId);
      if (e.type !== 'pointerup' || !single || moved > 8) return;
      const now = Date.now();
      if (now - lastTap < 300) { lastTap = 0; zoomAt(e.clientX, e.clientY, 2); return; }
      lastTap = now;
      const hit = document.elementsFromPoint(e.clientX, e.clientY);
      const stop = hit.map(h => h.closest?.('[data-stop]')).find(Boolean);
      const term = hit.map(h => h.closest?.('[data-terminal]')).find(Boolean);
      if (stop) this.onStop(stop.dataset.stop);
      else if (term) this.onTerminal(term.dataset.terminal);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
  }
}

export { shortStop };
