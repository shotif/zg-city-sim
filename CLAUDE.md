# ZG City Sim: notes for Claude Code

A realistic traffic simulator of Zagreb that is becoming a city builder. It covers the whole city in 3D in the browser and is deployed to GitHub Pages: <https://shotif.github.io/zg-city-sim/>.

Read these before changing anything:
- `README.md`: what it is, how to run it.
- `docs/PLAN.md`: vision, status per milestone, known gaps, roadmap.
- `docs/DATA_SOURCES.md`: every dataset with URLs, licences and quirks.
- `docs/VALIDATION.md`: the last full simulated day compared with traffic counts.

## Working agreements

- **Deploy:** push every finished, validated step to `main`. GitHub Actions builds, tests and deploys `main` to Pages. Also push your session branch. Don't open pull requests unless asked.
- **Default branch:** `main` (since 2026-10-07); scheduled workflows (live-data) run from it.
- **Language:** English UI with Croatian place and street names, with diacritics.
- **"Live":** a calibrated typical weekday plus live layers (road closures and the weather; live ZET vehicle positions are skipped for now).
- **Commits:** an imperative subject and a body that says why, using bullets for lists. End with the attribution lines your environment gives. Never put model names in commits, code or docs.
- **Writing:** plain, concrete British English for docs and UI text. Give numbers with units. Say what is estimated or guessed, and from what.

## Layout

| Path | What |
|---|---|
| `pipeline/` | Python data pipeline (`python -m pipeline <steps>`). Steps, in order: `terrain`, `ground`, `network` (OSM → SUMO netconvert → packed arrays, `simnet.py`), `buildings`, `demand` (residents, jobs, gateways), `transit` (ZET GTFS), `news`, `zoning` (lots for zoning along streets, the City's planned land use), `projects`. Output goes to `web/public/data/`. |
| `pipeline/counts.py` | Hrvatske ceste count stations (2025), read from `pipeline/data/hc_counts_2025.json`, with working-day estimates. |
| `pipeline/hc.py` | Tool, run by hand: downloads Hrvatske ceste's tables and PDF, places the stations on OSM roads by road number and section, reads the hourly and weekday charts, and writes `hc_counts_2025.json`. Never commit the PDF. |
| `pipeline/census.py` | Tool, run by hand: DZS 2021 population by settlement for the counties around the City (`pipeline/data/census_2021_settlements.json`). |
| `pipeline/gateways.py` | Traffic across the map's edge: counted sections crossing it, else typical volumes. |
| `pipeline/validate.py` | Writes `docs/VALIDATION.md` from a day run, with the junctions that hold up most traffic (from the day runner's `junction_delay.bin`). |
| `pipeline/projects.py` | Planned road projects (M4c): each a patch over the OSM extract (proposed or construction ways opened, ends carried across roads, signals, bridges), built by netconvert into a network of its own with demand, transit and news (`web/public/data/projects/<id>/`, about 3 min each). `python -m pipeline.projects compare` writes their before and after numbers to `pipeline/data/projects/<id>.json`. |
| `pipeline/zoning.py` | Lots for zoning (M5a): free land along streets, 20 m by 30 m, kept off buildings, roads, water and the land the City's plan keeps open; each lot's street, planned use and the storeys around it. The plan's polygons for the app's map. |
| `pipeline/data/news.json` | Curated news reports of jams (39 places). |
| `sim/` | Rust traffic engine, compiled to WebAssembly (C ABI in `ffi.rs`) and run natively. |
| `sim/src/engine.rs` | Vehicles, IDM/MOBIL, junction right of way, signals (`merge_signal_phases`, `retime_signals`, actuated control), routing calls, closures, statistics. |
| `sim/src/network.rs` | The network built from the packed arrays: routing successors, toll time, where turns wait inside junctions (`waits_for`). |
| `sim/src/router.rs` | ALT A* with weighted heuristic; `reach`, the time-limited search behind land value's accessibility (`Engine::reach`). |
| `sim/src/demand.rs` | Trip generation: `HOURLY` profile, gravity model, gateways. |
| `sim/src/weather.rs` | The weather's factors on desired speed, headway and acceleration (M6b). |
| `sim/src/transit.rs` | Trams and buses on timetable. |
| `sim/src/patch.rs` | Swapping in a network with roads drawn while traffic runs (`Engine::replace_network`, `LanePiece`). |
| `sim/src/tests.rs` | Engine tests on hand-built networks. |
| `sim/examples/` | `run.rs` (a few hours, prints where vehicles get stuck; `--features profile` times each phase and the route searches), `day.rs` (a whole weekday, for validation, with the delay queued at each junction by cause), `compare.rs` (one network through the morning peak, for a project's before and after) and `routes.rs` (times route searches, and how much longer routes get with other heuristic weights). |
| `web/` | TypeScript, Vite, three.js app. `src/sim/` holds the worker, protocol and wasm wrapper; `src/world/` the layers (terrain in tiles coarser with distance, roads, buildings, vehicles and their models, traffic map, closures, news, edits, the sun, daylight and night lights, the weather); `src/edit/` the edit model, road index, comparisons, projects, the junction builder (`builder.ts`: roads drawn, roundabouts and signal programs, built into the network the engine runs) and the junctions' movements for the signal editor (`signals.ts`); `src/grow/` the game layer (M5: lots, zones and brush strokes, the Zones tool, buildings that grow and the homes and jobs they add to the traffic's demand, land value and demand per zone, the budget); `src/ui/` the HUD, panels, sound and the `?perf` overlay; `src/camera/` the views. |
| `.github/workflows/` | `deploy.yml` (build, test, deploy main) and `live-data.yml` (copies the City's closures feed and DHMZ's weather in Zagreb to the `live-data` branch every 15 minutes). |

## Commands

```bash
# Pipeline (Python 3.12+; a venv lives in .venv)
python -m pipeline all                     # ~400 MB of downloads on first run, cached in pipeline/.cache
python -m pipeline network demand transit news   # after changing netconvert options
ruff check pipeline && ruff format --check pipeline && python -m pytest pipeline/tests -q

# Engine
cd sim && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

# Web
cd web && npm run format:check && npm run typecheck && npm test
npm run wasm && npm run build && npx playwright test --project=desktop   # smoke tests in headless Chromium

# Native runs on the built data
gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
cd sim && cargo run --release --example run -- ../web/public/data/network 6 270   # 06:00 for 270 min
cargo run --release --example day -- ../web/public/data /tmp/day                 # a whole weekday, about 1 h
cd .. && python -m pipeline.validate /tmp/day                                     # rewrites docs/VALIDATION.md
# A project's before and after (06:00-10:00): today's network with two seeds, then the project's
cd sim && cargo run --release --example compare -- ../web/public/data /tmp/today.json 6 4 1   # and seed 2
cargo run --release --example compare -- ../web/public/data/projects/<id> /tmp/p.json       # gunzip its .bin.gz first
cd .. && python -m pipeline.projects compare <id> /tmp/p.json /tmp/today.json /tmp/today2.json
```

Environment variables for the native runs:
- `DEMAND_SCALE=0.7` overrides the calibrated share of demand.
- `DEBUG_EDGES=123,456` logs the vehicles removed from those edges, with what they see ahead.
- `SEED=2` (the `day` and `run` examples) runs the same day with another seed, to see how much days vary.
- `WATCH_JUNCTIONS=51800,51531` (the `run` example) prints those junctions' signal programs as the engine runs them, then every simulated minute the stopped front vehicle of each queue into them: why it waits, who it gives way to, and what holds up the vehicles inside the junction.
- `NO_PHASE_SKIP=1` (the `day` and `run` examples) runs actuated signals through every phase, as before M7d.
- Also `NO_GATEWAYS`, `DUMP_QUEUES=file` and `DEBUG_TELEPORT`.

## Things that bite

- **Generated data:** `web/public/data/` is generated and gitignored. CI rebuilds it from scratch on every push.
- **Stale data in native runs:** the native runners read the unpacked `.bin` files. After rebuilding data, unpack again with `gunzip -kf`, or they quietly run on the old network.
- **Drawn roads keep ids:** the junction builder builds every network from the one loaded, so lanes, edges and junctions loaded keep their ids and drawn ones come after. The engine is told where each lane went (`lanePieces`); keep that invariant when changing either side. Links taken away (a junction made a roundabout, movements closed by the signal editor) are left out of the arrays, so link ids are not stable: the engine matches them again by the lanes they join.
- **Demand changes at runtime:** buildings grown on zoned lots add homes and jobs: the app sends today's `demand*` arrays merged with them (`zg_set_demand`), so the engine's demand weights can differ from the data loaded. Lots name today's edges; with a project open they are matched by position.
- **Player-set signals:** programs the player sets carry `tlsFixed`; `merge_signal_phases`, `retime_signals`, actuated extension and phase skipping leave them alone.
- **The network is built twice:** netconvert joins road junctions but not the tram-only junctions inside them, so `build_sumo_network` runs it once to find them (`tram_joins`), then again with them joined (`zagreb_<key>.joins.nod.xml` in the cache). Projects reuse today's joins.
- **Project comparisons are noisy:** two runs of today's roads with other seeds differ by about 16 % in delay over the morning peak. Compare roads near a project, not the whole network, and use the mean of two runs of today.
- **Ids change with the network:** rebuilding the network with different netconvert options renumbers edges, lanes and links. Validate a day run against the network it ran on: `validate.py` checks the edge count.
- **Day runs are slow:** a full simulated day takes about an hour on one core. To compare variants, run them in parallel, each built into its own `CARGO_TARGET_DIR`, so rebuilding never touches a running binary.
- **Routes are validated too:** a faster route search that picks other routes moves the day's counts (a weighted heuristic cost 3 of 13 stations within ±25 %). Check route changes with a day run against two seeds of today's.
- **Runs vary:** under congestion, results differ from run to run. Compare whole days, and change one thing at a time where you can.
- **Process matching:** `pkill -f` and `pgrep -f` with a pattern that also appears in your own command line match your shell and can kill it. Use `pgrep -x day` or PIDs.
- **Measuring speed headless:** in headless Chromium the GPU is emulated on the CPU and takes most of the cores, so frame rates mean nothing and the simulation worker runs about half as fast as it would. Count triangles and draw calls (`?perf`, `__ZG__.perf`), and time the engine natively or its WebAssembly in Node, which run at the same speed.
- **Waiting:** foreground `sleep` is blocked in the cloud environment. Wait for long runs with a background loop or the Monitor tool.
- **Network rules:** never disable TLS verification or unset `HTTPS_PROXY`. Report 403/407 denials instead of working around them.
- **Untrusted downloads:** downloaded files go in their own directory, and Python that reads them runs with `-I`.
- **Hrvatske ceste site:** it may refuse non-browser clients. Don't disguise the client without the user's say-so; ask them to download the files instead.

## Calibration knobs

| Knob | Where | Now |
|---|---|---|
| Share of estimated demand simulated (`DEMAND_SCALE`) | `pipeline/demand.py` | 0.6 |
| Car trips per resident (`CAR_TRIP_RATE`) | `pipeline/demand.py` | 0.65 in the City, 0.87 in the counties around it, 1.0 in Krapina-Zagorje |
| Hourly profile and trip purposes (`HOURLY`, `purposes`) | `sim/src/demand.rs` | measured at 33 count stations (2025) |
| Gravity decay | `sim/src/demand.rs` | 4 km |
| Gateway decay | `sim/src/demand.rs` | 12 km |
| Inbound lead | `sim/src/demand.rs` | 45 min |
| Toll time (`TOLL_TIME`) | `sim/src/network.rs` | 0.018 s/m |
| Signal re-timing (`MIN_GREEN`, `LONG_CYCLE`, `MAX_EXTENSION`, `TRAM_TRACK_SHARE`) | `sim/src/engine.rs` | 6 s, 120 s, 20 s, 0.25 |
| Phase skipping: lanes too short to show a call (`CALL_LANE`, plus a tram where trams run) | `sim/src/engine.rs` | 20 m (52 m) |
| Tram junctions joined into road junctions within (`TRAM_JOIN_DIST`) | `pipeline/network.py` | 3 m |
| Stuck-vehicle removal (`STUCK_TIME`) | `sim/src/engine.rs` | 300 s |
| Driver parameters | `sim/src/vtype.rs` | |
| Weather factors on driving (`Weather::RAIN`, …) | `sim/src/weather.rs`, mirrored in `web/src/world/weather.ts` | rain 0.95 speed, 1.1 headway, 0.95 acceleration; heavy snow 0.65, 1.4, 0.65 |
| Growth rate (`START_RATE`), people per floor area | `web/src/grow/growth.ts` | 2 % of empty zoned lots a minute; 30 m² a resident, 20/35/80-120 m² a job |
| Land value (`REACH_DECAY`, `REACH_MAX`, `ACCESS_POWER`, `GREEN_BONUS`, `NOISE_LOSS`) | `web/src/grow/landValue.ts` | 6 min, 20 min, 0.75, 10 %, 0.6 %/dB above 55 dB(A) |
| Demand per zone (`BASE_DEMAND`, `SWING`) | `web/src/grow/zoneDemand.ts` | homes 0.4, shops 0.2, work 0.3; 2,000 people |
| Money (`BASE_INCOME`, `INCOME_TAX`, `LANE_KM`, `BRIDGE_M2`, `UPKEEP_LANE_KM`, …) | `web/src/grow/economy.ts` | a year a simulated day; sources in `docs/DATA_SOURCES.md` section 9 |
