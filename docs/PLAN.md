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
  - Signals: the guessed programs are re-timed, each cycle's green split by the lanes each phase lets go (tram tracks count a quarter), with a 120 s cycle at junctions with four or more green phases. Where netconvert joined junctions into a program that lets opposite approaches go one after another, those phases are merged, turns giving way to oncoming traffic: on Slavonska avenija at Ulica Josipa Marohnića each direction had one green phase of seven, and more vehicles got stuck there than anywhere else. Actuated signals skip phases nobody waits for and keep a green while nobody waits elsewhere (M7d).
  - Tram crosses: the junctions where only tram tracks meet are joined into the road junctions around them, so trams and cars are movements of one junction under one signal program (M7d).
  - Tolls: routes count each kilometre of tolled motorway as 18 s (about €0.08 at €16 an hour), except for drivers who cross the map's edge on a tolled motorway. With the full tables, 36 s left the A11 at half its toll counts and sent Sisak's traffic down the D30 (Lekenik at more than twice its count); at 18 s the A11's two stations are within 3 %.
  - The hourly profile of trips (`HOURLY` in `sim/src/demand.rs`) is the mean of the 33 stations inside the map counted all year: traffic starts early, the morning is flat from 06:00 to 08:00 and the afternoon peaks at 15:00, as Zagreb's working day ends at 15:00-16:00. Trip purposes by hour follow it. With the old profile, peaking at 16:00-17:00, the evening headed for gridlock (35,000 vehicles on the road at 17:00, and rising).
  - Traffic coming in crosses the map's edge 45 minutes before the city's own trips of the same purpose, so it reaches the city in its peak (a day without the lead differed by no more than run to run).
  - **The simulation runs 60 % of the estimated demand** (`DEMAND_SCALE` in `pipeline/demand.py`). At full demand the network locks up in the morning; at 70 % the afternoon locks up (52,000 vehicles on the road at 15:00 at 20 km/h). At 60 % the busiest hour is 16:00, with 31,000 vehicles at 28 km/h, and 2.4 % of trips are removed after standing still for 5 minutes.
  - Tried and left out: Zagreb Airport as a place trips come from and go to (14,000 vehicles a day estimated from passengers and staff) changed none of the counts near it (Velika Mlaka, the Velika Gorica bypass) and tipped Vukovarska at Držićeva into gridlock, where 2,000 more vehicles got stuck.
- **News hotspots**: 107 news reports (2020-2026) of jams, roadworks, closures and crashes at 39 places, placed on the network (`pipeline/news.py`). In the app they are markers (key `N`) with the reports and how the simulation sees the place right now.
- **Live road closures**: the City's closures feed, copied every 15 minutes to the `live-data` branch by a GitHub Action. The app draws them in red (key `C`) and the simulation routes around them.

Known gaps:
- The simulated junctions carry less traffic than Zagreb's real ones, hence the 60 % demand. A third of the vehicles that get stuck do so at 25 places (VALIDATION.md lists them): mostly in the centre, several where trams cross (Kršnjavoga at Savska cesta, Vlaška at Draškovićeva, Mesnička at Ilica, Palmotićeva, Branimirova at Držićeva), and in Sesvete, where Branimirova meets Dubrava. Likely causes: guessed signal timings, left turns waiting at the stop line (they wait inside the junction since M7b), and trams crossing junctions split into many short edges (joined in M7d: no tram junction is among the 25 places now). The City's real signal timings would help most.
- State roads carry two thirds of their counts, and several stations are far off: the road from Zagreb to Velika Gorica at Velika Mlaka (-88 %) and the Velika Gorica bypass (-84 %); roads at the map's edge such as the D307 at Oroslavje (-91 %), where the A2/D1 interchange at Zabok gridlocks all day (a chain of roundabouts, the most vehicles removed anywhere); and local roads used as shortcuts, at several times their counts (Karivaroš +554 %). Hour by hour, the GEH target is met nowhere.
- Gridlocks that never clear: the Zabok roundabouts and Zagrebačka cesta in Sesvete stay jammed through the night, so 2,000-3,000 vehicles stand still at 01:00. Roundabouts (M4e) need their own rules for entering. (M7c: drivers now enter a roundabout only with room at their exit; 820 stand still at 01:00.)
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

**Plan (M5 Grow, 2026-10-07).** Zagreb grows where the player zones land, and what grows makes trips the traffic simulation drives. Today's city stays as it is: growth happens on free land along streets. Steps, each pushed to `main` when it works:

- **M5a, zoning** (done 2026-10-07: the Zones tool, key `Z`).
  - *Lots*: a pipeline step `zoning` divides free land along streets into lots of about 20 m of frontage and 30 m depth, the size of a family-house plot in Zagreb's outskirts. Free means no building, road, railway or water on it, and not land the City's plan keeps open: forests, parks, protective green, sport grounds, cemeteries, water and infrastructure.
  - Each lot records the street it faces (the edge its trips use), its planned use and its land cover.
  - *The City's plan*: the planned land use of the City (`geoportal-planirana-namjena-2023`: 8,999 polygons from the general, urban and detailed plans in force in 2023, Otvorena dozvola) is grouped into residential, mixed, commercial, office, industrial, civic, green, agricultural, water and transport. Outside the City there is no plan, and lots there have none.
  - *Zones*: houses, low-rise flats, high-rise flats, mixed (flats over shops, the plan's *mješovita namjena*), shops, offices and industry.
  - *Tool*: a Zones panel (key `Z`). Choose a zone and a brush size and paint over the map: the lots under the brush take the zone. "As the City plans" paints each lot with the zone its plan gives it, and "Remove zoning" clears them. The planned land use can be drawn under the lots.
  - Zoning is kept in the browser and shared as a link, as brush strokes by position, so it survives the network being rebuilt.
  - Tests: lot making on a hand-made map (lots face their street, avoid buildings, roads and water, and skip land kept open); zone painting and saving; a Playwright test that paints zones and finds them after a reload.
  - As built (`pipeline/zoning.py`, `web/src/grow/`):
    - Lots are laid along both sides of every street except motorways, trunk roads and slip roads, 15 m clear of each street's ends, and kept where the land is free. That leaves 195,034 of 524,662 candidates: 269,408 fall on buildings (with 2 m clear), lanes, tram tracks or railways; 25,957 on land the plan keeps open; 504 on water; and 33,759 overlap a lot of a quieter street.
    - About 27,800 lots are in the City: 8,382 on land planned for housing, 2,109 mixed, 574 commercial, 757 business, 912 industrial and 15,052 on farmland. The other 167,000 are outside the City, where there is no plan. The City is mostly built up or kept green; its free land is in its southern and eastern villages.
    - Speed limits do not decide which streets get lots: many town streets carry netconvert's default of 100 km/h where OpenStreetMap has no limit.
    - The plan's 298 uses (in 20 groups) are grouped into eleven classes. Forests, parks, sport, cemeteries, water, transport and infrastructure, public and social, and military land get no lots.
    - "As the City plans" zones the lots the plan zones and leaves the others as they are. Housing land takes the density of the buildings within 150 m: houses among buildings of up to two storeys, low-rise flats up to six storeys or where nothing is built yet, high-rise flats beyond.
    - In the app, lots are drawn in 500 m chunks near the view: zoned lots filled in their zone's colour, the others as faint outlines while the tool is open. The plan is a 2,048-pixel map (about 15 m a pixel) draped over the terrain.
    - Painting stops the map from being dragged; Esc stops painting. The zoning is saved as brush strokes rounded to 1 m, in the browser and as a `#zoning=` link.
    - The lot data adds 4 MB (gzip) and about 2 minutes to the data build.
- **M5b, buildings that grow** (done 2026-10-07).
  - Zoned lots grow buildings over simulated time, faster where demand is higher (M5d). Neighbouring lots of the same zone join for larger buildings.
  - Zagreb's types: family houses of two or three storeys with tiled pitched roofs; urban villas and five-storey blocks; slabs and towers of 10-19 storeys as in Novi Zagreb; perimeter blocks with shops at street level near the centre; shops and retail parks; office blocks; halls and warehouses. Footprints, setbacks and heights are taken from today's buildings of the same kind in ZG3D.
  - They are drawn in a layer of their own and saved with the zoning.
  - As built (`web/src/grow/growth.ts`, `web/src/world/growthLayer.ts`):
    - Fifteen building types across the seven zones:
      - houses: family houses of two or three storeys under tiled gabled roofs;
      - low-rise flats: urban villas of three or four storeys, and blocks of four to six;
      - high-rise flats: point towers of 8-11 storeys, towers of 12-19 and slabs of 9-13;
      - flats over shops: corner and perimeter blocks of four to six storeys built up to the street, shopfronts on the ground floor;
      - shops: single-storey shops behind a forecourt, and retail boxes over three lots;
      - offices: small offices and office blocks of 5-12 storeys;
      - industry: workshops, halls and warehouses over up to four lots.
    - Each building's sizes come from a seed within ranges set by hand for the type.
    - Each simulated minute, 2 % of the empty zoned lots start building (at least one), those amid other buildings first. Building takes 20-150 simulated minutes; meanwhile the site shows as a concrete shell.
    - A building's lots are taken from the lot it starts on along the street, as many as its type needs. The type is picked among those whose plot fits, by weight.
    - Residents and jobs come from floor area (80 % of the gross is usable): 30 m² of home per resident, and per job 20 m² in offices, 35 m² in shops and 80-120 m² in industry. These are estimates, from the 2021 census's dwelling space per person and typical employment densities.
    - A lot zoned for something else loses its building. Buildings are saved in the browser and in the zoning's share link; a visit starts the simulated day again, so they come back finished.
- **M5c, growth makes trips** (done 2026-10-07).
  - Each new building adds residents or jobs from its floor area, at today's densities by kind, on the street its lot faces.
  - The engine takes new home and work weights and a new daily trip total while it runs, so new residents' trips and new jobs' commuters, including those from beyond the map, join the traffic.
  - Engine tests: homes added on a hand-built network make trips from there; jobs added attract them.
  - As built (`web/src/grow/demand.ts`, `Demand::set_weights`, `zg_set_demand`):
    - Each finished building's residents go to the street its first lot faces, as a weight of trips from home: residents in the City count once, those outside it at the counties' car trip rate (0.87 against 0.65, a weight of 1.33). Its jobs go there as a work weight.
    - The app merges them with today's demand and sends the merged arrays to the worker, with the day's car trips raised by 0.65 per City resident. That happens when buildings are finished or taken down, at most every 5 simulated minutes.
    - The engine replaces its weights and daily total in place (`Demand::set_weights`) and keeps the gateways and the gravity model. New homes' trips start at once; new jobs draw trips, including commuters from beyond the map, without adding any (as today's jobs do).
    - With a planned project open, a lot's trips use the street in front of it on the project's network, found by position.
    - The simulation compared in Before and after runs today's demand without what grew.
- **M5d, demand and land value** (done 2026-10-07).
  - Demand per zone: homes are wanted where jobs outnumber workers, shops where residents spend, offices and industry where workers can reach them. It comes from the city's totals and simulated travel times.
  - Land value per lot from accessibility (jobs and residents reachable by car in 20 minutes on measured travel times), parks and water nearby, and noise from traffic volumes. It is drawn as a map. Buildings grow taller where land is dearer.
  - As built (`web/src/grow/landValue.ts`, `web/src/grow/zoneDemand.ts`, `Engine::reach`, `zg_reach`):
    - *Accessibility*: the engine searches outward from a street (Dijkstra on the travel times it measures, as routes use them) and sums the residents and jobs of the streets it reaches within 20 minutes, each weighted by exp(-time / 6 min): gravity accessibility. Free-flowing, the centre reaches about 4½ times as much as Sesvete and 6½ times as much as Samobor.
    - It is measured from one street in each square 1.5 km across that has lots (1,092 of them), the street of the lot nearest the square's centre, and interpolated between squares. The worker measures a few streets per batch, 8 ms at most, so the traffic keeps moving; a measurement takes about half a minute (in headless Chromium, the traffic at 64 times real time) and is repeated every half an hour of simulated time while there is zoning. Each counts half against those before, so land value follows the day's traffic slowly.
    - *Land value* is 100 × (accessibility / the best square's at the first measurement)^0.75, plus up to 10 % for green land cover within 200 m (trees, grass, water: the zoning step counts it from WorldCover), less 0.6 % per dB of traffic noise above 55 dB(A), at most 25 %. The power is chosen so building land near the centre comes out several times dearer than on the City's edge; the noise and green weights are in the range hedonic price studies find. All are estimates.
    - *Noise*: the hourly equivalent level from the vehicles measured on the lot's street (12 m away) or on the nearest motorway, trunk or primary road within 250 m (the zoning step finds it), whichever is louder: 39.2 + 10 log₁₀(vehicles an hour) dB(A) at 10 m, 3 dB less per doubling of distance (the UK's CRTN, without speed, lorries or surface).
    - *Demand*: from -1 to 1 for homes, shops, and offices and industry. Today's map holds 0.5 jobs per resident; homes are wanted when what grew adds more jobs than residents to fill them, shops when residents grow beyond 0.08 shop jobs each (retail is about a sixth of Croatia's employment), offices and industry when residents grow beyond the other jobs. 2,000 people out of balance (400 for shops) move demand by 1. The base, set by hand for Zagreb today: homes 0.4, shops 0.2, offices and industry 0.3.
    - Each zone's lots start building at the base rate times 1 + its demand: none at -1, twice as fast at 1 (mixed answers to homes and shops). Lots on dearer land start first. Storeys follow land value for 60 % and chance for 40 % within each type's range, and are saved with the building.
    - The Zones panel shows the three demands as bars and colours every lot by land value on request. Across the map's 195,034 lots, land value runs from about 1 to 105 at 07:00, with a median of 11: most lots are in villages beyond the City.
- **M5e, economy** (done 2026-10-07).
  - A budget: income from property tax and the local income tax on residents and jobs; costs of the roads, junctions and bridges the player builds, from real Croatian project costs, and their upkeep.
  - Building needs money. The panel shows the balance over time.
  - As built (`web/src/grow/economy.ts`, `web/src/grow/budgetTool.ts`, the Budget panel, key `M`; sources in [DATA_SOURCES.md](DATA_SOURCES.md#9-budget-and-costs-m5e)):
    - *Time*: a simulated day counts as a year of the budget. Buildings rise in an hour or two and roads open when drawn, so yearly income and upkeep flow in over each simulated day.
    - *Income*: the City's yearly investment in its streets, €63.9 million (2025 budget), from the start; on what grows, the income tax, €1,800 a resident a year (€1.38 billion over 767,131 residents), and the communal fee, €1.39 per m² of usable floor a year times the City's purpose coefficient (homes 1, shops 9, offices 10, industry 4 estimated) and a zone coefficient from land value (1.00 to 0.40, estimated); and once, when a building is finished, the communal contribution on its volume, €18.35 to €2.00 per m³ by zone (the City's zones I-V, picked by land value). The taxes and fees of what grows go to roads in full: the services its people would need are left out. Property tax proper (since 2025 only on homes not lived in) is left out.
    - *Costs* (without VAT or land): roads €1.1 million per lane-km (Branimirova's extension), motorways €2.7 million (the A11 to Velika Gorica), bridges €5,600 per m² of deck (Jarunski most), roundabouts €950,000 with one lane (Rijeka) and twice that with two (estimated), new traffic lights €200,000 (Zagreb's 2023 programme), new timings €5,000, closures, bus lanes, speed limits and turn bans €1,000-5,000 (estimated).
    - *Upkeep* of what the player builds: €4,200 per lane-km a year (the City's €21.0 million for extraordinary maintenance of its streets in 2024 over the 4,986 lane-km of City streets on the network), 0.5 % of a bridge's cost and €3,000 for a set of lights (estimated).
    - Edits that cost more than the balance are refused with the reason; taking one back refunds it. Each edit's cost shows in the Build panel's list.
    - The Budget panel shows the balance, a year's income and upkeep by item, what was built and the contributions paid, and a chart of the balance over the days played. The balance and its history are kept in the browser; it starts at one year of the streets budget.

**Plan (M6 Polish and live, 2026-10-07).** The city looks and sounds like the time of day and the weather it is having, its vehicles look like Zagreb's, it runs smoothly on a laptop and a phone, and ZET's trams and buses can be shown where they really are. Steps, each pushed to `main` when it works:

- **M6a, day and night** (done 2026-10-07).
  - The sun moves with the simulated time on today's date in Zagreb (45.81° N, 15.98° E): its height and direction set the light, the sky's colour and the shadows' direction. Dawn and dusk turn the sky orange; at night it is dark blue, with a little light left so the map stays readable.
  - At night street lights glow along the streets, windows light up in a share of buildings that falls through the night, and vehicles show headlights and tail lights.
  - A choice in the HUD: light as the time of day, or always day (the map as now).
  - Tests: sun position against published values for Zagreb (noon height on the solstices and equinox, sunrise and sunset times); a Playwright test at midnight and at noon.
  - As built (`web/src/world/sun.ts`, `daylight.ts`, `nightLights.ts`, `streetLights.ts`):
    - The sun's position comes from the Astronomical Almanac's low-precision formulas for the simulated time on today's date, on Zagreb's clock (summer time from the last Sunday of March to the last Sunday of October). It rises and sets within 2 minutes of published times (21 June: 05:06 and 20:48; 21 December: 07:34 and 16:14).
    - The light and the sky's colour follow the sun's height through six stops set by eye: midday, golden hour, sunset, twilight, dusk and night. Below 2° under the horizon a faint moonlight from the south-west keeps the relief readable. There are no shadows yet.
    - Street lamps: a pool of warm light every 40 m along each side of streets with a building within about 100 m (287,662 lamps before that filter). Motorways, service roads and tracks have none. They come on below the horizon and are full on 6° below it; seen from far out the pools grow, so the city glows. They are drawn after the ground and before buildings, without a depth test, so they lie on the coarse terrain however it slopes.
    - Lit windows: a pattern on every wall drawn by the GPU (storeys 3 m high, a window every 3.2 m), each window lit or not by a hash of where it is. The share lit follows the hour, an estimate: 60 % at 20:00, 10 % from 02:00 to 05:00.
    - Vehicles carry headlamps and tail lamps, the tail lamps bright when braking (the engine reports it), and at night a beam on the road ahead.
    - The HUD's ☀ button (key `L`) keeps the light as at midday, kept in the browser. `?start=HH:MM` starts the simulation at another time of day.
    - The simulation starts at 07:00, before sunrise from late October to early March, so the city often opens at dawn.
- **M6b, weather** (done 2026-10-07).
  - The live-data job copies DHMZ's hourly observations for Zagreb-Grič, Maksimir and the airport (temperature, wind, and the weather in words: clear, cloudy, rain, snow, fog) to the `live-data` branch every 15 minutes.
  - The app shows today's weather and draws it: cloud dims the light, rain and snow fall near the camera, fog shortens the view, roads look wet. The player can also pick the weather.
  - Traffic drives to the weather: in rain drivers keep longer gaps and go a little slower, in snow more so, and junctions let fewer vehicles through on green, with the factors from the Highway Capacity Manual and published studies (to be cited).
  - Engine tests: a queue leaves a green light more slowly in rain and snow; free-flow speed falls.
  - As built (`sim/src/weather.rs`, `web/src/world/weather.ts`, `precipitation.ts`, the live-data job):
    - The live-data job reads DHMZ's `hrvatska_n.xml` every 15 minutes and publishes the three Zagreb stations as `weather.json`. The app takes Zagreb-Grič's observation and reads its words: *vedro* clear, *pretežno/djelomično oblačno* partly cloudy, *oblačno* overcast, *kiša*, *rosulja*, *pljusak* rain (*jaka* heavy), *snijeg*, *susnježica* snow, *magla* fog, *grmljavina* thunderstorm.
    - The HUD's weather list offers the live weather (with its temperature) or any of nine kinds, kept in the browser.
    - Cloud dims the sun by up to 65 % and greys the sky. Rain and snow fall around the point looked at in the 3D and isometric views below 2.5 km, drawn and moved by the GPU (up to 12,000 drops), larger the further out the view. Rain, snow and fog add a haze that reaches the point looked at, in every view (fog hides about half of it). Roads in rain and snow are darker and glossier. Snow does not lie.
    - Driving: the engine multiplies every driver's desired speed, time headway, and acceleration and comfortable braking by the weather's factors. Rain: 0.95, 1.1, 0.95; heavy rain and storms: 0.92, 1.2, 0.9; snow: 0.87, 1.15, 0.85; heavy snow: 0.65, 1.4, 0.65; fog: 0.9, 1.15, 1. On the engine's test junction a queue then leaves a green light 8.8 %, 14.1 %, 13.1 %, 31 % and 12 % more slowly than in clear weather. That is within the reductions published for rain (Prevedouros and Chang: 8.3 %; the HCM: 6-10 % for medium rain), heavy rain (Ibrahim and Hall: 14-15 %), snow (5-21 % at signals, Agbolosu-Amison and others), heavy snow (Ibrahim and Hall: 30 %) and poor visibility (the HCM: 10-12 %), and free-flow speed falls 5, 8, 13, 35 and 10 %. The factors are estimates from those studies, not measured in Zagreb.
- **M6c, vehicle models** (done 2026-10-07).
  - Low-poly models in place of boxes: cars of a few shapes (hatchback, saloon, estate, SUV, van), rigid and articulated lorries, ZET's articulated buses and its low-floor trams, with brake lights when braking and indicators when changing lanes or turning (the engine already reports both).
  - Still one draw call per type, instanced.
  - As built (`web/src/world/vehicleModels.ts`): models made of boxes and side profiles extruded across the vehicle, so bonnets and windscreens slope, with wheels, lamps and indicators.
    - Cars in five shapes by shares estimated for Zagreb's streets: hatchbacks 40 %, saloons 25 %, estates 15 %, SUVs 15 %, small vans 5 %, 4.2-4.8 m long (the engine counts every car as 4.5 m). A car keeps its shape and colour, both drawn from its seed.
    - Lorries of 10 m, as the engine's: a box lorry and a flatbed with its load. Articulated lorries and buses wait for the engine to have longer vehicles.
    - ZET's 12 m bus, blue with a band of windows and a white roof, its doors on the right; ZET's 32 m low-floor tram in five modules with a sloping nose, white roof, roof equipment and a pantograph.
    - Instanced per model: seven meshes each (paint, the rest, headlamps, tail lamps, the two indicators, the beam) sharing one set of transforms, 63 in all. Tail lamps brighten when the engine reports braking, and indicators blink 1.5 times a second while it reports a turn or a lane change.
- **M6d, live ZET vehicles** (skipped, 2026-10-07).
  - ZET's real-time feed (GTFS-RT vehicle positions, about every 10 seconds) sends no CORS headers, so the browser would need a small proxy that adds them, and a host for it. Left out for now by decision: trams and buses run to ZET's timetable.
- **M6e, sound** (done 2026-10-07).
  - Generated in the browser (Web Audio, no recordings): the hum of traffic near the camera rising with the number of vehicles and their speed, trams' bells and wheels, rain. Off until the player turns it on.
  - As built (`web/src/ui/sound.ts`, the HUD's 🔈 button, key `S`): brown noise through a low-pass filter for the traffic within 250 m of the point looked at, its loudness growing with the square root of their number and its cut-off from 250 Hz (standing) to 1,090 Hz (50 km/h); a rumble around 90 Hz for trams, and now and then a two-stroke bell (1,480 and 2,220 Hz); white noise above 1.2 kHz for rain. Everything fades out between 200 m and 3 km of view height, and snow muffles the traffic by 40 %.
- **M6f, performance** (done 2026-10-07).
  - Measure first: frame time on the map, isometric and 3D views, and how fast the simulation runs, on a desktop and a phone profile; a `?perf` overlay.
  - Then fix the largest costs found, for example drawing fewer distant layers, building chunks within a frame budget, and the worker's batches.
  - Targets: 60 frames a second on a desktop with a GPU in the map view of the whole City; the simulation in real time at 16 times on a desktop.
  - Measured (headless Chromium, software rendering, 1,280 by 800 pixels): the main thread was idle 94 % of the time, so the cost was on the GPU. Every view drew 2.1 to 4.6 million triangles: the terrain was one mesh of 1.9 million in every view, the road overview's wide lines were 6 triangles a segment for all 318,000 segments, and vehicles 200 triangles each however far away. The engine ran the morning peak at 11 to 13 times real time in the browser, its steps 1.7 to 2 times slower than natively (20-25 ms a step natively at 07:00-08:00 with about 17,000 vehicles), and half its time went on route searches.
  - As built:
    - `?perf` shows frames drawn a second, frame time, draw calls and triangles, and the engine's time per step and the share of a core it needs at the speed asked for (`web/src/ui/perfOverlay.ts`; the same numbers on `__ZG__.perf`). The rate shown with the clock is now measured over whole seconds (it was overstated at low speeds).
    - The terrain is drawn in tiles that get coarser with distance (`web/src/world/terrainLod.ts`): a quadtree whose tiles all have 64 by 64 cells, from the whole map down to tiles at every second height sample (50 m cells, as before), split while their height error on the screen exceeds 1.5 pixels. Coarser tiles are lowered by as much as they rise above the finest surface, so they never cover roads, lots or buildings; skirts hide the gaps. Shading comes from a texture of normals at every height sample (25 m), so relief looks the same or sharper at any distance. The City's planned land use is drawn into the terrain's colour rather than as a second terrain mesh. The ground beyond the map has the map's rectangle cut out.
    - The road overview's lines are simplified within 2 m (57 % fewer segments), and minor roads' lines are split into 4 km squares so those off the screen are not drawn.
    - Vehicles are drawn as boxes with a roof and lamps (about 48 triangles) above 1.2 km of view height, where a car is a few pixels long.
    - Triangles drawn now: 0.3 million for the whole City on the map (was 2.7), 0.5 to 0.8 million in the isometric view and on the map at 3 km (2.3 and 4.4), 0.3 million at street level (2.1), 0.8 million in the 3D view from 2.5 km (4.6). The smoke tests, drawn in software, take 13 minutes instead of 22.
    - Route searches (`sim/src/router.rs`), half the engine's time, are a little faster without changing a single route: each edge's search state in one record, the landmark bound computed without branches over a row per edge, and heap entries in one 64-bit key. From 06:00 to 07:30 the engine finds exactly the same routes and traffic, its route searches take 14 % less time and the whole run 8 % less; on its own (`sim/examples/routes.rs`) a search settles an edge in 129 ns instead of 174 ns, but inside the engine each search starts with cold caches.
    - Tried and left out: weighting the heuristic by how slow traffic is (1.2 times the ratio, up to 1.8) and never re-opening a settled edge cut route search time by 40 % and the whole run by 20 %, but over a simulated day 10 instead of 13 of the 47 independent count stations came within 25 %, county and local roads carried 0.67 of their counts instead of 0.84, and 29 % instead of 34 % of the station-hours had a GEH below 5. Without the weighting (only never re-opening, with 16 landmarks) the day ended with 20,788 vehicles removed from gridlock instead of 14,095 and 15,304 in two runs with today's router. Routes are part of what the counts validate, so they stay as they are.
    - The engine compiled to WebAssembly runs as fast as natively (in Node, V8 as in Chrome: about 20-25 ms a step from 07:00 to 08:00 with 17,000-18,000 vehicles), so a worker with a core to itself simulates the morning peak at about 20 times real time, the rest of the day faster. In headless Chromium, which draws in software on the same cores, it reaches 11-13 times: there the emulated GPU takes 1.6 of the 4 cores.

**Plan (M7 Full demand, approved 2026-10-07).** Accuracy comes first, and the largest gap is that the simulation runs only 60 % of the estimated demand: with more, Zagreb's simulated junctions lock up, because they let less traffic through than the real ones. At 60 %, the counts come out at 0.79 of the real ones in total (state roads 0.65), 13 of 47 stations within ±25 %, and 34 % of station-hours with a GEH below 5. M7 makes the junctions carry what Zagreb's carry, then raises the demand. Every step is checked with a day run against two runs of today (seeds 1 and 2), and pushed to `main` when it holds.

- **M7a, where capacity is lost** (done 2026-10-07).
  - A report from the native runs (`sim/examples/`): for every signalled junction and every approach, vehicles through per hour of green against the saturation flow, and the time lost to blocked exits, yielding, trams and vehicles in the wrong lane; for every roundabout, entries per hour against its circulating flow. It names the junctions that carry least of their capacity, at 60 % demand and at 80 %.
  - As built (`Engine::measure_delay`, `queue_root`; the day runner's `junction_delay.bin`; "Where junctions lose time" in VALIDATION.md; the run example's summary): every 5 simulated seconds, the front vehicle of each queue within 15 m of its stop line is diagnosed, and every stopped vehicle in the queue is charged to the junction ahead by that reason: red light, the road beyond full, giving way, a vehicle just past the line, a wrong lane, a stop sign, still inside the junction. A queue waiting for a full road beyond is also charged to where that road's own queue waits, following full roads downstream along the vehicles' routes: the junction that holds the traffic up. This replaces counting green time against saturation flow, which says nothing where the queue's cause lies elsewhere.
  - First findings, 06:00-08:00 at 60 %: queues stood 3,305 vehicle-hours behind full roads against 1,500 at red lights, so spillback is most of the loss. Traced to where it starts, the worst places were roundabouts (Trnava I. and Resnički put east of the centre, and the D205, D1 and D307 roundabouts at Zabok), where drivers entered the ring after a minute's wait whatever the room at their exit, and stopped on the ring; then a busy priority junction (Osječka ulica at Ulica kneza Branimira, giving way), and motorway slip roads where three lanes narrow to two (vehicles stuck in the lane that ends). So M7c comes before M7b.
- **M7b, left turns inside the junction** (done 2026-10-07). Netconvert's internal junction points, so a left-turning vehicle waits in the junction for a gap in oncoming traffic instead of at the stop line, as drivers do, and straight-on traffic behind it can go. Expected to help most at the centre's signalled junctions.
  - As built: the pipeline exports SUMO's internal junctions (`waitLane`, `waitFoes`: 53,950 points where a turn waits, each with about five lanes it gives way to there: the junction lanes of the movements it crosses and the lanes they come from). A turn with such a point crosses the stop line without giving way to those movements, waits at the point until nobody on them is inside the junction or arrives before it is through (pushing into gaps after a wait, as at a stop line), and while it waits there the oncoming traffic does not wait for it (`Engine::wait_clear`, `Network::waits_for`). Traffic behind it going straight on drives past. The junction builder keeps the points at junctions it leaves alone.
  - Over a whole day, with seeds 1 and 2: 7,970 and 5,808 vehicles removed from gridlock (9,813 and 8,575 with M7d), queues at junctions 76,260 and 59,264 vehicle-hours (90,565 and 83,753), 260 and 313 vehicles standing at 01:00 (563 and 316), the busiest hour at 31 and 36 km/h (30 and 32). The counts come out as before in total (0.82 and 0.82; 0.82 and 0.81), mean difference 65 % and GEH below 5 in 36 % of station-hours; 14 and 13 of 47 stations are within ±25 % (15 and 15), the changes at stations near the threshold, among them the D1 at Veliko Trgovišće (+44 % with seed 2), which gets more traffic once Zabok flows.
- **M7c, roundabouts and lasting gridlock** (in progress).
  - Entering a roundabout gives way to circulating traffic and only enters when the exit ahead has room; the A2/D1 interchange at Zabok and Zagrebačka cesta in Sesvete, jammed through the night today, should clear.
  - As built so far: a driver enters a roundabout only when the road it will leave the ring by has room, however long it has waited (the minute after which drivers push into a full junction no longer applies there), so nobody stops on the ring for a full exit and blocks everyone behind (`Engine::roundabout_exit_has_room`; the pipeline's roundabout flag, which drawn roundabouts carry too). Over a whole day at 60 %: 16 of 47 independent stations within ±25 % (13 in both runs of the day before), state roads 7 of 23 (5), 36 % of station-hours with GEH below 5 (34 %), 11,115 vehicles removed from gridlock (14,095 and 15,304), queues at junctions 97,376 vehicle-hours instead of 127,342, and at 01:00 820 vehicles standing instead of 3,287. The Zabok roundabouts still hold up the most traffic, with about half the time lost.
  - Roads OpenStreetMap gives no lane count (`pipeline/network.py`, `infer_lanes`): netconvert makes them one lane each way, so a short untagged way on a multi-lane road was a one-lane bottleneck: 79 m of Slavonska avenija near Ulica Gordana Lederera, and stretches of Zagrebačka cesta, Jadranska avenija, Radnička cesta and others. Such a way on a motorway, trunk, primary, secondary or tertiary road now takes the fewest lanes of the ways at its ends with the same name or number, class and direction (54 ways). Over a day, with seeds 1 and 2: 15 and 14 of 47 stations within ±25 % (16 on the old network), the total at 0.82 and 0.80 of the counts (0.80), state roads at 0.72 and 0.69 (0.69), 36 % of station-hours with GEH below 5 (36 %), and 16,771 and 11,823 vehicles removed from gridlock (11,115): within the variation between runs. Where the day locks up depends on the seed: with seed 1 the signalled tram junctions of Vukovarska at Držićeva and Savska at Kršnjavoga, with seed 2 Zabok.
  - Zabok after M7d, the place that locks up most with both seeds: the D307 runs one lane each way between a one-lane roundabout in the north, a two-lane one at the D14 and another at the D1, with road pieces under 40 m between junctions. When the D307 fills both ways, the D14 ring fills in a circle (every ring piece's front vehicle waits for room on the next) and nothing can leave it. A third of all roundabout ring pieces in the network are under 1 m long (netconvert's junction outlines take up most of the short edges between a ring's nodes).
  - Tried and left out: a stricter entry rule, room at the exit for the entering driver and for every vehicle already on the ring between it and that exit leaving by the same road, measured behind the last vehicle standing there less what is still driving into the space. With seed 1 Zabok cleared (7,651 vehicles removed, 244 standing at 01:00); with seed 2 it still locked up (9,762 removed against 8,575), and both days had 13 stations within ±25 % instead of 15. The same room measure at every junction's exit as well: 7,925 and 7,989 removed, but 838 and 959 vehicles standing at 01:00 (563 and 316), and 15 and 13 stations.
- **M7d, trams through junctions** (done 2026-10-07). The tram-car crossings where most vehicles get stuck (Vlaška at Draškovićeva, Mesnička at Ilica, Branimirova at Držićeva): trams and cars as movements of one junction with one signal program, and tram priority as ZET has it where known.
  - What was wrong: netconvert joins road junctions a few metres apart into one, and the tram links through them are in that junction's signal program, but it never joins the junctions where only tram tracks meet (track crossings, switches, merges). At the big tram crosses these lie on track pieces under a metre long just past the road junction: 22 of them at Vukovarska and Držićeva. A tram waiting at one for another tram stood across the road junction and held up cars with a green light, for up to three minutes when trams waited for each other. With seed 1 the day locked up there (1,486 vehicles removed on Vukovarska alone).
  - Tram junctions joined (`pipeline/network.py`, `tram_joins`): the pipeline runs netconvert twice. From the first network it takes every tram-only junction within 3 m of the area a road junction covers (its outline's convex hull) and joins it into that junction, with the OSM nodes netconvert joined there; the second run builds them as one junction. 59 road junctions take in tram junctions. Vukovarska at Držićeva becomes one junction of four road and four tram approaches, each tram path through it one movement under the one program. The projects reuse today's joins. The network step takes about 3 minutes, netconvert running twice.
  - Actuated signals skip phases nobody waits for (`Engine::skip_idle_phases`), as actuated controllers do: a tram phase with no tram near, a protected turn with nobody turning. A green stays while nobody waits for another phase, instead of ending in a yellow for nobody. A link whose lane in is too short to show who waits for it (under 20 m, or 52 m where trams run, since a 32 m tram waits at the signal before) always counts as waiting, or its phase would never come.
  - A driver's impatience at a give-way (pushing in after 15 s, the courtesy of letting the longest waiting go first) no longer counts time standing at a red light; entering a full junction after a minute still does, since between signals a metre apart the way on may only clear while the light is red.
  - Over a whole day, with seeds 1 and 2: 15 and 15 of 47 stations within ±25 % (15 and 14 before), the total at 0.82 and 0.81 of the counts (0.82 and 0.80), state roads at 0.71 and 0.71 (0.72 and 0.69), and 35 % and 36 % of station-hours with GEH below 5 (36 % and 36 %). Gridlock: 9,813 and 8,575 vehicles removed (16,771 and 11,823), queues at junctions 90,565 and 83,753 vehicle-hours (107,285 and 95,057), 563 and 316 vehicles standing at 01:00 (812 and 769). No tram junction is among the places where most vehicles get stuck now; Zabok (D14, D307, D1) and Slavonska avenija are.
  - Tried: skipping phases without the 52 m rule for tram lanes cut queues further (83,637 and 67,852 vehicle-hours), but trams waiting at the signal before a short track piece never called their phase, and 100-200 trams a day were removed at each of several places (Savska cesta, Ilica, Dubrava).
  - Not done: tram priority as ZET has it. ZET's priority rules are not published; trams get the phases netconvert guessed for them.
  - Diagnostics: the run example's `WATCH_JUNCTIONS` prints the junctions' signal programs as the engine runs them and what holds up the vehicles inside them. A panic in the WebAssembly engine now says what it panicked at: the smoke test that makes a roundabout and undoes it failed once in CI and once in 27 local runs with the engine stopped inside a network swap, and the next failure will name the line.
- **M7e, lane choice.** Vehicles choose their lane for the next two or three turns before a junction rather than at it; in the morning peak today about 25,000 route searches an hour are not for trips starting (estimated from the search counts), most of them vehicles that missed their lane routing again.
- **M7f, full demand.** Raise the simulated share of demand in steps (70 %, 80 %, 100 %) as the steps above allow, recalibrating trip rates or the hourly profile only where the counts show it is needed. Targets: a full weekday at 100 % without lasting gridlock (under 1 % of trips removed), the total within 10 % of the counts, at least 25 of 47 stations within ±25 %, and at least half the station-hours with a GEH below 5.
- Data that would help: the City's signal timings for its main junctions (they are not published; a request to the City's traffic office might get them), and Hrvatske ceste's counts by vehicle class (their CSV files, which their site refuses to plain clients).
- Later milestones to choose from after M7: public transport tools (tram and bus lines, stops, frequencies), policies (parking pricing, a congestion charge, a low-emission zone), HŽ trains, and pedestrians and cyclists.

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
| **M6 Polish and live** | Day/night, weather, vehicle models, sound, performance; live weather (live ZET vehicles skipped) |
| **M7 Full demand** | Junctions that carry what Zagreb's do (left turns inside junctions, roundabouts, trams, lane choice), then all of the estimated demand, validated against the counts |

## Risks and open questions

- **Whole-city simulation performance in the browser.** Mitigations: simulation level of detail, and WebAssembly threads. Threads need cross-origin isolation, which GitHub Pages only gets through a service-worker shim; Cloudflare Pages supports it natively.
- **WebGPU maturity.** The app renders with WebGL 2 by default and WebGPU is opt-in (`?webgpu`). three.js r186 needed a shim for some Chrome versions, and the WebGPU path can't be verified in the headless test environment. We switch the default once it is verified on real devices, or when we need compute shaders.
- **Traffic-light timings are not public.** We infer them, and ask the City if possible.
- **ZG3D is based on 2008 aerial imagery.** We merge it with OSM for newer buildings.
- **Hosting limits** (GitHub Pages about 1 GB). Mitigations: compact binary formats; move large assets to Cloudflare R2 if needed.
- **Licences.** Attribution for OSM (ODbL), Copernicus, ESA, the City of Zagreb, DGU, ZET and the others.
