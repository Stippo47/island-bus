"""BC Transit's open GTFS feed for Salt Spring Island -> data/bus.json (run by the daily workflow).

  python tools/build_bus.py            # download the feed
  python tools/build_bus.py feed.zip   # or use a saved copy

Holidays need no list of their own: the feed says which service runs on each date, so a
Monday that runs the Sunday timetable shows up as one.
"""
import csv
import io
import json
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from geo import project, simplify, path_d  # noqa: E402

FEED = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=39'
ROOT = Path(__file__).resolve().parent.parent
KINDS = ['weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'saturday', 'sunday']


def read(z, name):
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))


def minutes(hms):
    h, m, *_ = (int(x) for x in hms.split(':'))
    return h * 60 + m


def main(src=None):
    raw = Path(src).read_bytes() if src else urllib.request.urlopen(
        urllib.request.Request(FEED, headers={'User-Agent': 'ssi-transit-pwa'}), timeout=60).read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    names = set(z.namelist())

    info = read(z, 'feed_info.txt')[0] if 'feed_info.txt' in names else {}

    # which services run on which date
    days = defaultdict(set)
    if 'calendar.txt' in names:
        for c in read(z, 'calendar.txt'):
            d0 = datetime.strptime(c['start_date'], '%Y%m%d').date()
            d1 = datetime.strptime(c['end_date'], '%Y%m%d').date()
            flags = [c[k] == '1' for k in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
            d = d0
            while d <= d1:
                if flags[d.weekday()]:
                    days[d.strftime('%Y%m%d')].add(c['service_id'])
                d = date.fromordinal(d.toordinal() + 1)
    for c in read(z, 'calendar_dates.txt') if 'calendar_dates.txt' in names else []:
        if c['exception_type'] == '1':
            days[c['date']].add(c['service_id'])
        else:
            days[c['date']].discard(c['service_id'])

    # name each service after the kind of day it mostly runs on
    votes = defaultdict(Counter)
    for ds, sids in days.items():
        k = KINDS[datetime.strptime(ds, '%Y%m%d').weekday()]
        for s in sids:
            votes[s][k] += 1
    service_kind = {s: v.most_common(1)[0][0] for s, v in votes.items()}

    stops = {}
    for s in read(z, 'stops.txt'):
        x, y = project(float(s['stop_lat']), float(s['stop_lon']))
        stops[s['stop_id']] = {'name': s['stop_name'].strip(), 'code': s.get('stop_code', ''), 'x': round(x, 1), 'y': round(y, 1)}

    shapes = defaultdict(list)
    for p in read(z, 'shapes.txt'):
        x, y = project(float(p['shape_pt_lat']), float(p['shape_pt_lon']))
        shapes[p['shape_id']].append((int(p['shape_pt_sequence']), x, y, float(p.get('shape_dist_traveled') or 0)))
    shape_out = {}
    for sid, pts in shapes.items():
        pts.sort()
        line = simplify([(x, y, d) for _, x, y, d in pts], 0.6)
        shape_out[sid] = {'d': path_d(line), 'pts': [[round(x, 1), round(y, 1), round(d)] for x, y, d in line]}

    st = defaultdict(list)
    for r in read(z, 'stop_times.txt'):
        st[r['trip_id']].append((int(r['stop_sequence']), r['stop_id'], minutes(r['departure_time'] or r['arrival_time']),
                                 minutes(r['arrival_time'] or r['departure_time']), round(float(r.get('shape_dist_traveled') or 0))))

    trips = []
    used_shapes = set()
    for t in read(z, 'trips.txt'):
        times = sorted(st.get(t['trip_id'], []))
        if not times:
            continue
        used_shapes.add(t['shape_id'])
        trips.append({
            'id': t['trip_id'], 'route': t['route_id'], 'service': t['service_id'],
            'headsign': t.get('trip_headsign', '').strip(), 'dir': int(t.get('direction_id') or 0),
            'shape': t['shape_id'], 'block': t.get('block_id', ''),
            'stops': [[s, dep, arr, dist] for _, s, dep, arr, dist in times],
        })
    trips.sort(key=lambda t: (t['route'], t['dir'], t['stops'][0][1]))

    def route_sort(r):
        n = r['route_short_name']
        return (0, int(n)) if n.isdigit() else (1, n)

    routes = []
    for r in sorted(read(z, 'routes.txt'), key=route_sort):
        routes.append({'id': r['route_id'], 'num': r['route_short_name'], 'name': r['route_long_name'],
                       'color': '#' + (r.get('route_color') or '888888'), 'text': '#' + (r.get('route_text_color') or 'FFFFFF')})

    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': FEED,
        'feedVersion': info.get('feed_version', ''),
        'feedStart': info.get('feed_start_date', ''),
        'feedEnd': info.get('feed_end_date', ''),
        'serviceKind': service_kind,
        'days': {d: sorted(s) for d, s in sorted(days.items())},
        'routes': routes,
        'stops': stops,
        'shapes': {k: v for k, v in shape_out.items() if k in used_shapes},
        'trips': trips,
    }
    dest = ROOT / 'data' / 'bus.json'
    old = json.loads(dest.read_text(encoding='utf-8')) if dest.exists() else None
    if old and {k: v for k, v in old.items() if k != 'generated'} == {k: v for k, v in out.items() if k != 'generated'}:
        print('bus: unchanged')
        return
    dest.write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'bus: {len(routes)} routes, {len(trips)} trips, {len(stops)} stops, {dest.stat().st_size // 1024} KB, feed to {out["feedEnd"]}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
