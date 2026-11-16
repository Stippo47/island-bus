"""Salt Spring's BC Ferries sailings -> data/ferries.json (run by the daily workflow, just after midnight).

The open BC Ferries API (bcferriesapi.ca, unofficial, MIT) only gives today's sailings, so each
run adds today to a rolling record. The app shows a day it has no record of from the most
recent day of the same weekday, and says so. The app also asks the API live when it's online.

  python tools/build_ferries.py            # ask the API
  python tools/build_ferries.py saved.json # or use a saved reply
"""
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

API = 'https://www.bcferriesapi.ca/v2/noncapacity/'
ROOT = Path(__file__).resolve().parent.parent
KEEP_DAYS = 21

# Salt Spring's three terminals: Fulford Harbour (FUL), Vesuvius Bay (VES), Long Harbour (PLH)
ISLAND = ('FUL', 'VES', 'PLH')

NAMES = {
    'FUL': 'Fulford Harbour', 'VES': 'Vesuvius Bay', 'PLH': 'Long Harbour',
    'SWB': 'Swartz Bay', 'CFT': 'Crofton', 'TSA': 'Tsawwassen',
    'POB': 'Otter Bay (Pender)', 'PVB': 'Village Bay (Mayne)', 'PSB': 'Sturdies Bay (Galiano)',
    'PST': 'Lyall Harbour (Saturna)',
}


def to_min(t):
    m = re.match(r'\s*(\d{1,2}):(\d{2})\s*([ap])m', t or '', re.I)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3).lower()
    if h == 12:
        h = 0
    if ap == 'p':
        h += 12
    return h * 60 + mi


def dur_min(s):
    if not s:
        return None
    m = re.match(r'^(\d+):(\d+)$', s.strip())
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    h = re.search(r'(\d+)\s*h', s)
    mi = re.search(r'(\d+)\s*m', s)
    total = (int(h.group(1)) * 60 if h else 0) + (int(mi.group(1)) if mi else 0)
    return total or None


SEASONAL = ROOT / 'data' / 'ferry-seasonal.txt'
DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
ROW = re.compile(r'(\d{1,2}:\d{2}[ap])>(\d{1,2}:\d{2}[ap])?(?:\[([^\]]*)\])?')


def short_island(name):
    return re.sub(r' Island \(.*\)$', '', name.strip())


def parse_seasonal(text):
    """data/ferry-seasonal.txt -> {code: {from, to, page, days: {mon: [sailing, ...]}}}"""
    out, cur = {}, None
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        head = re.match(r'^([A-Z]{6})\s*\|\s*(.+?)\s*-\s*(.+?)\s*(?:\|\s*(\S+))?$', line)
        if head:
            code, a, b, page = head.groups()
            cur = out[code] = {
                'from': datetime.strptime(a.strip(), '%b %d, %Y').date().isoformat(),
                'to': datetime.strptime(b.strip(), '%b %d, %Y').date().isoformat(),
                'page': f'https://www.bcferries.com/routes-fares/schedules/seasonal/{page}' if page else '',
                'days': {},
            }
            continue
        m = re.match(r'^([a-z,]+):\s*(.*)$', line)
        if not m or cur is None:
            raise ValueError(f'ferry-seasonal.txt line {n}: cannot read "{line[:60]}"')
        rows = []
        for dep, arr, notes in ROW.findall(m.group(2)):
            row = {'dep': to_min(dep + 'm')}
            if arr:
                row['arr'] = to_min(arr + 'm')
            via = []
            for note in (notes.split('|') if notes else []):
                note = note.strip()
                if note == 'DG':
                    row['dg'] = True
                elif note.startswith('Stop '):
                    via.append(short_island(note[5:]))
                elif note.startswith('Transfer '):
                    via.append(short_island(note[9:]) + ' (change boats)')
            if via:
                row['via'] = via
            rows.append(row)
        for d in m.group(1).split(','):
            if d not in DAY_KEYS:
                raise ValueError(f'ferry-seasonal.txt line {n}: unknown day "{d}"')
            cur['days'][d] = sorted(rows, key=lambda r: r['dep'])
    return out


def trim(text, n=1600):
    text = re.sub(r'\n{3,}', '\n\n', (text or '').strip())
    return text if len(text) <= n else text[:n].rsplit(' ', 1)[0] + '…'


def main(src=None):
    raw = Path(src).read_text(encoding='utf-8') if src else urllib.request.urlopen(
        urllib.request.Request(API, headers={'User-Agent': 'ssi-transit-pwa'}), timeout=60).read().decode('utf-8')
    api = json.loads(raw)
    dest = ROOT / 'data' / 'ferries.json'
    old = json.loads(dest.read_text(encoding='utf-8')) if dest.exists() else {'routes': {}}

    routes = json.loads(json.dumps(old.get('routes', {})))   # a copy, so the change check below sees the difference
    for r in api.get('routes', []):
        code = r.get('routeCode', '')
        a, b = r.get('fromTerminalCode', ''), r.get('toTerminalCode', '')
        if a not in ISLAND and b not in ISLAND:
            continue
        rec = routes.setdefault(code, {'from': a, 'to': b, 'days': {}})
        rec['fromName'] = NAMES.get(a) or (r.get('terminal') or {}).get('name') or a
        rec['toName'] = NAMES.get(b, b)
        rec['source'] = r.get('sourceURL', '')
        rec['notices'] = [{'title': (n.get('title') or '').strip(), 'body': trim(n.get('body'))}
                          for n in (r.get('notices') or [])]
        day = r.get('serviceDate')
        status = r.get('dataStatus')
        if not day or status not in ('available', 'no-service'):
            continue   # a failed scrape must not wipe a good day
        sailings = []
        for s in r.get('sailings') or []:
            dep = to_min(s.get('scheduledTime') or s.get('time'))
            if dep is None:
                continue
            arr = to_min(s.get('arrivalTime'))
            stops = [x.get('terminalName') for x in (s.get('stops') or []) if x.get('type') == 'stop']
            row = {'dep': dep}
            if arr is not None:
                row['arr'] = arr
            if stops:
                row['via'] = stops
            if s.get('status') == 'cancelled':
                row['cancelled'] = True
            sailings.append(row)
        sailings.sort(key=lambda x: x['dep'])
        rec['days'][day] = {'sailings': sailings, 'noService': status == 'no-service'}
        d = dur_min(r.get('sailingDuration'))
        if d:
            rec['duration'] = d

    if SEASONAL.exists():
        for code, sea in parse_seasonal(SEASONAL.read_text(encoding='utf-8')).items():
            rec = routes.setdefault(code, {'from': code[:3], 'to': code[3:], 'days': {},
                                           'fromName': NAMES.get(code[:3], code[:3]), 'toName': NAMES.get(code[3:], code[3:])})
            rec['seasonal'] = sea

    cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    for rec in routes.values():
        rec['days'] = {d: v for d, v in sorted(rec['days'].items()) if d >= cutoff}

    out = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': API,
           'names': NAMES, 'routes': dict(sorted(routes.items()))}
    if {k: v for k, v in old.items() if k != 'generated'} == {k: v for k, v in out.items() if k != 'generated'}:
        print('ferries: unchanged')
        return
    dest.write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'ferries: {len(routes)} routes, {dest.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
