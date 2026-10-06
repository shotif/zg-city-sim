# ZG City Sim

A realistic traffic and city-building simulator of Zagreb, Croatia, running entirely in the browser.

- Whole City of Zagreb in 3D, built from open data (terrain, land cover, roads, the City's official 3D buildings).
- Live traffic simulation: cars and trucks from where people live and work, commuters and through traffic from beyond the map, ZET trams and buses on their timetable.
- Analysis: a traffic map of measured speeds, news reports of jams at 39 places, the City's live road closures, and a [validation report](docs/VALIDATION.md) against traffic counts.
- Build roads and bridges, change lanes and signals, zone new neighbourhoods, and watch traffic adapt.

See [docs/PLAN.md](docs/PLAN.md) for the vision, architecture and roadmap.

## Repository layout

| Path | What |
|---|---|
| `web/` | The browser app: TypeScript, Vite, Three.js |
| `sim/` | The traffic engine: Rust, compiled to WebAssembly for the browser and natively for tests and offline runs |
| `pipeline/` | Python data pipeline: downloads open data and builds the static assets the app loads |
| `docs/` | Plan and design notes |

## Running locally

Requirements: Node.js 22+, Python 3.12+, Rust (stable) with the WebAssembly target
(`rustup target add wasm32-unknown-unknown`).

```bash
# 1. Build the data (downloads ~400 MB on first run, cached in pipeline/.cache):
#    terrain + ground (elevation, land cover), network (OpenStreetMap -> SUMO road network),
#    buildings (City of Zagreb ZG3D model inside the City, OpenStreetMap outside),
#    demand (residents and jobs per street from buildings, census and land use; traffic
#    crossing the map's edge from Hrvatske ceste counts),
#    transit (ZET's weekday tram and bus timetable, stops placed on the network),
#    news (news reports of traffic trouble, placed on the network)
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pipeline all

# 2. Build the traffic engine and run the app
cd web
npm install
npm run wasm
npm run dev
```

Then open the URL Vite prints. Traffic starts at 07:00 on a weekday, after a few seconds of
filling the streets.

To run the engine natively on the same data (faster to iterate on, with a breakdown of where
vehicles are held up):

```bash
gunzip -k web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
cd sim
cargo test
cargo run --release --example run -- ../web/public/data/network 7 30   # 07:00, 30 minutes
```

To check the simulation against traffic counts (a full weekday takes about an hour):

```bash
cargo run --release --example day -- ../web/public/data /tmp/day
cd .. && python -m pipeline.validate /tmp/day   # writes docs/VALIDATION.md
```

Both runners and the app simulate the calibrated share of the demand (`DEMAND_SCALE` in
`pipeline/demand.py`, 60 % for now; see the validation report). Set `DEMAND_SCALE=1` in the
environment to run all of it natively.

## Controls

| Action | Mouse | Touch | Keys |
|---|---|---|---|
| Pan | Left drag | One finger | Arrow keys |
| Zoom | Wheel | Pinch | |
| Rotate / tilt (3D view) | Right drag | Two fingers | |
| Switch view | Buttons at the top | | `1` map, `2` isometric, `3` 3D |
| Rotate isometric view | ⟲ ⟳ buttons | | `Q` / `E` |
| Pause / resume traffic | ⏸ button | | `Space` |
| Traffic speed | 1× 4× 16× 64× buttons | | `+` / `-` |
| Traffic map (roads coloured by speed) | Traffic map button | | `T` |
| News reports of jams, roadworks and closures | News reports button, then a marker | | `N`, `Esc` closes |
| Live road closures (on by default) | Closures button | | `C` |

## Data and attribution

The app uses open data; see the in-app attribution panel and [docs/PLAN.md](docs/PLAN.md#data-sources).
