# Data sources

_Inventory verified by live queries on 2026-10-06. "Not verified" marks anything we could not confirm._

## At a glance

| Source | What we use it for | Licence | Status in the project |
|---|---|---|---|
| Copernicus DEM GLO-30 | Terrain | Copernicus (free, attribution) | ✅ in use |
| ESA WorldCover 2021 | Ground land cover | CC BY 4.0 | ✅ in use |
| OpenStreetMap (OSM US Slice extract) | Road network, building types and roof shapes, buildings outside the City | ODbL 1.0 | ✅ in use |
| ZG3D 2022, City of Zagreb | Buildings: 357,683 footprints with measured heights; LoD2 3D models | Otvorena dozvola | ✅ in use (footprints, heights, roof type from volume); LoD2 roofs later |
| ZET GTFS static | Tram and bus routes, stops, timetables | Otvorena dozvola | M2 |
| ZET GTFS-RT | Live tram and bus positions | Otvorena dozvola, "test purpose only" | M6 (needs a proxy) |
| DZS Census 2021 | Population by district and settlement, commuters | attribution requested | ✅ City total in use for demand; districts and commuters in M3 |
| Hrvatske ceste counts 2025 | Calibration (AADT at counting stations) | page says Otvorena dozvola, PDF says all rights reserved | M3 |
| Transport Master Plan (2020) | Calibration targets: trip rates, modal split | reports, no licence | M3 |
| City road closures feed | Live closures | Otvorena dozvola | M3/M6 (needs a proxy or scheduled job) |
| DHMZ weather XML | Live weather | Otvorena dozvola, DHMZ citation mandatory | M6 |

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
| `geoportal-biciklisticke-staze` | 2,889 cycle-lane lines (~269 km) | |
| `autobusna-stajalista-zet` (1,888 bus stops), `geoportal-tramvajska-stajalista-zet` (260 tram stops), `zeljeznicka-stajalista-hz` (45 rail platforms) | Stops with lines | |
| `geoportal-javne-garaze`, `geoportal-zone-rezerviranih-parkiralisnih-mjesta`, bike parking / share, taxi stands | Parking and mobility points | |
| `izgradene-ceste-u-gradu-zagrebu` | 59 road projects 2020–2024 (no geometry) | |
| `raskrizja-sa-zvucnim-signalizatorima` | 107 intersections with acoustic signals (names only) | The only signal-related dataset |

**Not published anywhere:** city traffic counts, a traffic-signal inventory or timing plans, speed limits, a routable official road network.

### Boundaries, addresses, population, land use

Official DGU register of spatial units (RPJ), dated 2025-02-03, EPSG:3765:

- City boundary `grad-zagreb-prostorna-jedinica`: 641.2 km².
- 17 city districts.
- 218 local committees (mjesni odbori).
- 68 settlements, matching the 2021 census.

Other datasets:

- **Street names register:** 5,489 streets, no geometry.
- **Planned land use (GUP/UPU zoning), `geoportal-planirana-namjena-2023`:** 8,999 polygons. This is the basis for game-mode zoning.
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

### GTFS-RT

- **URL:** `https://www.zet.hr/gtfs-rt-protobuf`, labelled "TEST PURPOSE ONLY".
- **Content:** one feed with about 510 TripUpdates and 318 VehiclePositions. Positions carry latitude and longitude only, with no bearing or speed.
- **Updates:** every ~10 s.
- **No CORS**, so it needs a proxy for the live layer.

The national access point also lists ZET and HŽ GTFS, but under a contract with a fee. Use zet.hr.

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

**Commuters:** 70,566 Zagreb residents commute daily. No municipality-to-municipality origin–destination matrix is published.

**Licence:** not stated explicitly. The workbooks ask users to cite DZS.

## 4. Traffic counts: Hrvatske ceste "Brojenje prometa" 2025

- **Page:** <https://hrvatske-ceste.hr/hr/stranice/promet-i-sigurnost/dokumenti/14-brojenje-prometa>. It needs a browser User-Agent and returns 422 to plain curl.
- **CSV:** `…/2016/Promet_na_cestama_Republike_Hrvatske_2025.csv`.
  - 914 stations: road, station ID and name, PGDP (AADT), PLDP (average summer daily traffic), segment.
  - Encoding cp1250, separator `;`, decimal comma.
  - **No coordinates:** stations must be placed by hand from road and segment names.
- **911-page PDF:** per-station hourly and daily profiles (chapter 7). Parseable with `pdftotext -layout`.
- **Vehicle-class CSVs:** include PGDP history for 2021–2024.
- **Licence conflict:** the page says Otvorena dozvola; the PDF says all rights reserved. Cite the source either way.

Selected stations around Zagreb (2025 PGDP, vehicles per day):

| Station | Road | Segment | PGDP |
|---|---|---|---|
| 1916 Lučko–jug | A1 | Lučko–Zdenčina | 49,357 |
| 2027 Zagreb (istok)–istok | A3 | Rugvica–Ivanić Grad | 37,638 |
| 1904 Zaprešić–sjever | A2 | | 27,397 |
| 1910 Bobovica–zapad | A3 | | 18,415 |
| 2002 Sveta Helena–sjever | A4 | | 17,586 |
| 2031 Mraclin–jug | A11 | | 12,422 |
| 2043 Petina | D30 | | 30,419 |
| 1933 Sveta Nedelja | D231 | | 22,764 |
| 1925 Zaprešić–istok | D225 | | 21,161 |
| 2063 Popovec | D3 | | 16,743 |
| 1937 Pojatno | D1 | | 17,459 |
| 2014 Velika Mlaka | unclassified | | 27,614 |

The city street network and the toll-free Zagreb bypass (A3 Jankomir–Lučko–Ivanja Reka) have **no** stations.

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

## 8. Live feeds

| Feed | URL | Update | Access |
|---|---|---|---|
| Road closures | data.zagreb.hr `prometnice` (`…/download/data.json`) | 3 min | Open, no CORS |
| ZET vehicle positions and delays | `https://www.zet.hr/gtfs-rt-protobuf` | ~10 s | Open (test), no CORS |
| Weather (Zagreb-Grič, Maksimir, airport) | `https://vrijeme.hr/hrvatska_n.xml` | hourly | Open, cite DHMZ, no CORS |
| HAK events and roadworks, HC traffic counters | National access point <https://www.promet-info.hr/hr/datasets> (DATEX II, GeoJSON) | ≤ 1 min / ≤ 1 h | **Registration required** (free licence for most feeds) |

None of the open feeds send CORS headers. The static site needs a small scheduled job (for example a GitHub Action) or a serverless proxy (for example a Cloudflare Worker) that republishes them as static JSON.

## Gaps and data requests

Requests to the City of Zagreb (transport office / Gradski ured za mobilnost), DGU and FPZ:

1. Traffic-signal inventory and timing plans.
2. City traffic counts: the Master Plan count books (124 automatic, 72 turning counts).
3. Zone geometry for the SUMBooST2 O/D matrix.
4. Licence confirmation for the ArcGIS-only layers: `ZG_DTM_2024`, address model, population by local committee, `PrometGUP`.
5. DGU: the conflicting rights wording on the INSPIRE elevation download.
6. Registration at promet-info.hr for HAK events and HC counters.
