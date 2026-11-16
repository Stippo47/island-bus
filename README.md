# Island Bus

Salt Spring Island bus and ferry times on a phone, readable and offline.

Live at **https://stippo47.github.io/island-bus/** — open it in Safari, Share → Add to Home Screen. After one visit with signal it works with none.

- **Map** of every route across the full width of the screen. Buses are drawn where the timetable says they are now. Tap a stop for every bus from it; pin one to keep it at the top.
- **Today first.** It opens on today's timetable; the strip at the top shows the next two weeks (and any date), each marked Weekday, Sat, Sun or No bus.
- **Holidays.** A day that runs a different timetable (Sunday service on most stat holidays, nothing on Christmas and New Year's Day) is flagged in the strip, with a warning on the day and a "coming up" note on today.
- **Next bus.** Route cards count down to the next trip in each direction; timetables dim past trips, mark buses on the road and highlight the next one.
- **Ferries.** Fulford ⇄ Swartz Bay, Vesuvius ⇄ Crofton and Long Harbour ⇄ Tsawwassen and the Gulf Islands, with the bus that meets each sailing. Today's sailings come live from BC Ferries when there's signal (departed, late, cancelled).

Not affiliated with BC Transit or BC Ferries. Check their sites before relying on a time.

## Where the data comes from

| What | Source | How it stays current |
|---|---|---|
| Buses, stops, route shapes, holidays | BC Transit's open GTFS feed (operator 39) | `tools/build_bus.py`, nightly workflow |
| Today's ferry sailings + notices | [BC Ferries API](https://github.com/samuel-pratt/bc-ferries-api) (unofficial, MIT) | live in the app; `tools/build_ferries.py` saves each day nightly |
| Weekly ferry schedules | bcferries.com seasonal pages, copied into `data/ferry-seasonal.txt` | by hand or the weekly check below (the site blocks scripts) |
| Coastline | OpenStreetMap | `tools/build_map.py`, by hand, rarely |

The workflow `.github/workflows/update-data.yml` runs every night after midnight Pacific and commits any change; Pages republishes, and phones pick it up the next time the app opens with signal.

### Weekly ferry check

`data/ferry-seasonal.txt` holds BC Ferries' seasonal tables in a short text form (the file explains it). BC Ferries changes them every few weeks, and Long Harbour's sometimes every few days. Once a week, open each route's seasonal page (`https://www.bcferries.com/routes-fares/schedules/seasonal/SWB-FUL`, `FUL-SWB`, `CFT-VES`, `VES-CFT`, `TSA-PLH`, `PLH-TSA`), copy the current date range and times into the file, run `python tools/build_ferries.py`, and push. When a seasonal table has run out, the app falls back to the sailings saved on the same weekday and says so.

## Files

- `index.html`, `style.css`, `js/` — the app (no build step, no libraries)
- `sw.js` — offline copy; bump `VERSION` there and in `js/app.js` on every release
- `data/` — the timetables the app reads
- `tools/` — the scripts that make `data/`

Run it locally with `python -m http.server` in this folder.
