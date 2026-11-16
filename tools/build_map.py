"""Turn OpenStreetMap coastline ways into land shapes for the map (run by hand, rarely).

Get the coastline with this Overpass query and pass the saved file:
  [out:json];way["natural"="coastline"](48.665,-123.67,48.95,-123.33);out geom;

  python tools/build_map.py coast.json

Coastline ways keep land on their left. Closed rings are islands. Rings cut open by the
query box (Vancouver Island) are closed with a far point on their land side, then the map's
own frame hides the overshoot.
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from geo import WIDTH, HEIGHT, project, simplify, path_d  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# Ferry terminals (BC Ferries codes)
TERMINALS = {
    'FUL': ('Fulford Harbour', 48.7690, -123.4501),
    'VES': ('Vesuvius Bay', 48.8818, -123.5725),
    'PLH': ('Long Harbour', 48.8514, -123.4458),
    'SWB': ('Swartz Bay', 48.6887, -123.4108),
    'CFT': ('Crofton', 48.8649, -123.6383),
}


def chains(ways):
    by_start = {}
    for w in ways:
        by_start.setdefault(w[0], []).append(w)
    used = set()
    out = []
    for w in ways:
        if id(w) in used:
            continue
        used.add(id(w))
        chain = list(w)
        # grow forward
        while True:
            nxt = [c for c in by_start.get(chain[-1], []) if id(c) not in used]
            if not nxt or chain[-1] == chain[0]:
                break
            used.add(id(nxt[0]))
            chain.extend(nxt[0][1:])
        out.append(chain)
    # join open chains whose end meets another's start (in any order)
    merged = True
    while merged:
        merged = False
        for a in out:
            if a[0] == a[-1]:
                continue
            for b in out:
                if b is a or b[0] == b[-1]:
                    continue
                if a[-1] == b[0]:
                    a.extend(b[1:])
                    out.remove(b)
                    merged = True
                    break
            if merged:
                break
    return out


def polygon_area(pts):
    return abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))) / 2


def add(land, pts, area):
    simple = simplify(pts, 1.2)
    if len(simple) >= 3:
        land.append({'d': path_d(simple, closed=True), 'area': round(area)})


def _inside(p):
    return 0 <= p[0] <= WIDTH and 0 <= p[1] <= HEIGHT


def _cross(a, b):
    """Where segment a->b crosses the frame (a and b on different sides)."""
    best = None
    for axis, val in ((0, 0), (0, WIDTH), (1, 0), (1, HEIGHT)):
        da, db = a[axis] - val, b[axis] - val
        if da == db or (da > 0) == (db > 0) and da != 0 and db != 0:
            continue
        t = da / (da - db)
        if not 0 <= t <= 1:
            continue
        q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        if -0.01 <= q[0] <= WIDTH + 0.01 and -0.01 <= q[1] <= HEIGHT + 0.01:
            if best is None or t < best[0]:
                best = (t, q)
    return best[1] if best else None


def _perim(p):
    """Distance along the frame, clockwise on screen from the top-left corner."""
    x, y = p
    if abs(y) < 0.02:
        return x
    if abs(x - WIDTH) < 0.02:
        return WIDTH + y
    if abs(y - HEIGHT) < 0.02:
        return WIDTH + HEIGHT + (WIDTH - x)
    return 2 * WIDTH + HEIGHT + (HEIGHT - y)


CORNERS = [(0.0, (0, 0)), (WIDTH, (WIDTH, 0)), (WIDTH + HEIGHT, (WIDTH, HEIGHT)), (2 * WIDTH + HEIGHT, (0, HEIGHT))]
PERIM = 2 * (WIDTH + HEIGHT)


def close_on_frame(opens):
    """Cut open coast chains at the frame and join the pieces along it, keeping land on the left."""
    runs = []
    for pts in opens:
        cur = None
        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = _inside(a), _inside(b)
            if not ia and ib:
                q = _cross(a, b)
                cur = [q, b]
            elif ia and ib and cur is not None:
                cur.append(b)
            elif ia and not ib and cur is not None:
                cur.append(_cross(b, a))
                runs.append(cur)
                cur = None
    for r in runs:
        r_in, r_out = _perim(r[0]), _perim(r[-1])
        r.append(None)  # slot for bookkeeping
        r[-1] = (r_in, r_out)
    polys = []
    used = set()
    for start in range(len(runs)):
        if start in used:
            continue
        poly = []
        k = start
        while True:
            used.add(k)
            pts = runs[k][:-1]
            poly.extend(pts)
            s_out = runs[k][-1][1]
            # walk anticlockwise (decreasing distance) to the nearest entry
            best, bk = None, None
            for j, r in enumerate(runs):
                d = (s_out - r[-1][0]) % PERIM
                if best is None or d < best:
                    best, bk = d, j
            # corners passed on the way
            for c_s, c_p in sorted(CORNERS, key=lambda c: (s_out - c[0]) % PERIM):
                if 0 < (s_out - c_s) % PERIM < best:
                    poly.append(c_p)
            if bk == start or bk in used:
                break
            k = bk
        polys.append(poly)
    return polys


def main(src):
    data = json.loads(Path(src).read_text(encoding='utf-8'))
    ways = []
    coords = {}
    for e in data['elements']:
        geom = [(round(g['lat'], 7), round(g['lon'], 7)) for g in e['geometry']]
        ways.append(tuple(geom))
    land = []
    opens = []
    for ch in chains([list(w) for w in ways]):
        pts = [project(lat, lon) for lat, lon in ch]
        if ch[0] != ch[-1]:
            opens.append(pts)
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        if max(xs) < 0 or min(xs) > WIDTH or max(ys) < 0 or min(ys) > HEIGHT:
            continue
        area = polygon_area(pts)
        if area < 400:   # rocks smaller than ~0.16 km2
            continue
        add(land, pts, area)
    for poly in close_on_frame(opens):
        add(land, poly, polygon_area(poly))
    land.sort(key=lambda l: -l['area'])
    terminals = {}
    for code, (name, lat, lon) in TERMINALS.items():
        x, y = project(lat, lon)
        terminals[code] = {'name': name, 'x': round(x, 1), 'y': round(y, 1)}
    out = {'width': WIDTH, 'height': HEIGHT, 'land': [l['d'] for l in land], 'terminals': terminals,
           'credit': '© OpenStreetMap contributors (ODbL)'}
    dest = ROOT / 'data' / 'map.json'
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'{len(land)} land shapes, {dest.stat().st_size // 1024} KB, {WIDTH}x{HEIGHT}')


if __name__ == '__main__':
    main(sys.argv[1])
