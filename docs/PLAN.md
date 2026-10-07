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
- **Count stations** (`pipeline/hc.py`, `pipeline/counts.py`): Hrvatske ceste's 2025 tables (914 stations) and its 911-page publication, read in full. The 156 stations in and around the map are placed on OpenStreetMap from their road number and the junctions or places that end their counted section (one, on an unnumbered road, by hand), checked by hand; 54 are inside the map. For the 90 with charts, the hourly and weekday profiles are read from the PDF's vector graphics, so each station's count is estimated for a working day outside the summer. The data derived from them is in `pipeline/data/hc_counts_2025.json`, with attribution; the PDF itself, all rights reserved, is not committed.
- **Traffic beyond the map** (`pipeline/gateways.py`, `sim/src/demand.rs`): the 223 places where roads leave the map are gateways. Where a counted section crosses the map's edge, or a road's nearest counted section is within 2.5 km of where it leaves, the gateway carries that station's working-day count; other roads get typical volumes for their class. About 310,000 vehicles a day cross the map's edge:
  - commuters coming in to work in the morning and going home in the afternoon;
  - residents commuting out, the other way round;
  - errands both ways;
  - through traffic between gateways at least 10 km apart, mostly on the A3 bypass, a quarter of it trucks.
  Vehicles from beyond the map drive in at the road's start at speed and leave off its far end.
- **Towns around the City**: their homes get the 2021 census population of their settlement (384 settlements, 229,000 people; DZS), and their residents make more car trips than the City's (0.87 a day in Zagreb County and the others, 1.0 in Krapina-Zagorje, against 0.65; Transport Master Plan modal split by county).
- **Validation** against the Hrvatske ceste counts: a full simulated weekday compared station by station and hour by hour in [VALIDATION.md](VALIDATION.md).
  - 47 stations inside the map are independent checks: 13 within ±25 %, the total at 0.79 of the counts. The motorways match (4 of 5 within ±25 %, total 1.01); state roads carry 0.65 of their counts, county and local roads 0.84.
  - The seven stations whose counts set the traffic across the map's edge carry it within 16 % on average, so traffic from beyond the map comes in and goes out along the right roads.
  - The three state roads between Zagreb and the towns around it, which carried about half their counts, now carry: D3 at Popovec +4 %, D225 at Zaprešić -10 %, D231 at Sveta Nedelja -36 %. They were short because the towns' populations were spread by floor area and their residents made as few car trips as the City's, and because the traffic across the map's edge was set from a few stations; the census by settlement, the county trip rates and the full tables fixed most of it.
  - Hour by hour, the simulated share of each hour's traffic follows the counted one within about a percentage point; at full demand the charted stations carry about two thirds of their counts, and 34 % of station-hours have GEH below 5 (the target is 85 % of stations every hour, met in none).
  - In the afternoon peak the simulation jams where the news reports jams most often (Jadranski most, 15 reports) and on Savska cesta at Vukovarska, Slavonska and Tratinska. The other 35 news places flow; most of them are in the news for crashes, roadworks or events, which the simulation does not have.
- **Calibration** (details in VALIDATION.md):
  - Drivers are a little more assertive than in M2: a 1.0 s time gap instead of 1.2 s and 2.2 m/s² acceleration. A queue leaves a green light at about 1,970 vehicles per lane per hour (the Highway Capacity Manual's base is 1,900; a test keeps it there).
  - Signals: the guessed programs are re-timed, each cycle's green split by the lanes each phase lets go (tram tracks count a quarter), with a 120 s cycle at junctions with four or more green phases. Where netconvert joined junctions into a program that lets opposite approaches go one after another, those phases are merged, turns giving way to oncoming traffic: on Slavonska avenija at Ulica Josipa Marohnića each direction had one green phase of seven, and more vehicles got stuck there than anywhere else.
  - Tolls: routes count each kilometre of tolled motorway as 18 s (about €0.08 at €16 an hour), except for drivers who cross the map's edge on a tolled motorway. With the full tables, 36 s left the A11 at half its toll counts and sent Sisak's traffic down the D30 (Lekenik at more than twice its count); at 18 s the A11's two stations are within 3 %.
  - The hourly profile of trips (`HOURLY` in `sim/src/demand.rs`) is the mean of the 33 stations inside the map counted all year: traffic starts early, the morning is flat from 06:00 to 08:00 and the afternoon peaks at 15:00, as Zagreb's working day ends at 15:00-16:00. Trip purposes by hour follow it. With the old profile, peaking at 16:00-17:00, the evening headed for gridlock (35,000 vehicles on the road at 17:00, and rising).
  - Traffic coming in crosses the map's edge 45 minutes before the city's own trips of the same purpose, so it reaches the city in its peak (a day without the lead differed by no more than run to run).
  - **The simulation runs 60 % of the estimated demand** (`DEMAND_SCALE` in `pipeline/demand.py`). At full demand the network locks up in the morning; at 70 % the afternoon locks up (52,000 vehicles on the road at 15:00 at 20 km/h). At 60 % the busiest hour is 16:00, with 31,000 vehicles at 28 km/h, and 2.4 % of trips are removed after standing still for 5 minutes.
  - Tried and left out: Zagreb Airport as a place trips come from and go to (14,000 vehicles a day estimated from passengers and staff) changed none of the counts near it (Velika Mlaka, the Velika Gorica bypass) and tipped Vukovarska at Držićeva into gridlock, where 2,000 more vehicles got stuck.
- **News hotspots**: 107 news reports (2020-2026) of jams, roadworks, closures and crashes at 39 places, placed on the network (`pipeline/news.py`). In the app they are markers (key `N`) with the reports and how the simulation sees the place right now.
- **Live road closures**: the City's closures feed, copied every 15 minutes to the `live-data` branch by a GitHub Action. The app draws them in red (key `C`) and the simulation routes around them.

Known gaps:
- Left turns wait at the stop line rather than inside the junction (SUMO's internal junctions are not exported yet).
- The simulated junctions carry less traffic than Zagreb's real ones, hence the 60 % demand. A third of the vehicles that get stuck do so at 25 places (VALIDATION.md lists them): mostly in the centre, several where trams cross (Kršnjavoga at Savska cesta, Vlaška at Draškovićeva, Mesnička at Ilica, Palmotićeva, Branimirova at Držićeva), and in Sesvete, where Branimirova meets Dubrava. Likely causes: guessed signal timings, left turns waiting at the stop line, and trams crossing junctions split into many short edges. The City's real signal timings would help most.
- State roads carry two thirds of their counts, and several stations are far off: the road from Zagreb to Velika Gorica at Velika Mlaka (-88 %) and the Velika Gorica bypass (-84 %); roads at the map's edge such as the D307 at Oroslavje (-91 %), where the A2/D1 interchange at Zabok gridlocks all day (a chain of roundabouts, the most vehicles removed anywhere); and local roads used as shortcuts, at several times their counts (Karivaroš +554 %). Hour by hour, the GEH target is met nowhere.
- Gridlocks that never clear: the Zabok roundabouts and Zagrebačka cesta in Sesvete stay jammed through the night, so 2,000-3,000 vehicles stand still at 01:00. Roundabouts (M4e) need their own rules for entering.
- Hrvatske ceste's counts by vehicle class (CSV files per station) could not be downloaded: their page refuses plain clients. With them, trucks could be calibrated on their own.
- The app starts at 06:50 and fills the streets for ten minutes, but trips from beyond the map take 20-30 minutes to arrive, so the first half hour has fewer vehicles than a steady 07:00.
- Count stations are placed from road numbers and section ends, as the published tables have no coordinates; on long sections the point chosen may be off where the traffic changes along it.
- Routing is a third of the engine's time in the peak; a compact routing graph or contraction hierarchies would help.
- Buses stop in whatever lane they are in, not at the kerb; one bus terminal (Črnomerec) is unreachable in the converted network, so its stop is skipped.
- Trams and cars do not share lanes yet: tram tracks are separate edges (joining them into street lanes broke tram connectivity), so cars only meet trams at junctions.
- Drawn roads join other roads only at their ends, and the junctions they make have no signals until the player sets some (a road joining a signalled junction gets a phase there). The tram lines planned on Jarunski most and Sarajevska cesta are not built.
- Junctions with tram or rail tracks through them cannot be made roundabouts, and a roundabout's ring is a fixed template (14 m radius with one lane, 18 m with two, larger where roads meet at sharp angles), not drawn by the player.
- A project's numbers come from the morning peak only, with today as the mean of two runs; more runs, and the afternoon, would narrow the noise.

**Plan (M4 Build, 2026-10-06).** Netconvert builds the network offline and cannot run in the browser, so edits take their own path: the engine changes the arrays it already has (lanes, links, signal programs, the routing graph) while it runs. Steps, each pushed to `main` when it works:

- **M4a, edit foundation** (done 2026-10-06: the Build panel, key `B`).
  - *Edit model* (`web/src/edit/`): a list of edits, each naming the roads it changes by position and heading rather than by id, because ids change whenever CI rebuilds the network from newer OpenStreetMap data. Kept in the browser's local storage, shareable as a link (the list compressed into the URL) or a JSON file.
  - *Edits*: close a road or one of its lanes, set a speed limit, reserve a lane for buses, ban a turn, set a signal's green times.
  - *Engine* (`sim/src/edits.rs`): every change rebuilds the edited state from the network as loaded, so edits can be removed in any order. It updates lane speeds and permissions, the links' permissions, the routing graph and the free-flow times. Edits that make roads faster also rebuild the landmark tables, a few at a time between steps, so routes stay optimal. Vehicles whose route uses a changed road re-plan at once; the rest re-plan over the next minute, so traffic visibly shifts. Live closures keep working as they do now.
  - *App*: a Build panel (key `B`). Pick a road on the map to see its lanes, limit and turns; change them; list, undo and share edits. Road picking uses a grid over lane shapes.
  - Tests: engine tests on hand-built networks (a closed lane empties, a turn ban re-routes, a bus lane keeps cars out, a faster road attracts traffic, removing an edit restores the network). A Playwright test makes an edit through the panel and checks it reaches the engine and survives a reload.
  - As built: a closed road or lane keeps buses and trams (they run to their timetable), and vehicles already on it drive off it. A bus lane also lets taxis and emergency vehicles in, as Zagreb's do. The landmark tables take 24 searches of about 25 ms each (natively) on the whole network; the engine runs one per step after an edit that makes roads faster, and routes use the straight-line bound until they are done. A shared link carries the edits deflated in its fragment, so they never reach a server.
- **M4b, before and after** (done 2026-10-06: Before and after in the Build panel).
  - Compare starts a second worker on the unedited network, with the same seed, start time and demand, and keeps it at the same simulated time.
  - The panel shows the differences: total delay (vehicle-hours lost against free flow), mean speed, and travel times between district centres (routed on each engine's measured times). A difference map colours roads by the change in volume or speed.
  - Offline, `sim/examples/compare.rs` runs both networks through a peak period natively and writes the same numbers, for the project presets.
  - As built: Compare runs the day again from 06:50, the player's simulation with the edits and a second one on today's roads, each held while it is more than 10 s ahead. The measures are taken as of the same simulated minute: delay against the speed limit (vehicle-hours), vehicles on the road, mean speed, kilometres driven, trips finished and their mean time. Travel times by car between the 17 districts (at the mean position of their residents) and Velika Gorica, Samobor, Zaprešić and Dugo Selo are routed every 5 simulated minutes in both, a few queries per batch. The difference map (from 07:00) colours roads with at least 60 vehicles by the change in the vehicles that have driven onto them since the start, orange for more and purple for less. Early in the morning the numbers are small and noisy; they settle over the first hour.
- **M4c, real projects** (done 2026-10-06: Planned projects in the Build panel).
  - Research planned Zagreb road projects: Jarunski most, the extensions of Radnička cesta and Avenija Većeslava Holjevca, and others in the City's plans and the news.
  - Each becomes a patch of OpenStreetMap-style ways in `pipeline/projects/`, run through netconvert with the base data into its own network. Ids differ, so demand and transit are rebuilt for it.
  - The app loads a project's network in place of today's, and shows before/after numbers precomputed offline with the native runner.
  - As built (`pipeline/projects.py`, step `projects`): four projects, chosen from the City's announcements and what OpenStreetMap already maps as proposed or under construction:
    - *Jarunski most*: the 625 m road bridge west of Lake Jarun, two lanes each way, from Zagrebačka avenija past Horvaćanska cesta to Jadranska avenija (planned, construction from mid-2028);
    - *Šarengradska ulica*: four lanes from Ulica grada Vukovara across Zagrebačka avenija to Selska cesta at Jadranski most (planned, permit awaited);
    - *Branimirova to Sesvete*: from Brestovečka ulica over Kašinska cesta to Varaždinska cesta (third stage under construction);
    - *A11 into Sarajevska cesta*: the viaducts over the marshalling yard and a six-lane Sarajevska cesta (under construction, delayed).
  - A project is a patch over the OSM extract: the mapped proposed or construction ways are opened with the tags they will have, their ends are carried across the roads they meet (both carriageways), junctions are made where they cross named roads at grade, signals go on the junctions the project names, and the parts over the Sava or a road become bridges. netconvert builds the patched map with today's options; demand, the timetable and the news are placed on it. Each project adds about 19 MB of data and 3 minutes to the data build.
  - The roads a project adds are found by shape (edges no road of today's runs along within 8 m and 30°), drawn in teal, and the camera flies there.
  - Opening a project reloads the app with `?project=<id>`: its network runs in place of today's, edits still apply (they are matched by position), and Compare loads today's network as a second simulation, matching roads between the two by position and heading for the difference map.
  - Before and after numbers: `sim/examples/compare.rs` runs one network natively from 05:00 and measures 06:00-10:00; `python -m pipeline.projects compare` turns runs of today's network (two seeds) and one of the project's into `pipeline/data/projects/<id>.json`: delay, mean trip, kilometres and trips, travel times between the 21 places (the trips passing within 2.5 km of the project listed), and the named roads within 3 km whose traffic changes most. Today is the mean of its two runs, which differ by 16 % in delay and 6 % in travel times: in congestion one run's jam is not another's, so changes across the whole network smaller than that are noise, while the roads near a project change clearly. Jarunski most carries about 3,500 vehicles in the four hours and takes 15-17 % off Zagrebačka and Ljubljanska avenija; Branimirova's extension takes about a third off Zagrebačka cesta in Sesvete; Šarengradska ulica takes 31 % off Ulica grada Vukovara near it.
- **M4d, drawing roads and bridges** (done 2026-10-06: New road in the Build panel).
  - Draw a road between existing junctions or new points, choosing its type, lanes and speed.
  - This needs a junction builder: lanes and shapes for the new edges, connections, right of way (foes from crossing paths, priority by road class, right before left between equals) and signal states for new and changed junctions. It runs in the app (`web/src/edit/`), which has the whole network and draws the result, and produces a network patch: lanes, edges, links and junction logic to add, and junction logic to replace.
  - The engine rebuilds its network from the loaded arrays plus the patch. Lanes, edges and junctions are only appended, so their ids stay; links are re-sorted by the lane they leave, and vehicles' link references are matched again by their lanes. Vehicles on a removed road leave the simulation.
  - As built: the junction builder (`web/src/edit/builder.ts`) makes every network from the one loaded plus all roads drawn, so what was loaded keeps its ids. A road's ends join the road clicked on: at that road's junction if within 20 m of it, else by cutting the road there, both ways (both carriageways of a dual one) at one new junction; failing a road within 15 m, a junction within 25 m. It meets other roads only at its ends. At each junction it meets, every way in links to every way out except back the way it came (straight on lane by lane, right turns from the rightmost lane, left from the leftmost), each link on its own curved lane across the junction. Paths that cross or merge are foes; the most important roads in have priority, left turns give way to oncoming traffic, and otherwise traffic from the right goes first. At signals, links from an approach already there take the states of its nearest link (giving way where they cross a green), and a new approach gets its own green and yellow at the end of the cycle.
  - Each build records where its lanes lie on the lanes they were made from, so the engine is told where every lane of the running network went (`LanePiece`, `sim/src/patch.rs`): vehicles move with their lanes, routes follow their roads' pieces, links are matched again by the lanes they join, those on a road taken away leave, those whose route used it re-plan at once, the rest within a minute. Undo works the same way. Signals keep running where their program did not change.
  - A drawn road is an edit like the others: kept, shared and undone with them; edits on other roads are matched to the network with the roads drawn.
  - Building and swapping the network takes about 1-4 s on the whole city in the browser (most of it the road index and road layer made again).
  - Compare runs today's roads as loaded next to the network with the roads drawn, matching roads between them by position and heading.
- **M4e, roundabouts and signals** (done 2026-10-07: The junction ahead, in the Build panel's road section).
  - Convert a junction into a roundabout from a template (a ring of one-way edges, yield at entry).
  - Edit a signal program's phases and green splits, with the engine's re-timing as the starting point.
  - As built: both are edits of the junction ahead of the road chosen, built into the network by the junction builder after the roads drawn, and kept, shared and undone like the others.
    - *Roundabouts*: the roads meeting are grouped into legs by their bearing from the junction (ends within 25° are one leg; at least three legs). Each leg gets a junction of its own on a ring 14 m in radius with one lane, 18 m with two (more where legs are close together, up to 40 m), and the ring runs anticlockwise between them in one-way arcs at 25 or 30 km/h. The roads are shortened to end clear of the ring. Traffic entering gives way to traffic on the ring; traffic on the ring goes round or turns off. The old junction loses its links, and vehicles inside it leave. Junctions with tram or rail tracks through them are refused.
    - *Signals*: the editor lists the junction's movements (the links from one road onto another, by approach) and its phases as the engine runs them, or, for a junction without lights, opposite approaches together. The player ticks the movements each phase lets go and sets its length (5-180 s). A 3 s yellow follows each phase for what turns red; movements crossing one with priority in the same phase get a permissive green (`g`) and give way. Road movements never green are closed; tram movements stay red. A junction whose program also controls others (netconvert's clusters) is edited with them. The lights can also be taken away, leaving right of way to the road classes.
    - The engine runs a program the player set as given (`tlsFixed`), without merging or re-timing its phases or extending its greens.
    - Movements are stored by points 10 m from the junction on each road and their headings, so they are found again after a road is drawn across one further away. Movements the edit does not know (a road drawn to the junction afterwards) go green with their approach, or get a phase of their own.
    - Swapping the network now also drops vehicles beyond the new end of a road shortened, and buses and trams whose way on no longer joins up take the shortest way across, keeping their stops.
  - Tests: engine tests on a hand-built crossroads made a roundabout while cars and a bus drive (the car where the ring now is leaves, the others re-plan round the ring and arrive, the bus keeps its stop) and on a player's program running as given; builder unit tests (the ring and its right of way, lights on a junction without them, closing movements never green, taking lights away); a Playwright test that makes a junction in Novi Zagreb a roundabout, sees traffic drive round it, lengthens a phase of lights near the centre and checks the engine runs it, then undoes both.

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
