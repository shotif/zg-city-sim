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
| `pipeline/` | Python data pipeline (`python -m pipeline <steps>`). Steps, in order: `terrain`, `ground`, `network` (OSM → SUMO netconvert → packed arrays, `simnet.py`), `buildings`, `demand` (residents, jobs, gateways), `transit` (ZET's and HŽ's GTFS), `pedestrians` (crossings on the drivable roads and pedestrians a day, M8c), `cycling` (roads with a cycle track or lane, and where the City's bike trips start and end, M8d), `news`, `zoning` (lots for zoning along streets, the City's planned land use), `projects`. Output goes to `web/public/data/`. |
| `pipeline/counts.py` | Hrvatske ceste count stations (2025), read from `pipeline/data/hc_counts_2025.json`, with working-day estimates. |
| `pipeline/hc.py` | Tool, run by hand: downloads Hrvatske ceste's tables and PDF, places the stations on OSM roads by road number and section, reads the hourly and weekday charts, and writes `hc_counts_2025.json`. Never commit the PDF. |
| `pipeline/census.py` | Tool, run by hand: DZS 2021 population by settlement for the counties around the City (`pipeline/data/census_2021_settlements.json`). |
| `pipeline/gateways.py` | Traffic across the map's edge: counted sections crossing it, else typical volumes. |
| `pipeline/peak.py` | Tool, run by hand with the validation runs: the roads' speeds from 07:00 to 09:00 in day runs, kept by position in `pipeline/data/peak_speeds.json`, which the network step matches to edges (`edgePeak`) for the riders' car journeys (M10d). |
| `pipeline/validate.py` | Writes `docs/VALIDATION.md` from a day run, with the junctions that hold up most traffic (from the day runner's `junction_delay.bin`). |
| `pipeline/projects.py` | Planned road projects (M4c): each a patch over the OSM extract (proposed or construction ways opened, ends carried across roads, signals, bridges), built by netconvert into a network of its own with demand, transit and news (`web/public/data/projects/<id>/`, about 3 min each). `python -m pipeline.projects compare` writes their before and after numbers to `pipeline/data/projects/<id>.json`. |
| `pipeline/zoning.py` | Lots for zoning (M5a): free land along streets, 20 m by 30 m, kept off buildings, roads, water and the land the City's plan keeps open; each lot's street, planned use and the storeys around it. The plan's polygons for the app's map. |
| `pipeline/data/news.json` | Curated news reports of jams (39 places). |
| `sim/` | Rust traffic engine, compiled to WebAssembly (C ABI in `ffi.rs`) and run natively. |
| `sim/src/engine.rs` | Vehicles, IDM/MOBIL, junction right of way, signals (`merge_signal_phases`, `retime_signals`, actuated control), routing calls, re-routing on the way (`reroute_en_route`), closures, statistics. |
| `sim/src/network.rs` | The network built from the packed arrays: routing successors, toll time, where turns wait inside junctions (`waits_for`). |
| `sim/src/router.rs` | ALT A* with weighted heuristic; `reach`, the time-limited search behind land value's accessibility (`Engine::reach`). |
| `sim/src/demand.rs` | Trip generation: `HOURLY` profile, gravity model, gateways. |
| `sim/src/weather.rs` | The weather's factors on desired speed, headway and acceleration (M6b). |
| `sim/src/transit.rs` | Trams, buses and trains on timetable; lines run more or less often by frequency edits (M9b: trips cancelled, or copies of them appended to the timetable); new lines' trips (M9c). |
| `sim/src/pedestrians.rs` | Pedestrians at crossings (M8c): arrivals by the hour, zebras, walking with a junction's signals, crossings with signals of their own. |
| `sim/src/riders.rs` | Public transport's riders (M9d): 1 km zones, journeys between them from the timetable as it runs in the morning peak (frequency-based), the logit split with the car, boardings by route, and the factors that move car trips when edits change public transport. |
| `pipeline/cycling.py` | Cycle tracks and lanes (M8d): the City's and OSM's, matched to the roads they run along (`edgeCycleway`); bike trip ends by the City's homes and jobs. |
| `pipeline/data/bike_counts_2014.json` | The City's 2014 bike counts at 7 places, for the validation report (M8d). |
| `sim/src/patch.rs` | Swapping in a network with roads drawn while traffic runs (`Engine::replace_network`, `LanePiece`). |
| `sim/src/tests.rs` | Engine tests on hand-built networks. |
| `sim/examples/` | `run.rs` (a few hours, prints where vehicles get stuck; `--features profile` times each phase and the route searches), `day.rs` (a whole weekday, for validation, with the delay queued at each junction by cause), `compare.rs` (one network through the morning peak, for a project's before and after), `routes.rs` (times route searches, and how much longer routes get with other heuristic weights) and `riders.rs` (public transport's riders today, and the constant calibrated to the Transport Master Plan's split). |
| `web/` | TypeScript, Vite, three.js app. `src/sim/` holds the worker, protocol and wasm wrapper; `src/world/` the layers (terrain in tiles coarser with distance, roads, buildings, vehicles and their models, traffic map, closures, news, edits, the sun, daylight and night lights, the weather); `src/edit/` the edit model, road index, comparisons, projects, the junction builder (`builder.ts`: roads drawn, with tram tracks if asked, roundabouts and signal programs, built into the network the engine runs), the junctions' movements for the signal editor (`signals.ts`) and new public transport lines' stops (`lines.ts`); `src/grow/` the game layer (M5: lots, zones and brush strokes, the Zones tool, buildings that grow and the homes and jobs they add to the traffic's demand, land value and demand per zone, the budget); `src/ui/` the HUD, panels (stations and level crossings on the traffic map: `railMarkers.ts`; the Public transport panel: `transitPanel.ts`, over the timetable in `src/world/transitLines.ts`), sound and the `?perf` overlay; `src/camera/` the views. |
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
python -m pipeline.peak /tmp/day /tmp/day2                                        # the roads' peak speeds for car journeys (M10d)
# A project's before and after (06:00-10:00): today's network with two seeds, then the project's
cd sim && cargo run --release --example compare -- ../web/public/data /tmp/today.json 6 4 1   # and seed 2
cargo run --release --example compare -- ../web/public/data/projects/<id> /tmp/p.json       # gunzip its .bin.gz first
cd .. && python -m pipeline.projects compare <id> /tmp/p.json /tmp/today.json /tmp/today2.json
```

Environment variables for the native runs:
- `DEMAND_SCALE=0.8` overrides the calibrated share of demand.
- `DEBUG_EDGES=123,456` logs the vehicles removed from those edges, with what they see ahead.
- `SEED=2` (the `day` and `run` examples) runs the same day with another seed, to see how much days vary.
- `GRAVITY_KM=5` and `GATEWAY_LOCAL_KM=8` (the `day` and `run` examples) set the distance decay of trips within the map and across its edge on roads other than motorways, to calibrate them.
- `WATCH_JUNCTIONS=51800,51531` (the `run` example) prints those junctions' signal programs as the engine runs them, then every simulated minute the stopped front vehicle of each queue into them: why it waits, who it gives way to, and what holds up the vehicles inside the junction.
- `NO_PHASE_SKIP=1` (the `day` and `run` examples) runs actuated signals through every phase, as before M7d.
- `NO_REROUTE=1` (the `day` and `run` examples) keeps drivers on the route they chose at the start, as before M7g.
- `NO_PEDESTRIANS=1` (the `day`, `run` and `compare` examples) leaves pedestrians out, as before M8c; `PEDESTRIAN_SCALE=0.5` lets half of the estimated pedestrians arrive.
- `NO_BIKES=1` (the `day`, `run` and `compare` examples) leaves bikes out, as before M8d; `BIKE_SCALE=0.5` runs half of the estimated bike trips.
- `FREQUENCY=2` (the `run`, `day` and `riders` examples) runs every tram and bus line that many times as often (M9b), moving car trips to public transport (M9d).
- `FREQUENCY_MODES=tram` (or `bus`), with `FREQUENCY`, changes only that mode's lines; `FREQUENCY_ROUTES=5` only those routes (the timetable's indices: tram 6 is 5).
- `PRIORITY=all` (the `run` and `day` examples) gives trams and buses signal priority at every signal they cross (M10b); `PRIORITY=5` along those routes.
- `TRAM_HOLDUPS=1` (the `run` example) prints at the end where trams stood still off their stops and why, and how late buses and trams ran; `WATCH_LANES=462508` prints the vehicles on those lanes every 5 simulated minutes.
- Also `NO_GATEWAYS`, `DUMP_QUEUES=file` and `DEBUG_TELEPORT`.

## Things that bite

- **Generated data:** `web/public/data/` is generated and gitignored. CI rebuilds it from scratch on every push.
- **Stale data in native runs:** the native runners read the unpacked `.bin` files. After rebuilding data, unpack again with `gunzip -kf`, or they quietly run on the old network.
- **Drawn roads keep ids:** the junction builder builds every network from the one loaded, so lanes, edges and junctions loaded keep their ids and drawn ones come after. The engine is told where each lane went (`lanePieces`); keep that invariant when changing either side. Links taken away (a junction made a roundabout, movements closed by the signal editor) are left out of the arrays, so link ids are not stable: the engine matches them again by the lanes they join.
- **Demand changes at runtime:** buildings grown on zoned lots add homes and jobs: the app sends today's `demand*` arrays merged with them (`zg_set_demand`), so the engine's demand weights can differ from the data loaded. Lots name today's edges; with a project open they are matched by position.
- **Player-set signals:** programs the player sets carry `tlsFixed`; `merge_signal_phases`, `retime_signals`, actuated extension and phase skipping leave them alone.
- **The network is built twice:** netconvert joins road junctions but not the tram-only junctions inside them, so `build_sumo_network` runs it once to find them (`tram_joins`), then again with them joined (`zagreb_<key>.joins.nod.xml` in the cache). Projects reuse today's joins.
- **Project comparisons are noisy:** two runs of today's roads with other seeds differ by about 16 % in delay over the morning peak. Compare roads near a project, not the whole network, and use the mean of two runs of today.
- **Peak speeds:** car journeys for the riders use the roads' speeds in the morning peak from day runs (`pipeline/data/peak_speeds.json`). After a change that moves traffic a lot, refresh them with `python -m pipeline.peak` on the new day runs, rebuild the network and calibrate `ASC` again with the `riders` example.
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
| Share of estimated demand simulated (`DEMAND_SCALE`) | `pipeline/demand.py` | 0.7 |
| Car trips per resident (`CAR_TRIP_RATE`) | `pipeline/demand.py` | 0.65 in the City, 0.87 in the counties around it, 1.0 in Krapina-Zagorje |
| Hourly profile and trip purposes (`HOURLY`, `purposes`) | `sim/src/demand.rs` | measured at 33 count stations (2025) |
| Gravity decay | `sim/src/demand.rs` | 4 km |
| Gateway decay (`GATEWAY_DECAY`, `LOCAL_GATEWAY_DECAY`) | `sim/src/demand.rs` | 12 km on motorways and expressways (8 candidates), 8 km on other roads (128 candidates) |
| Inbound lead | `sim/src/demand.rs` | 45 min |
| Toll time (`TOLL_TIME`) | `sim/src/network.rs` | 0.018 s/m |
| Signal re-timing (`MIN_GREEN`, `LONG_CYCLE`, `MAX_EXTENSION`, `TRAM_TRACK_SHARE`) | `sim/src/engine.rs` | 6 s, 120 s, 20 s, 0.25 |
| Phase skipping: lanes too short to show a call (`CALL_LANE`, plus a tram where trams run) | `sim/src/engine.rs` | 20 m (52 m) |
| Tram junctions joined into road junctions within (`TRAM_JOIN_DIST`) | `pipeline/network.py` | 3 m |
| Speed limits where OSM has none (`default_maxspeed`, `BUILT_UP_SHARE`) | `pipeline/network.py` | 50 km/h where a quarter of the land along the road is built up (ESA WorldCover) or it is named a street or square; 90 km/h outside on primary and secondary roads |
| Room to change lanes: lane choice looks past shorter roads (`LANE_CHANGE_ROOM`, `LANE_CHANGE_SECONDS`) | `sim/src/engine.rs` | 150 m, or 10 s at the speed limit if longer |
| Re-routing on the way (`REROUTE_CHECK`, `REROUTE_SLOWER`, `REROUTE_LOSS`, `REROUTE_GAIN`, `REROUTE_GAIN_TIME`, `REROUTE_LANE_ROOM`) | `sim/src/engine.rs` | every 60 s, when the rest takes 25 % and 60 s longer than expected; a new way that saves 10 % and 60 s; 100 m to change lanes |
| Stuck-vehicle removal (`STUCK_TIME`) | `sim/src/engine.rs` | 300 s |
| Signal priority (`PRIORITY_AHEAD`, `PRIORITY_EXTENSION`, `MIN_GREEN`; `PRIORITY_JUNCTION`, `PRIORITY_UPKEEP`) | `sim/src/engine.rs`, `web/src/grow/economy.ts` | asked 20 s ahead; its green up to 15 s longer, others cut to 6 s; €15,000 a junction and €600 a year (estimates) |
| Buses and trams at stops (`MIN_DWELL`, `PLATFORM`) | `sim/src/engine.rs` | at least 15 s (buses) or 20 s (trams) a stop; a second bus within 20 m, or tram within 36 m, behind one at the stop serves it there (estimates) |
| Pedestrians a day per crossing (`USES_PER_PERSON`, `WALKERS_PER_STOP`, `HOURLY`) | `pipeline/pedestrians.py` | 0.3 uses a day per resident or job beside a crossing, falling to none at 400 m; 6 per bus or tram stopping within 150 m (estimates) |
| Pedestrians crossing (`WALK_SPEED`, `MIN_WALK`, `OWN_SIGNAL_GAP`) | `sim/src/pedestrians.rs` | 1.2 m/s plus 2 s to step off; at signals at least 5 s of walk before the clearance; own signals red at most once a minute |
| Public transport's riders (`ZONE`, `PEAK`, `ACCESS`, `TRANSFER`, `WALK_WEIGHT`, `WAIT_WEIGHT`, `BOARDING`, `CAR_TERMINAL`, `CAR_SPEED`, `CAR_EXTRA`, `BETA`, `ASC`; `FARE`) | `sim/src/riders.rs`, `web/src/grow/economy.ts` | 1 km zones; 06:30-08:30; stops within 1 km, changes within 250 m; walking and waiting count twice, 3 min a boarding; cars on the roads at their peak speeds (`edgePeak`, 95 % of the limit where not known) plus 5 min (`CAR_TERMINAL`), else 30 km/h plus 8 min; 0.04 a generalised minute, constant 1.717 (45.8 % of motorised trips in the City); riders take the first of the lines worth taking between two stops (common lines); fares €0.21 a boarding |
| Bike trips (`BIKE_TRIPS_DAILY`, `BIKE_DECAY`) | `pipeline/cycling.py`, `sim/src/demand.rs` | 42,000 a weekday in the City, all simulated whatever the cars' share; 2 km decay |
| Cycle tracks on roads (`ALONG`, `SHARE`) | `pipeline/cycling.py` | a cycle line within 12 m alongside half a road's length |
| Bikes' routes and speed (`MIXED_ROAD`, `BUSY_ROAD`, `vtype::BIKE`) | `sim/src/engine.rs`, `sim/src/vtype.rs` | roads without a cycle track count 1.15 times as long (one lane each way) or 1.5 times (more); 18 km/h times each rider's speed factor |
| Level crossings (`CROSSING_LEAD`, `CROSSING_WARN`, `CROSSING_RISE`) | `sim/src/engine.rs` | close when a train is 30 s away (an estimate), lights 5 s before the barriers, open 5 s after it has cleared |
| Driver parameters | `sim/src/vtype.rs` | |
| Weather factors on driving (`Weather::RAIN`, …) | `sim/src/weather.rs`, mirrored in `web/src/world/weather.ts` | rain 0.95 speed, 1.1 headway, 0.95 acceleration; heavy snow 0.65, 1.4, 0.65 |
| Growth rate (`START_RATE`), people per floor area | `web/src/grow/growth.ts` | 2 % of empty zoned lots a minute; 30 m² a resident, 20/35/80-120 m² a job |
| Land value (`REACH_DECAY`, `REACH_MAX`, `ACCESS_POWER`, `GREEN_BONUS`, `NOISE_LOSS`) | `web/src/grow/landValue.ts` | 6 min, 20 min, 0.75, 10 %, 0.6 %/dB above 55 dB(A) |
| Demand per zone (`BASE_DEMAND`, `SWING`) | `web/src/grow/zoneDemand.ts` | homes 0.4, shops 0.2, work 0.3; 2,000 people |
| Money (`BASE_INCOME`, `INCOME_TAX`, `LANE_KM`, `BRIDGE_M2`, `UPKEEP_LANE_KM`, …) | `web/src/grow/economy.ts` | a year a simulated day; sources in `docs/DATA_SOURCES.md` section 9 |
| Lines run more or less often (`FREQUENCY_RANGE`, `MAX_GAP`; `VEHICLE_KM`, `SERVICE_DAYS`) | `sim/src/transit.rs`, `web/src/grow/economy.ts` | 0-3 times as often, trips added only in gaps of up to 2 h; €7.00 a tram-km and €4.90 a bus-km, a weekday's change 244 (trams) or 308 (buses) times a year |
| New lines (`LINE_PACE`, `LINE_DWELL`, `LINE_HEADWAY`; `SNAP_STOP`, `STOP_REACH`; `TRAM_TRACK_KM`) | `sim/src/transit.rs`, `web/src/edit/lines.ts`, `web/src/grow/economy.ts` | timed at the speed limit times 1.5 plus 20 s a stop; every 2 min to 2 h; stops take a stop within 60 m, else a road within 40 m; tram tracks €4.2 million a km both ways |
