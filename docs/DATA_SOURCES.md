# Data sources

_Inventory verified by live queries on 2026-10-06. "Not verified" marks anything we could not confirm._

## At a glance

| Source | What we use it for | Licence | Status in the project |
|---|---|---|---|
| Copernicus DEM GLO-30 | Terrain | Copernicus (free, attribution) | ✅ in use |
| ESA WorldCover 2021 | Ground land cover; which roads without a speed limit run through settlements (M7l) | CC BY 4.0 | ✅ in use |
| OpenStreetMap (OSM US Slice extract) | Road network, building types and roof shapes, buildings outside the City | ODbL 1.0 | ✅ in use |
| ZG3D 2022, City of Zagreb | Buildings: 357,683 footprints with measured heights; LoD2 3D models | Otvorena dozvola | ✅ in use (footprints, heights, roof type from volume); LoD2 roofs later |
| ZET GTFS static | Tram and bus routes, stops, timetables | Otvorena dozvola | ✅ in use: weekday timetable on the network |
| ZET GTFS-RT | Live tram and bus positions | Otvorena dozvola, "test purpose only" | M6 (needs a proxy) |
| HŽ Putnički prijevoz GTFS | Train routes, stations, timetables | none stated (published for public use; used with attribution, by the owner's decision) | ✅ in use (M8a): a weekday's trains in the map |
| DZS Census 2021 | Population by district and settlement, commuters | attribution requested | ✅ population of each of the 17 districts and of 384 settlements around the City in use for demand (`pipeline/data/census_2021_settlements.json`) |
| Hrvatske ceste counts 2025 | Calibration (AADT and hourly profiles at counting stations) | page says Otvorena dozvola, PDF says all rights reserved | ✅ 156 stations in and around the map, 90 with hourly profiles (`pipeline/data/hc_counts_2025.json`): traffic across the map's edge, the hourly demand profile and [validation](VALIDATION.md) |
| Transport Master Plan (2020) | Calibration targets: trip rates, modal split | reports, no licence | M3 |
| City road closures feed | Live closures | Otvorena dozvola | ✅ copied every 15 min to the `live-data` branch (`.github/workflows/live-data.yml`); drawn in the app, routed around |
| City of Zagreb cycle lanes (geoportal) | Where bikes ride apart from cars (M8d) | Otvorena dozvola | ✅ in use (`pipeline/cycling.py`), with OSM's cycleways |
| City of Zagreb bike counts 2014 (ZG Cycle Unit) | Checking the simulated bikes (M8d) | a presentation on zagreb.hr, no licence seen; figures only, with a link | ✅ 7 sites' daily means (`pipeline/data/bike_counts_2014.json`), in [validation](VALIDATION.md) |
| Croatian online news | Congestion hotspots | headlines and links only | ✅ 107 reports at 39 places (`pipeline/data/news.json`) |
| City of Zagreb planned land use 2023 | Zoning: lots along streets, the plan's zones | Otvorena dozvola | ✅ in use (`pipeline/zoning.py`): lots kept off land the plan keeps open, each lot's planned use, the plan drawn in the Zones tool |
| DHMZ weather XML | Live weather | Otvorena dozvola, DHMZ citation mandatory | ✅ in use: hourly observations for Zagreb copied every 15 min to the `live-data` branch (`weather.json`), shown and driven in the app (M6b) |
| City of Zagreb budget and fee decisions; Croatian project costs | The game's money: income, building costs, upkeep | public documents and news reports; figures only | ✅ in use (`web/src/grow/economy.ts`, section 9) |

## Licences and attribution

**Otvorena dozvola (OD)**, the Open Licence of the Republic of Croatia (licence URI `https://data.gov.hr/id/licence/otvorena-dozvola-rh`), is CC BY-like:

- **Allowed:** commercial and non-commercial use, redistribution, adaptation, combination.
- **Required:**
  - name the source as the publisher states it, plus the date of last modification;
  - mark your changes;
  - don't imply endorsement.
- **Default credit**, when the publisher gives none: "Sadrži informacije tijela javne vlasti u skladu s Otvorenom dozvolom".

The app's credits panel lists every source we ship. When a source is added, its attribution goes into the pipeline's manifest entry.

## 1. City of Zagreb open data portal

The portal is <https://data.zagreb.hr>, a CKAN 2.10 instance with 199 datasets. All but one are under Otvorena dozvola.

- **No CORS** on the portal: data must be fetched at build time or through a proxy.
- The City's ArcGIS organisation (`services8.arcgis.com/Usi0jGQwMmBUpFjr`) serves the same layers with CORS `*`.

### ZG3D 2022: 3D buildings

- **Packages:** `zg3d-2022-3d-model-gz` covers the whole city; there is also one package per city district (17). Licence Otvorena dozvola, metadata modified 2025-05-07.
- **Content:** LoD 2.2, built from 2008 aerial photogrammetry, 2019/2020 drone surveys and 2022 LiDAR plus aerial imagery.
  - 357,683 buildings citywide.
  - Survey year: 54.5 % from 2008 (including most of Donji grad), 45 % from 2022.
- **Formats** (whole city):

  | Format | Size | Contents |
  |---|---|---|
  | GeoJSON | 229 MB | 2D footprints only |
  | FGDB | 329 MB | MultiPatch: real LoD2 walls and roofs |
  | CSV / XLSX | — | Attributes only, no geometry |

  - The district SHP and FGDB files are MultiPatch too: 327 MB zipped, about 3.6 GB unzipped.
  - The GeoJSON footprints are EPSG:4326. Heights are absolute metres; the vertical datum isn't stated (probably HVRS71).
- **Attributes:**
  - `Z_Min` / `Z_Max`: lowest and highest point.
  - `Z_Delta`: their difference. It includes terrain slope, and a few values are outliers up to 203 m.
  - `Godina_izv`: survey year.
  - `Izvor`: survey method.
  - `SArea`, `Volume`.
  - No use, roof type, storey count or address.
- **Browser streaming:** 17 untextured I3S SceneServers, one per district (`…/ZG3D_GC_<District>_2022/SceneServer`), and a FeatureServer `…/ZG3D_2022_3d_model_GZ/FeatureServer/0`.
- **Our use:**
  - Inside the City boundary: footprints and heights (height = `Z_Max − Z_Min` above the lowest ground point), with building type and roof shape taken from the OSM building that contains each footprint.
  - Outside the City: OSM.
  - Later: LoD2 roofs from the MultiPatch files, converted offline.

### Traffic and mobility (CKAN)

| Dataset (slug) | Content | Notes |
|---|---|---|
| `prometnice` (road closures) | JSON / XML / CSV records similar to Waze CIFS: type, street, polyline (lat lon pairs), start and end times | Refreshed every 3 minutes. JSON timestamps are ambiguous (`+00:00` with local clock values). Use the file URLs, not the datastore |
| `o-d-matrica-putovanja` | 308 × 308 zone origin–destination matrix, 1.48 M trips (SUMBooST2 project, 2021) | **No zone geometry**, period, mode or purpose documented. Unusable until the City/FPZ share the zones |
| `topografska-osnova-2018-promet` | 11,157 traffic-area polygons (EPSG:3765) | Surfaces, not a centreline network |
| `geoportal-biciklisticke-staze` | 2,889 cycle-lane lines (268.9 km), last modified 2024-02-28 | ✅ in use (M8d): see "Cycle lanes and bike counts" below |
| `autobusna-stajalista-zet` (1,888 bus stops), `geoportal-tramvajska-stajalista-zet` (260 tram stops), `zeljeznicka-stajalista-hz` (45 rail platforms) | Stops with lines | |
| `geoportal-javne-garaze`, `geoportal-zone-rezerviranih-parkiralisnih-mjesta`, bike parking / share, taxi stands | Parking and mobility points | |
| `izgradene-ceste-u-gradu-zagrebu` | 59 road projects 2020–2024 (no geometry) | |
| `raskrizja-sa-zvucnim-signalizatorima` | 107 intersections with acoustic signals (names only) | The only signal-related dataset |

### Cycle lanes and bike counts (M8d)

- **Cycle lanes:** the GeoJSON resource of `geoportal-biciklisticke-staze`, downloaded at build time into `pipeline/.cache/cycling/`. 2,889 multi-lines, 268.9 km, with a category code (`kategorija_id`: PB 185.1 km, BP 50.6 km, CM 23.2 km, BT 9.6 km, a few others; the codes are not documented), the street, the surface and the district. The pipeline takes every category, adds OSM's cycleways, cycle-designated paths and roads tagged with a cycle lane or track (5,031 ways), and gives a road a cycle track where one runs within 12 m alongside it for half its length or more: 5,338 edges, 412 km (both directions counted apart). Paths away from roads (the Sava's embankments, parks) are not in the network.
- **Bike counts:** the City's ZG Cycle Unit presentation "Promet biciklista" (January 2015, [PDF](https://www.zagreb.hr/userdocsimages/arhiva/ZG%20CYCLE%20UNIT/Prolasci_biciklista_2014Bike_broja%C4%8Di.pdf)): the bike totem on Trg Stjepana Radića from 30 May 2014 (1,034 a day on average to the end of 2014; 606,242 in its first year, about 1,660 a day, in [a second presentation](https://www.zagreb.hr/userdocsimages/arhiva/Prolasci_biciklista_Bike_totem_2014_2015.pdf)) and portable counters, 7 days at each of 8 more places from 16 September 2014. The daily means both ways, and where each counter stood (read off the presentation's map, so approximate), are in `pipeline/data/bike_counts_2014.json`; the two counters on the Sava's embankments (Bundek, 156 a day, and Jarun, 243) are left out, as the network has no paths there. Counts at the other places: Zagrebačka avenija 1,205, Ulica kneza Branimira 374, Savski most 2,415, Most slobode 1,062, Ulica Savezne Republike Njemačke 300, Ulica Božidara Magovca 163. The simulated bikes are taken on the counted street's nearest road both ways (a divided road's two carriageways); at Savski most, which carries only pedestrians and cyclists and is not in the network, on Jadranski most beside it, and at Most slobode on Avenija Većeslava Holjevca, the road over it. The map puts counter 05 on the axis of Most slobode, but the presentation names Ulica Savezne Republike Njemačke, 800 m east, which is used. Newer counts were not found published.
- **Bike trips:** about 42,000 a weekday, an estimate: 3 % of trips in the Transport Master Plan survey (section 5). The City's bike share and parking points are not used.

**Not published anywhere:** city traffic counts, a traffic-signal inventory or timing plans, speed limits, a routable official road network.

### Boundaries, addresses, population, land use

Official DGU register of spatial units (RPJ), dated 2025-02-03, EPSG:3765:

- City boundary `grad-zagreb-prostorna-jedinica`: 641.2 km².
- 17 city districts `gradske-cetvrti-prostorna-jedinica-mjesne-samouprave-za-podrucje-grada-zagreba` (SHP, field `JMS_IME`): ✅ in use; each district's census population is spread over its own homes.
- 218 local committees (mjesni odbori).
- 68 settlements, matching the 2021 census.

Other datasets:

- **Street names register:** 5,489 streets, no geometry.
- **Planned land use (GUP/UPU zoning), `geoportal-planirana-namjena-2023`:** ✅ in use for zoning (M5a). 8,999 polygons (GeoJSON in EPSG:4326, 35 MB; also SHP, CSV, KML, XLSX on ArcGIS Online), last modified 2024-09-13. A mosaic of the plans in force in 2023: 4,370 polygons from the general urban plan (GUP), 2,155 from urban plans (UPU), 2,111 from the City's spatial plan and 363 from detailed plans (DPU), covering the whole City (644 km²) without overlaps. Fields: `Namjena` (use), `Skupna_namjena` (group of uses, 20 values), `Analitika`, `Naziv_plana` (plan), `Izradivac_plana`, `Izvorno_kartografsko_mjerilo` (scale), `Godina_zadnje_izmjene`. By group: forests 175 km², farmland 162 km², mainly residential 111 km², public green 37 km², transport 31 km², protective green 30 km², economic 18 km², sport 17 km², water 14 km², public and social 11 km², business 6 km², mixed 10.5 km².
- **Actual land use 2020:** attributes on CKAN; the geometry (33,497 polygons) is only on ArcGIS.
- **Topographic base 2018:** objects, vegetation, water (EPSG:3765).
- **Schools, kindergartens, universities, health facilities:** points.

**ArcGIS-only layers.** These are queryable with CORS but **have no licence stated**; ask the City before shipping them.

- Address points (137k).
- Population 2011/2021 by local committee.
- 2011 census circles (4,931).
- GUP planned road hierarchy (`PrometGUP`).
- `ZG_DTM_2024`: 0.4 m terrain, LERC tiles.

Two layers carry a **restrictive** DGU clause (use only for approved purposes): cadastral buildings (`zgrada_DKP_prikaz`) and RPJ street lines.

## 2. ZET public transport

### Static GTFS

- **URL:** `https://www.zet.hr/gtfs-scheduled/latest`.
- **Licence:** Otvorena dozvola, per the official page <https://www.zet.hr/preuzimanja/odredbe/datoteke-u-gtfs-formatu/669>.
- **Updates:** every 1–4 weeks. Versioned files are at `…/gtfs-scheduled/scheduled-000-000NNN.zip`.
- **Version 396** (2026-09-28):
  - 154 routes: 19 tram, 135 bus.
  - 2,525 stops plus 1,275 parent stations.
  - 66,661 trips.
  - `shapes.txt` is present: 570 shapes.
- **Quirks:**
  - All `calendar.txt` weekday flags are 0. Service comes only from `calendar_dates`: 95 dates, 2026-09-28 → 2026-12-31.
  - Three Kvaternikov trg stops (`236`, `236_10`, `236_13`) have bogus coordinates.
  - `shape_dist_traveled` is empty.
  - Some shapes wander: tram line 3's (`3_3`) is 61.7 km long for a route of about 10 km, running back and forth past its stops, so the shape's direction at a stop can be the wrong way. Tram stops therefore go on any tram track within 30 m, and each run of stops takes the tracks with the quickest way between them (as HŽ's stations do). Bus stops go on a lane running the way the shape does where it passes them, taken in the order the stops are served (a route running out and back along one street passes each stop on both sides).

- **In the app (M9a):** the transit step names each stop visit's stop (`transitStopRef`) and writes `transit/lines.json`: the stops called at with their names and positions, each line's stop patterns and each trip's headsign. ZET's route colours are all white in the feed, so lines are coloured by mode.
- **Trip lengths (M9b):** `lines.json` also gives each trip's whole length (`tripMetres`): along its route's shape for ZET's trips, straight from station to station inside the map for HŽ's (an underestimate). On 2026-09-30 the weekday timetable runs 43,276 tram-km and 90,122 bus-km (`transit.json`: `tramKm`, `busKm`).

### GTFS-RT

- **URL:** `https://www.zet.hr/gtfs-rt-protobuf`, labelled "TEST PURPOSE ONLY".
- **Content:** one feed with about 510 TripUpdates and 318 VehiclePositions. Positions carry latitude and longitude only, with no bearing or speed.
- **Updates:** every ~10 s.
- **No CORS**, so it needs a proxy for the live layer.

The national access point also lists ZET and HŽ GTFS, but under a contract with a fee. Use zet.hr.

## 2b. HŽ trains

- **URL:** `https://www.hzpp.hr/GTFS_files.zip` (also `http://www.hzpp.hr/Media/Default/GTFS/GTFS_files.zip`, linked from data.gov.hr). It downloads with a plain client.
- **Listing:** <https://data.gov.hr/ckan/dataset/vozni-red-h-putni-kog-prijevoza-u-gtfs-obliku>, by HŽ Putnički prijevoz d.o.o., "so the public can easily read the data", last updated 2026-04-15.
- **Licence:** none stated ("Ne postoji licenca"). Used with attribution in the app and here; the raw files are downloaded at build time and never committed. The national access point's copy is under a paid contract; this is HŽPP's own free download.
- **Feed (downloaded 2026-10-09):** 143 routes (138 rail, 5 replacement bus), 460 stops (45 inside the map), 44,491 trips, 616,353 stop times. No `shapes.txt` and no `calendar_dates.txt`: service comes from 45,647 `calendar.txt` ranges (mostly one week each) from 2025-12-08 to 2026-12-13. Times to the minute.
- **On 2026-09-30 (a Wednesday, ZET's service date):** 748 trips run (727 of them trains), 292 trains call at a station inside the map and 291 are simulated; Zagreb Glavni kolodvor 264 calls, Dugo Selo 133, Zaprešić 118, Maksimir 118, Sesvete 111, Zabok 109. All 44 stations inside the map with calls that day are served.
- **In the app (M8e):** the transit step also writes each station in the map with its trains that day (`transit/stations.json`: times, train numbers, where each comes from and goes), for the station panel on the traffic map. Trains have no headsign in the feed; where a train goes is its last station in the feed.
- **Quirks:**
  - Without shapes, a station's track is one of those within 80 m running from the station before towards the station after, and each trip takes those with the quickest way between them: the nearest platform track can be one the train's own track does not lead to without turning back at a siding kilometres away. At a train's first and last station, any track within 80 m will do: the line from Zagreb Klara runs north into Glavni kolodvor's east-west platforms.
  - OSM draws most railways one way: netconvert takes them as one-way, so the pipeline marks main-line tracks without a direction as usable both ways.
  - OSM gives 20 km/h on stretches of the M102 and M103 near Dugo Selo (1.5 km on the M103, for example), which the timetable does not allow for: 31 legs between stations take longer at the speed limits than the timetable gives, by up to 127 s.

## 3. Census 2021 (DZS)

**Files:**

- <https://podaci.dzs.hr/media/td3jvrbu/popis_2021-stanovnistvo_po_gradovima_opcinama.xlsx>:
  - rows for each of the 17 Zagreb city districts;
  - sheet 6: population by age;
  - sheet 18: daily and weekly commuters by destination type.
- <https://podaci.dzs.hr/media/rqybclnx/popis_2021-stanovnistvo_po_naseljima.xlsx>: age × sex by settlement (68 in the City; join on name).

**Population:**

- City of Zagreb: **767,131**.
- By district:

  | District | Population |
  |---|---|
  | Brezovica | 12,046 |
  | Črnomerec | 38,084 |
  | Donja Dubrava | 33,537 |
  | Donji grad | 31,209 |
  | Gornja Dubrava | 58,255 |
  | Gornji grad–Medveščak | 26,423 |
  | Maksimir | 47,356 |
  | Novi Zagreb–istok | 55,898 |
  | Novi Zagreb–zapad | 63,917 |
  | Peščenica–Žitnjak | 53,023 |
  | Podsljeme | 18,974 |
  | Podsused–Vrapče | 44,910 |
  | Sesvete | 70,800 |
  | Stenjevec | 53,862 |
  | Trešnjevka–jug | 65,324 |
  | Trešnjevka–sjever | 52,974 |
  | Trnje | 40,539 |

- **Settlements** (`pipeline/census.py` → `pipeline/data/census_2021_settlements.json`): 2,287 settlements in the five counties the map covers. Around the City, each settlement's population is spread over the homes inside its OpenStreetMap boundary (admin level 8); 384 settlements match by name and town (or by a name used once in these counties, or the town of the nearest matched settlement), 2 do not.

**Commuters** (sheet 18 of the towns workbook): 70,566 Zagreb residents commute daily. From the towns around the City, daily commuters to another county (for Zagreb County, the City) number 14,760 from Velika Gorica, 6,904 from Samobor, 6,251 from Zaprešić, 4,488 from Sveta Nedelja, 4,472 from Dugo Selo, 2,725 from Sveti Ivan Zelina and 2,557 from Brdovec. No municipality-to-municipality origin–destination matrix is published.

**Licence:** not stated explicitly. The workbooks ask users to cite DZS.

## 4. Traffic counts: Hrvatske ceste "Brojenje prometa" 2025

- **Page:** <https://hrvatske-ceste.hr/hr/stranice/promet-i-sigurnost/dokumenti/14-brojenje-prometa>. It refuses plain clients (HTTP 422), but the files it links download with one.
- **CSV:** `…/2016/Promet_na_cestama_Republike_Hrvatske_2025.csv`, 48 kB.
  - 914 stations (912 with a count): road number, station ID and name, PGDP (AADT), PLDP (average daily traffic in July and August), counting method (NAB continuous automatic, PAB periodic automatic, NB toll), and the counted section: the roads or interchanges at its ends and its length.
  - Encoding cp1250, separator `;`, decimal comma. Road numbers: motorways `A1`; state roads as a bare number of up to three digits (`1` is the D1); county roads four digits (`3063`, Ž3063); local roads five (`31102`, L31102); `ner.` an unnumbered road.
  - Legend: `…/2021/Objasnjenja_kratica_i_oznaka.csv`.
  - **No coordinates.**
- **PDF:** `…/2010/Brojenje_prometa_na_cestama_Republike_Hrvatske_godine_2025.pdf`, 911 pages, 77 MB. Chapter 7 has a page of charts for each of 305 stations counted all year: daily traffic over the year, the average traffic in each hour of the day (for the year, the summer and the rest of the year) and on each day of the week, and the 200 busiest hours. The charts are vector drawings with axis labels, so their values can be read exactly; the hourly line averaged over the year sums to the station's PGDP within 1 %.
- **Vehicle-class CSVs** (with PGDP history for 2021–2024): linked only from the page, which refuses plain clients; not downloaded.
- **Licence conflict:** the page says Otvorena dozvola; the PDF says all rights reserved. The project commits only data derived from them, with attribution.

**In use** (`pipeline/hc.py` → `pipeline/data/hc_counts_2025.json` → `pipeline/counts.py`):
- 156 stations in and around the map (about 20 km beyond its edge), 54 of them inside it, placed on OpenStreetMap roads: OSM tags Croatian roads with the same numbers (`D1`, `3063`, `31102`), so each station's section is found between the junctions with the roads it is named by, as the pair of junctions whose distance along the road best matches the section's length. Interchanges come from OSM's motorway junction names. The Velika Mlaka station, on an unnumbered road, is placed by hand on Zagrebačka cesta.
- 90 of them have hourly and weekday profiles read from the charts.
- Counts are compared for an average working day outside the summer: 7.6 % above PGDP at the median charted station.
- Where a counted section crosses the map's edge (or ends within 2.5 km of it), the gateway there carries its count (`pipeline/gateways.py`).
- The other stations inside the map are independent checks ([VALIDATION.md](VALIDATION.md)).

The city street network has no stations; the toll-free Zagreb bypass (A3 Jankomir–Lučko–Ivanja Reka) has none either.

## 5. Transport Master Plan (2020)

**Documents:**

- Final plan: <https://www.ipzp.hr/wp-content/uploads/2016/01/KI-MPS.pdf>.
- Draft with the survey chapter (§5.1.9, pp. 148–161): on zagreb.hr.
- Phase I final report in English, with the model description (§3): <https://www.ipzp.hr/wp-content/uploads/2016/01/06_MPPS-GZZZKZZ_FinR_ENG.pdf>.

**Survey results** (City of Zagreb), which become calibration targets:

- Household survey of 2,514 households.
- 2.8 persons and 1.2 cars per household; 20 % of households have no car.
- 1.84 trips per person per day.
- Modal split: more than 46 % car, 40 % public transport (55 % of it tram, 36 % bus, 4 % rail), 11 % walk, 3 % bike.
- Boardings: tram 513,810 per day; ZET bus 343,549 per day.

- By county (Phase I final report, tables 2-1, 2-2 and 3-3): cars per household 1.2 in the City, 1.5 in Zagreb County, 1.4 in Krapina-Zagorje County; trips per person 1.84, 1.90 and 1.84; car's share of trips other than walking 52.2 %, 67.3 % and 80.3 %. The demand uses these ratios for car trips per resident around the City (`CAR_TRIP_RATE` in `pipeline/demand.py`).
- 2.2 million person trips and almost 1.3 million vehicle trips per weekday in the Master Plan area (the City and the two counties), 1.1 million of them by car.

**Model:**

- Classic four-step model, 6 trip purposes.
- Home–work trip rate 0.91 per person.
- Modelled split (walking excluded): car 52.2 %, public transport 44.1 %, bike 3.7 %.
- Peak period 6–9.

**Not published:**

- the count books (automatic counts at 124 locations and 72 turning counts);
- the model files;
- the zone geometry.

## 6. Terrain and imagery

| Source | Resolution | Licence | Notes |
|---|---|---|---|
| Copernicus GLO-30 | 30 m surface model | free, attribution | **In use.** Buildings are flattened out in built-up areas |
| DGU INSPIRE Elevation (ATOM) | 20 m terrain model, EPSG:3045 GeoTIFF; tiles `RH_ELEV_93/94/106/107` cover Zagreb | ambiguous: open-data page says open, ATOM rights say restricted | Better terrain once the licence is confirmed |
| City `ZG_DTM_2024` (ArcGIS ImageServer) | 0.4 m terrain model, LERC tiles, CORS | **not stated** | Excellent; ask the City |
| DGU orthophoto WMS `DOF` | ~0.5 m | no reuse licence stated, no CORS | Reference overlay via a proxy |
| DGU `DOF_LIDAR_2022_2023` | ≤ 0.25 m | | Watermarked "GEOPORTAL"; don't use |

## 7. OpenStreetMap

- **Source:** extracts of the world area from **OSM US Slice** (`slice.openstreetmap.us`), minutely updated.
- **Unusable alternatives:**
  - Geofabrik and Overpass don't respond from the development cloud.
  - The openstreetmap.fr Croatia extract no longer exists.
  - The BBBike Zagreb extract misses 10 % of the City (southern Brezovica, eastern Sesvete).
- **Completeness inside the City:**
  - `maxspeed` on 19 % of drivable km (56 % of main roads).
  - `lanes` on 24 % (80 % of main roads).
  - `turn:lanes` on 7 % of main roads.
  - About 1,300 traffic-signal nodes.
  - 133 km of tram track.
  - 122k buildings, of which only ~1 % have a height.
- **Cycleways (M8d):** 5,031 ways that are cycleways, paths or footways designated for bikes, or roads tagged with a cycle lane or track (`cycleway`, `cycleway:right`, `cycleway:left`, `cycleway:both`), used with the City's cycle lanes.
- **Pedestrian crossings (M8c):** 9,773 `highway=crossing` nodes in the extract (October 2026): about 1,800 `crossing=marked`, 1,600 zebras, 1,500 with traffic signals, 1,100 uncontrolled, 600 unmarked and 1,300 with no kind. 8,095 lie on a drivable road the network has (unmarked ones left out: drivers need not give way there): 6,514 zebra or marked, 1,238 at a signalled junction and 343 with signals of their own.
- **Pedestrian counts:** none open were found for Zagreb. Pedestrians a day per crossing are estimated from the homes and jobs within 400 m (0.3 uses a day per person beside a crossing, fewer further off) and the tram and bus stops within 150 m (6 pedestrians per bus or tram stopping): 494 a day at the median crossing, 2,000-7,000 at the busiest (by big stops and along Ilica), 4.4 million crossings in all. The hourly shares are estimated too, busiest from the morning commute through the afternoon.

## 8. Live feeds

| Feed | URL | Update | Access |
|---|---|---|---|
| Road closures | data.zagreb.hr `prometnice` (`…/download/data.json`) | 3 min | Open, no CORS |
| ZET vehicle positions and delays | `https://www.zet.hr/gtfs-rt-protobuf` | ~10 s | Open (test), no CORS |
| Weather (Zagreb-Grič, Maksimir, airport) | `https://vrijeme.hr/hrvatska_n.xml` | hourly | Open, cite DHMZ, no CORS |
| HAK events and roadworks, HC traffic counters | National access point <https://www.promet-info.hr/hr/datasets> (DATEX II, GeoJSON) | ≤ 1 min / ≤ 1 h | **Registration required** (free licence for most feeds) |

None of the open feeds send CORS headers. The static site needs a small scheduled job (for example a GitHub Action) or a serverless proxy (for example a Cloudflare Worker) that republishes them as static JSON.

## 9. Budget and costs (M5e)

Figures the game's money is built from (`web/src/grow/economy.ts`), checked on 2026-10-07. Sums are in euros without VAT; kuna are converted at the fixed rate of 7.5345.

| Figure | Value | Source |
|---|---|---|
| The City's income, 2025 | €2.74 billion, of which income tax €1.38 billion (all of it the City's) and communal contributions and fees €143 million | [Kratki vodič kroz proračun Grada Zagreba za 2025.](https://zagreb.hr/UserDocsImages/arhiva/financije/proracun%202025/Kratki%20vodi%C4%8D.pdf) |
| Capital spending on city streets (*nerazvrstane ceste*), 2025 | €63.9 million | the same guide |
| Extraordinary maintenance of city streets, 2024 | €20,999,300 (cut from €27,363,000), in a programme of €52.0 million with street lighting and pedestrian areas | [Program održavanja … i izvanrednog održavanja nerazvrstanih cesta … u 2024.](https://informator.hr/zakoni/648057-program-odrzavanja-javnih-prometnih-povrsina-gradevina-i-uredaja-javne-namjene-javne-rasvjete-te-izvanrednog-odrzavanja-nerazvrstanih-cesta-na-podrucju-grada-zagreba-u-2024) |
| Length of city streets | 2,761 km, 4,986 lane-km: streets inside the City on the simulated network, service roads and motorways left out (measured, not published) | `web/public/data/network` and the City's boundary |
| Communal fee point value (housing, zone I) | €1.39 per m² of usable floor a year, since 2024 | [Odluka o vrijednosti boda komunalne naknade](https://www.zagreb.hr/UserDocsImages/guprostorno-normativa/02%20Prijedlog%20odluke-%20vrijednost%20boda.pdf) |
| Communal fee purpose coefficients | offices, finance, IT 10.00; non-food retail 9.00; food retail 8.50 | [draft amendment to the Odluka o komunalnoj naknadi, 2023](https://www.zagreb.hr/UserDocsImages/guprostorno-normativa/PRIJEDLOG%20ODLUKE%2016.01.2023..docx) |
| Communal contribution, zones I-VI | €18.35, 18.00, 16.00, 12.00, 2.00, 1.50 per m³ | Odluka o komunalnom doprinosu, consolidated text from 24 July 2025 ([informator.hr](https://informator.hr/doks/981002)) |
| Branimirova's extension, first phase | €4.4 million for just over 1 km of four lanes with pavements, cycle paths and four junctions with lights; all three phases about €20 million | [tportal, 11 June 2024](https://www.tportal.hr/vijesti/clanak/pustena-u-promet-produzena-branimirovu-evo-kako-izgleda-foto-20240611) |
| A11 motorway, Jakuševec-Velika Gorica | 780 million kuna for 9.5 km of four lanes | [tportal, 1 February 2021](https://www.tportal.hr/biznis/clanak/plenkovic-najavio-natjecaj-za-zavrsetak-autoceste-zagreb-sisak-20210201) |
| Jarunski most | €140 million estimated, without VAT, for a bridge 625 m long and 40 m wide: two lanes each way, tram tracks, cycle paths and pavements | [tportal, 5 May 2026](https://www.tportal.hr/vijesti/clanak/tomasevic-predstavlja-veliki-projekt-na-zapadu-zagreba-otkriva-detalje-izgradnje-jarunskog-mosta-20260505) |
| A roundabout | Pavlovac, Rijeka: €947,490.59 contracted in January 2025 | [Novi list, 31 January 2025](https://www.novilist.hr/?p=1386545) |
| New traffic signals | €198,900 in Zagreb's 2023 programme of works | the City's 2023 programme of works for transport and communal services |
| ZET's operating costs and vehicle-km, 2024 (M9b) | €209.6 million of operating costs (staff €117.1 million, depreciation €26.1 million, energy €25.1 million); 10,566,926 tram-km at a mean 12.49 km/h and 27,724,224 bus-km at 17.96 km/h; 179.1 million passengers | [ZET, Poslovno izvješće 2024.](https://www.zet.hr/UserDocsImages/Dokumenti%20i%20obrasci%20za%20preuzimanje/Poslovna%20izvje%C5%A1%C4%87a%20ZET/Poslovno%20izvjesce-2024.godina.pdf) |

Not found, and estimated instead: the communal fee's zone coefficients and the coefficient for production premises, the cost of a roundabout with two lanes, of new signal timings, signs and markings, and the upkeep of bridges and lights. ZET does not split its costs between trams and buses: the game shares them by the hours each ran (km over mean speed), as drivers' pay is most of them, which gives €7.00 a tram-km and €4.90 a bus-km. A year's service is taken as the weekday timetable's km times 244 for trams and 308 for buses (ZET's 2024 km over the weekday timetable's). The new signals' figure is the whole line in the 2023 programme, which may cover more than one junction.

## Gaps and data requests

Requests to the City of Zagreb (transport office / Gradski ured za mobilnost), DGU and FPZ:

1. Traffic-signal inventory and timing plans.
2. City traffic counts: the Master Plan count books (124 automatic, 72 turning counts).
3. Zone geometry for the SUMBooST2 O/D matrix.
4. Licence confirmation for the ArcGIS-only layers: `ZG_DTM_2024`, address model, population by local committee, `PrometGUP`.
5. DGU: the conflicting rights wording on the INSPIRE elevation download.
6. Registration at promet-info.hr for HAK events and HC counters.
