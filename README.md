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
| `pipeline/` | Python data pipeline: downloads open data and builds the static assets the app loads |
| `docs/` | Plan and design notes |

## Running locally

Requirements: Node.js 22+, Python 3.12+.

```bash
# 1. Build the data (downloads ~100 MB on first run, cached in pipeline/.cache)
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pipeline all

# 2. Run the app
cd web
npm install
npm run dev
```

Then open the URL Vite prints.

## Controls

| Action | Mouse | Touch | Keys |
|---|---|---|---|
| Pan | Left drag | One finger | Arrow keys |
| Zoom | Wheel | Pinch | |
| Rotate / tilt (3D view) | Right drag | Two fingers | |
| Switch view | Buttons at the top | | `1` map, `2` isometric, `3` 3D |
| Rotate isometric view | ⟲ ⟳ buttons | | `Q` / `E` |

## Data and attribution

The app uses open data; see the in-app attribution panel and [docs/PLAN.md](docs/PLAN.md#data-sources).
