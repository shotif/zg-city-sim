# ZG City Sim — Project Plan

_Living document. Started 2026-10-06._

## Vision

A realistic, playable digital twin of Zagreb that runs entirely in the browser.

- **See the city live**: the whole City of Zagreb in 3D, with cars, trucks, trams and buses moving through a realistic 24-hour weekday.
- **Analyse traffic**: congestion, travel times, flows, bottlenecks, and where traffic on a given street comes from and goes to.
- **Build**: roads, bridges, lanes, traffic lights, roundabouts, tram lines. Traffic adapts immediately.
- **Grow the city**: zoning in the spirit of Cities: Skylines 2 (residential, commercial, office, industrial), with today's real Zagreb as the starting map.

Accuracy comes first. The baseline has to reproduce where and when Zagreb actually jams, and we publish how well it matches real counts instead of just claiming it.

## Decisions (brainstorm, 2026-10-06)

| Topic | Decision |
|---|---|
| Purpose | Personal project, as accurate as possible; potentially a product later |
| Area | Whole City of Zagreb (641 km², 17 districts) from day one, plus commuter and through traffic entering at the city boundary |
| "Live" | A calibrated typical day running in real time, with real live layers on top (ZET vehicles, closures, weather) |
| What moves | Cars, vans, trucks, ZET trams and buses, HŽ trains. Pedestrians and cyclists later |
| Simulation | Instant: runs in the browser; edits take effect immediately |
| Hosting | Free static hosting: GitHub Pages now; Cloudflare Pages + R2 if we outgrow it |
| Google photoreal 3D tiles | Descoped |
| Game layer | Yes, Cities: Skylines 2-like: zoning, growth, economy |

## Architecture

```
┌─────────────── Offline: pipeline + CI ───────────────┐
│ OSM · ZG3D · DEM · land cover · GTFS · census ·       │
│ counts · news                                         │
│    │                                                  │
│    ▼                                                  │
│ pipeline/ (Python) ──► compact static assets          │
│ sim/ (Rust, native) ──► calibration & validation runs │
└───────────────────────────┬──────────────────────────┘
                            ▼  static files (GitHub Pages)
┌────────────────────────── Browser ───────────────────────────┐
│ web/ (TypeScript + Three.js)     sim/ (Rust → WebAssembly)    │
│ 3D world, cameras, UI, tools ◄─► traffic engine (Web Worker)  │
└──────────────────────────────────────────────────────────────┘
```

- **`web/`**: TypeScript, Vite, Three.js (WebGPU renderer with automatic WebGL2 fallback). Rendering, camera modes, UI, build and zoning tools.
- **`sim/`** (from milestone M2): the simulation core in Rust. It is compiled to WebAssembly for the browser, where it runs in a Web Worker (multi-threaded later). It is also compiled natively for offline calibration, so the engine we calibrate is exactly the engine you play.
- **`pipeline/`**: Python. Downloads the open data and turns it into compact, tiled assets the browser streams.
- **CI**: GitHub Actions runs the pipeline, tests and build, then deploys to GitHub Pages.

### Coordinates

All data is projected to **HTRS96/TM (EPSG:3765)**, Croatia's official map projection, with the local origin at Trg bana Jelačića. Scene units are metres: `x` = east, `y` = up, `z` = south (so north is `-z`). Over the whole city, single-precision floats keep millimetre precision.

## Simulation design

**Network.** A lane-level road network built from OpenStreetMap: lanes, turn lanes, turn restrictions, speed limits, signals, tram tracks, bus lanes. The pipeline uses SUMO's `netconvert` to build it, adds hand-made fixes at critical junctions, and exports it to the engine's own compact format. In the browser, the engine's own junction builder handles everything you build or change.

**Status (M2, 2026-10-06).** The engine (`sim/`) runs the whole city in the browser:
- **Demand from buildings** (`pipeline/demand.py`): every building gets residents and jobs from its floor area (footprint × storeys) and use. The use comes from its OSM type, else the OSM land use around it, else its shape. The City's 767,131 residents (census 2021) and about 430k jobs are spread over residential and work floor area; the towns around it inside the map get about 260k residents and 80k jobs. Each building attaches to its nearest street.
- That makes 1.03M residents and about 669k car trips a weekday (1.84 trips per person × 46 % by car ÷ 1.3 per car), timed by an hourly profile. Destinations follow a gravity model: the mean car trip is about 7 km.
- **ZET trams and buses** on a weekday's GTFS timetable (13,529 trips: 3,838 tram, 9,691 bus). The pipeline places each stop on a lane of its mode in the route's direction of travel (shape-based). In the engine, each trip drives stop to stop, waits at least 15 s (bus) or 20 s (tram) at each stop and never leaves before its scheduled time. Trips already under way when the simulation starts begin at the stop they last left, so the morning service (about 150 trams, 200 buses) is on the streets at once. Trams keep to their tracks: separate edges, with SUMO's railway topology repair for tracks mapped against their direction.
- IDM car following; lane changes to reach the next turn plus MOBIL overtaking; SUMO's junction right-of-way (each link yields to its `response` links and never enters while a `foes` link's vehicle is inside); stop signs.
- No entering a junction without room behind it, looking through the sub-metre edges netconvert leaves inside junction clusters.
- Drivers who have waited 15 s push in where oncoming drivers can still brake, and drivers who could stop let long waiters go first. After a minute, drivers enter a full junction so gridlocks can unwind.
- Actuated signals from the SUMO programs: a green phase ends after its minimum once nobody is arriving, at most 20 s after its planned length.
- U-turns: a vehicle class plans one only where it has no other way on (buses still turn at terminals).
- A* routing with landmark lower bounds (ALT), on travel times the simulation measures every minute. The bound is weighted by 1.2, so routes are at most 20 % slower than the fastest and searches stay short in heavy traffic.
- Vehicles stuck for 5 minutes are removed, as SUMO teleports them: about 0.7 % of trips in a 07:00–07:30 peak test, mostly queues spilling back.
- Native speed about 28× real time in the morning peak (14,000 vehicles). The browser runs the WebAssembly build in a worker.
- **Traffic map**: every road coloured by its measured mean speed as a share of the limit over the last simulated minute (flowing, slow, congested, jammed), the first analysis view.

**Status (M3, 2026-10-06).**
- **Census population per district**: each of the City's 17 districts has its 2021 census population spread over the homes inside it (district outlines from the City's register of spatial units).
- **Traffic beyond the map** (`pipeline/gateways.py`, `sim/src/demand.rs`): the 223 places where roads leave the map are gateways. Where a Hrvatske ceste station counts the road (the six motorways, the D1 north and the D30 south-east), the gateway carries the counted traffic, less what leaves at interchanges before the edge; other roads get typical volumes for their class. About 300,000 vehicles a day cross the map's edge:
  - commuters coming in to work in the morning and going home in the afternoon;
  - residents commuting out, the other way round;
  - errands both ways;
  - through traffic between gateways at least 10 km apart, mostly on the A3 bypass, a quarter of it trucks.
  Vehicles from beyond the map drive in at the road's start at speed and leave off its far end.
- **Validation** against the Hrvatske ceste counts: a full simulated weekday compared station by station in [VALIDATION.md](VALIDATION.md).
- **News hotspots**: 107 news reports (2020-2026) of jams, roadworks, closures and crashes at 39 places, placed on the network (`pipeline/news.py`). In the app they are markers (key `N`) with the reports and how the simulation sees the place right now.
- **Live road closures**: the City's closures feed, copied every 15 minutes to the `live-data` branch by a GitHub Action. The app draws them in red (key `C`) and the simulation routes around them.
- Drivers are a little more assertive than in M2: a 1.0 s time gap instead of 1.2 s and 2.2 m/s² acceleration. That gives about 1,800 vehicles per lane per hour at signals instead of 1,600.

Known gaps:
- Left turns wait at the stop line rather than inside the junction (SUMO's internal junctions are not exported yet).
- Guessed signal programs at big junctions have up to 7 green phases. Where netconvert joined a cluster of nodes into one program (Slavonska avenija at Savska cesta, for one), a main road can get 8 s of green in a 90 s cycle and drivers get stuck waiting for each other. Real timings, or re-timing the guessed programs by the lanes each phase serves, would help a lot.
- The morning peak is heavier than the real one: queues on the main corridors grow through 8:00 and about 1.5 % of trips are removed from gridlocks (see VALIDATION.md).
- The app starts at 06:50 and fills the streets for ten minutes, but trips from beyond the map take 20-30 minutes to arrive, so the first half hour has fewer vehicles than a steady 07:00.
- Count stations are placed by hand from their names: the published tables have no coordinates.
- Routing is a third of the engine's time in the peak; a compact routing graph or contraction hierarchies would help.
- Buses stop in whatever lane they are in, not at the kerb; one bus terminal (Črnomerec) is unreachable in the converted network, so its stop is skipped.
- Trams and cars do not share lanes yet: tram tracks are separate edges (joining them into street lanes broke tram connectivity), so cars only meet trams at junctions.

**Vehicles.**
- Intelligent Driver Model for car following, MOBIL for lane changes.
- Gap acceptance and right-of-way at junctions, signal control.
- Tram priority, buses serving their stops.
- Driver parameters calibrated per vehicle class.

**Whole city at interactive speed.** The simulation has its own level of detail:
- full lane-level physics around the camera;
- a cheap queue-based (mesoscopic) model everywhere else;
- vehicles move seamlessly between the two.

Time acceleration leans more on the cheap model.

**Routing.**
- Time-dependent shortest paths on live travel times.
- Routes cached per zone and refreshed in background workers.
- Re-routing on the way when a jam or a network change makes it worthwhile.
- Day-to-day learning, so route choice settles into a realistic equilibrium.

**Demand.** A synthetic population and jobs tied to actual buildings:
- residents from the 2021 census (by district and settlement), assigned to residential buildings by floor area;
- jobs from employment statistics, assigned to offices, shops, industry, schools and hospitals;
- daily activity chains (home → work/school → shops → home) with realistic departure times, and a mode choice calibrated to the Master Plan travel survey;
- commuters and through traffic from Zagreb County, entering at the city boundary;
- ZET trams and buses, and HŽ trains, from their GTFS timetables.

Buildings that grow on newly zoned land add residents and jobs. Those make new trips, and the trips change traffic. This is how the game layer feeds the traffic simulation.

**Instant edits.**
- Network changes are applied to the running simulation.
- Affected routes are recomputed in the background.
- Traffic visibly adapts within seconds.

**Calibration and validation.**
- The native build runs full days offline and compares them with official counts (Hrvatske ceste, Master Plan), observed speeds, and the congestion hotspots mined from news.
- Fit is reported with the GEH statistic. Target: GEH < 5 at ≥ 85 % of count locations.
- Results are committed as a validation report.

## World and rendering

Everything is generated from data, so it can be edited:

| Layer | Source |
|---|---|
| Terrain | Copernicus GLO-30 now; DGU LiDAR terrain if obtainable |
| Ground | Land-cover materials (forest, grass, fields, built-up, water) from ESA WorldCover and OSM; the Sava, Jarun and Bundek |
| Roads | Generated from the simulation network: lanes, markings, sidewalks, curbs, tram tracks, junction surfaces |
| Buildings | City of Zagreb ZG3D model (LoD 2.2, real roof shapes) plus OSM for buildings newer than its 2008 survey; procedural facades by type and era; lit windows at night |
| Vegetation, props | Street trees, parks, Medvednica forests, street lights, traffic lights, tram catenary |
| Vehicles | Instanced models with LOD: cars, vans, trucks, ZET buses and trams, HŽ trains; brake lights, indicators, headlights |
| Atmosphere | Sun position for the simulated date and time, shadows, sky, fog, day/night, weather |

- **Streaming**: the city is tiled with levels of detail and loaded around the camera.
- **Views**:
  - 2D map: orthographic, straight down;
  - isometric: orthographic, rotates in 90° steps;
  - free 3D;
  - follow / ride-along.
- **Aerial photo**: the DGU orthophoto can be an optional reference overlay. It is not the ground itself, because the world has to stay editable.

## Game layer (Cities: Skylines 2-like)

- **Modes**:
  - Reality: today's Zagreb, for analysis;
  - Sandbox/Career: budget and growth.
- **Zoning**: residential (low, medium, high density), commercial, office, industrial. Buildings that grow there follow Zagreb's architectural styles.
- **City dynamics**: demand (RCI), land value, accessibility from simulated travel times, noise and pollution.
- **Economy**: budget, construction and maintenance costs anchored to real Croatian project costs, taxes.
- **Public transport tools**: tram and bus lines, stops, frequencies, park & ride.
- **Policies**: parking pricing, congestion charge, low-emission zone.
- **Later**: services (schools, healthcare, and so on).

## Data sources

The full inventory, with URLs, licences, formats, CORS status and gaps, is in [DATA_SOURCES.md](DATA_SOURCES.md).

- **In use:**
  - Copernicus DEM (terrain).
  - ESA WorldCover (ground).
  - OpenStreetMap via OSM US Slice: the road network; buildings outside the City; building types and roof shapes.
- **In use since 2026-10-06:** ZG3D 2022, the City of Zagreb's official 3D buildings. Its 341k footprints provide measured roof heights, and wall/eave heights inferred from each building's volume. LoD2 roofs are a later step.
- **In use for traffic (M2–M3):**
  - ZET GTFS: trams and buses.
  - Census 2021: population per city district.
  - Transport Master Plan survey results: trip rates and modal split.
  - Hrvatske ceste 2025 counts: traffic across the map's edge, and the validation report.
  - The City's road closures, live, copied by a scheduled GitHub Action (the feed sends no CORS headers).
- **Next, live via a proxy or scheduled job:** ZET GTFS-RT, DHMZ weather.

## News and incidents

1. **Collect**:
   - Croatian news: Index, Jutarnji, Večernji, tportal, Dnevnik, N1, 24sata, Zagreb.info, HINA;
   - HAK traffic info;
   - the City's road-closure feed.
2. **Extract** each report with an LLM: where (street or junction), what (jam, crash, roadworks, closure, event), when, how bad.
3. **Place** each event on the road network.
4. **Use** the events three ways:
   - a hotspot heatmap and timeline layer;
   - calibration targets;
   - a "today" layer that applies current roadworks and closures to the simulation.

The multi-year backfill happens in development sessions. Automated monitoring comes later (a scheduled GitHub Action needing an Anthropic API key, or keyword rules).

## Roadmap

| Milestone | Outcome |
|---|---|
| **M0 Foundations** | Plan, repo skeleton, CI deploy to GitHub Pages, first terrain of Zagreb in the browser with map / isometric / 3D views |
| **M1 Zagreb in 3D** | Whole-city terrain and land cover, water, roads, ZG3D buildings, trees; tiled streaming; follow view |
| **M2 Zagreb moves** | Rust/WASM engine: network import, car following, lane changing, junctions, signals, routing; ZET trams and buses on timetable; first synthetic demand |
| **M3 Like the real thing** | Demand from census, buildings and jobs; calibration against counts; validation report; news hotspot layer; live closures |
| **M4 Build** | Tools for roads, bridges, lanes, signals and roundabouts with instant re-routing; before/after analytics; real project presets (e.g. Jarunski most) |
| **M5 Grow** | Zoning, growable Zagreb-style buildings, demand, land value, economy |
| **M6 Polish and live** | Day/night, weather, vehicle models, sound, performance; live ZET vehicles and weather |

## Risks and open questions

- **Whole-city simulation performance in the browser.** Mitigations: simulation level of detail, and WebAssembly threads. Threads need cross-origin isolation, which GitHub Pages only gets through a service-worker shim; Cloudflare Pages supports it natively.
- **WebGPU maturity.** The app renders with WebGL 2 by default and WebGPU is opt-in (`?webgpu`). three.js r186 needed a shim for some Chrome versions, and the WebGPU path can't be verified in the headless test environment. We switch the default once it is verified on real devices, or when we need compute shaders.
- **Traffic-light timings are not public.** We infer them, and ask the City if possible.
- **ZG3D is based on 2008 aerial imagery.** We merge it with OSM for newer buildings.
- **Hosting limits** (GitHub Pages about 1 GB). Mitigations: compact binary formats; move large assets to Cloudflare R2 if needed.
- **Licences.** Attribution for OSM (ODbL), Copernicus, ESA, the City of Zagreb, DGU, ZET and the others.
