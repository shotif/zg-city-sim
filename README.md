# ZG City Sim

A realistic traffic and city-building simulator of Zagreb, Croatia, running entirely in the browser.

- Whole City of Zagreb in 3D, built from open data (terrain, land cover, roads, the City's official 3D buildings).
- Live traffic simulation: cars, trucks, ZET trams and buses (from milestone M2).
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
#    buildings (City of Zagreb ZG3D model inside the City, OpenStreetMap outside)
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
gunzip -k web/public/data/network/net.bin.gz
cd sim
cargo test
cargo run --release --example run -- ../web/public/data/network 7 30   # 07:00, 30 minutes
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

## Data and attribution

The app uses open data; see the in-app attribution panel and [docs/PLAN.md](docs/PLAN.md#data-sources).
