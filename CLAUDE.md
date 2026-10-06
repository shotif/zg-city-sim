# ZG City Sim: notes for Claude Code

A realistic traffic simulator of Zagreb that is becoming a city builder. It covers the whole city in 3D in the browser and is deployed to GitHub Pages: <https://shotif.github.io/zg-city-sim/>.

Read these before changing anything:
- `README.md`: what it is, how to run it.
- `docs/PLAN.md`: vision, status per milestone, known gaps, roadmap.
- `docs/DATA_SOURCES.md`: every dataset with URLs, licences and quirks.
- `docs/VALIDATION.md`: the last full simulated day compared with traffic counts.

## Working agreements

- **Deploy:** push every finished, validated step to `main`. GitHub Actions builds, tests and deploys `main` to Pages. Also push your session branch. Don't open pull requests unless asked.
- **Default branch:** the repository's default branch is still `ccr-2d70b2aa-eggxc4`, and scheduled workflows (live-data) run from it.
- **Language:** English UI with Croatian place and street names, with diacritics.
- **"Live":** a calibrated typical weekday plus live layers (road closures now; ZET vehicle positions and weather later).
- **Commits:** an imperative subject and a body that says why, using bullets for lists. End with the attribution lines your environment gives. Never put model names in commits, code or docs.
- **Writing:** plain, concrete British English for docs and UI text. Give numbers with units. Say what is estimated or guessed, and from what.

## Layout

| Path | What |
|---|---|
| `pipeline/` | Python data pipeline (`python -m pipeline <steps>`). Steps, in order: `terrain`, `ground`, `network` (OSM → SUMO netconvert → packed arrays, `simnet.py`), `buildings`, `demand` (residents, jobs, gateways), `transit` (ZET GTFS), `news`. Output goes to `web/public/data/`. |
| `pipeline/counts.py` | Hrvatske ceste count stations (2025), read from `pipeline/data/hc_counts_2025.json`, with working-day estimates. |
| `pipeline/hc.py` | Tool, run by hand: downloads Hrvatske ceste's tables and PDF, places the stations on OSM roads by road number and section, reads the hourly and weekday charts, and writes `hc_counts_2025.json`. Never commit the PDF. |
| `pipeline/census.py` | Tool, run by hand: DZS 2021 population by settlement for the counties around the City (`pipeline/data/census_2021_settlements.json`). |
| `pipeline/gateways.py` | Traffic across the map's edge: counted sections crossing it, else typical volumes. |
| `pipeline/validate.py` | Writes `docs/VALIDATION.md` from a day run. |
| `pipeline/data/news.json` | Curated news reports of jams (39 places). |
| `sim/` | Rust traffic engine, compiled to WebAssembly (C ABI in `ffi.rs`) and run natively. |
| `sim/src/engine.rs` | Vehicles, IDM/MOBIL, junction right of way, signals (`merge_signal_phases`, `retime_signals`, actuated control), routing calls, closures, statistics. |
| `sim/src/network.rs` | The network built from the packed arrays: routing successors, toll time. |
| `sim/src/router.rs` | ALT A* with weighted heuristic. |
| `sim/src/demand.rs` | Trip generation: `HOURLY` profile, gravity model, gateways. |
| `sim/src/transit.rs` | Trams and buses on timetable. |
| `sim/src/tests.rs` | Engine tests on hand-built networks. |
| `sim/examples/` | `run.rs` (a few hours, prints where vehicles get stuck) and `day.rs` (a whole weekday, for validation). |
| `web/` | TypeScript, Vite, three.js app. `src/sim/` holds the worker, protocol and wasm wrapper; `src/world/` the layers (roads, buildings, vehicles, traffic map, closures, news); `src/ui/` the HUD and panels; `src/camera/` the views. |
| `.github/workflows/` | `deploy.yml` (build, test, deploy main) and `live-data.yml` (copies the City's closures feed to the `live-data` branch every 15 minutes). |

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
```

Environment variables for the native runs:
- `DEMAND_SCALE=0.7` overrides the calibrated share of demand.
- `DEBUG_EDGES=123,456` logs the vehicles removed from those edges, with what they see ahead.
- Also `NO_GATEWAYS`, `DUMP_QUEUES=file` and `DEBUG_TELEPORT`.

## Things that bite

- **Generated data:** `web/public/data/` is generated and gitignored. CI rebuilds it from scratch on every push.
- **Stale data in native runs:** the native runners read the unpacked `.bin` files. After rebuilding data, unpack again with `gunzip -kf`, or they quietly run on the old network.
- **Ids change with the network:** rebuilding the network with different netconvert options renumbers edges, lanes and links. Validate a day run against the network it ran on: `validate.py` checks the edge count.
- **Day runs are slow:** a full simulated day takes about an hour on one core. To compare variants, run them in parallel, each built into its own `CARGO_TARGET_DIR`, so rebuilding never touches a running binary.
- **Runs vary:** under congestion, results differ from run to run. Compare whole days, and change one thing at a time where you can.
- **Process matching:** `pkill -f` and `pgrep -f` with a pattern that also appears in your own command line match your shell and can kill it. Use `pgrep -x day` or PIDs.
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
| Stuck-vehicle removal (`STUCK_TIME`) | `sim/src/engine.rs` | 300 s |
| Driver parameters | `sim/src/vtype.rs` | |
