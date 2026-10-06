# ZG City Sim

A realistic traffic and city-building simulator of Zagreb, Croatia, running entirely in the browser.

- Whole City of Zagreb in 3D, built from open data (terrain, land cover, roads, the City's official 3D buildings).
- Live traffic simulation: cars and trucks from where people live and work, commuters and through traffic from beyond the map, ZET trams and buses on their timetable.
- Analysis: a traffic map of measured speeds, news reports of jams at 39 places, the City's live road closures, and a [validation report](docs/VALIDATION.md) against traffic counts.
- Build: draw new roads and bridges, close roads and lanes, change speed limits, make bus lanes, ban turns and change green times at traffic lights, and traffic re-plans its routes within a minute. Edits are kept in the browser and can be shared as a link or a file. Before and after runs the day again with the edits next to today's roads and compares delay, speeds, travel times between districts and traffic per road.
- Planned projects: Jarunski most, Šarengradska ulica, Branimirova's extension to Sesvete and the A11's link into Sarajevska cesta, each on a road network of its own, with simulated before and after numbers. Zoning comes next (see the plan).

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
#    news (news reports of traffic trouble, placed on the network),
#    projects (planned roads, each built into a network of its own with the above on it)
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
gunzip -kf web/public/data/{network/net,demand/demand,transit/transit}.bin.gz
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

To work out a planned project's before and after numbers (the morning peak, 06:00-10:00, about
half an hour per run), run today's network with two seeds and the project's network, then
summarise them into `pipeline/data/projects/<id>.json`:

```bash
gunzip -kf web/public/data/projects/jarunski-most/{network/net,demand/demand,transit/transit}.bin.gz
cd sim
cargo run --release --example compare -- ../web/public/data /tmp/today.json 6 4 1
cargo run --release --example compare -- ../web/public/data /tmp/today2.json 6 4 2
cargo run --release --example compare -- ../web/public/data/projects/jarunski-most /tmp/jarun.json
cd .. && python -m pipeline.projects compare jarunski-most /tmp/jarun.json /tmp/today.json /tmp/today2.json
```

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
| Build: change a road, its lanes, turns and signals | Build button, then click a road | Build button, then tap a road | `B`, `Esc` lets go of the road |
| Build: draw a new road | Draw a road, click where it starts, along its way and where it ends, then Finish road | The same with taps | `Enter` finishes, `Backspace` removes the last point, `Esc` cancels |
| Open a planned project | Build, Planned projects, Open this project | | |

## Data and attribution

The app uses open data; see the in-app attribution panel and [docs/PLAN.md](docs/PLAN.md#data-sources).
