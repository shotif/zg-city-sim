import * as THREE from 'three/webgpu';

import { CameraRig, type ViewMode } from './camera/CameraRig';
import { type PackedIndex, type TypedArray, loadPacked } from './data/packed';
import {
  type Edit,
  type FrequencyEdit,
  type LineEdit,
  type ResolvedEdit,
  type TransitMatch,
  decodeEditsFromUrl,
  editWords,
  encodeEditsForUrl,
  isNetworkEdit,
  loadSavedEdits,
  parseEdits,
  resolveEdits,
  saveEdits,
  sameTarget,
  serializeEdits,
  withEdit,
} from './edit/edits';
import {
  DIFF_BANDS,
  DIFF_FROM,
  PLACES,
  commonMinute,
  compareStats,
  diffBands,
  summariseTravelTimes,
  type TravelTimeSummary,
  pairTimes,
  ridersRows,
} from './edit/compare';
import {
  type BuiltNetwork,
  type LaneOrigin,
  type NetworkEdit,
  buildNetwork,
  lanePieces,
} from './edit/builder';
import { type ProjectInfo, edgeMap, loadProjects, projectUrl, pullCounts } from './edit/projects';
import { RoadIndex } from './edit/roadIndex';
import {
  LINE_VTYPE,
  type LineMode,
  type LineStop,
  SNAP_STOP,
  STOP_REACH,
  placeStops,
  planWords,
  readPlan,
  stopIndex,
  tripsADay,
} from './edit/lines';
import { type DemandArrays, type EdgeDemand, mergeDemand } from './grow/demand';
import { loadLots } from './grow/lots';
import { BudgetTool } from './grow/budgetTool';
import { CitySound } from './ui/sound';
import { type LineKm, editCost, editsCost, euros, faresFrom } from './grow/economy';
import { type ZoningTool, setUpZoning } from './grow/zoningTool';
import { DATA_URL, type WorldManifest, attributions, loadManifest } from './manifest';
import { SimClient } from './sim/client';
import { STAT, VEHICLE_TYPES } from './sim/wasm';
import { BuildPanel } from './ui/buildPanel';
import { ClosureMarkers } from './ui/closureMarkers';
import { Hud, type HudCallbacks, type Shown } from './ui/hud';
import { NewsPanel } from './ui/newsPanel';
import { RailMarkers, type Station } from './ui/railMarkers';
import { StopMarkers, TransitPanel } from './ui/transitPanel';
import {
  type LinesFile,
  MODE_COLOR,
  type NewWay,
  type Riders,
  type Route,
  Timetable,
  type TimetableArrays,
  readRiders,
} from './world/transitLines';
import { ProjectsSection } from './ui/projectsSection';
import { junctionName } from './edit/signals';
import { RoadDrawer } from './ui/roadDrawer';
import { BuildingLayer, buildingCentres, loadBuildings } from './world/buildingLayer';
import {
  ClosureLayer,
  type PlacedClosure,
  activeClosures,
  loadClosures,
  placeClosures,
  zagrebNow,
} from './world/closures';
import { DrawLayer, EDIT_COLORS, EditLayer } from './world/editLayer';
import { WorldFrame } from './world/frame';
import type { HeightFn } from './world/roadGeometry';
import { RoadLayer } from './world/roadLayer';
import { RoadNetwork, laneShapeHeights, loadRoadNetwork } from './world/roadNetwork';
import { NewsLayer, loadNews, placeTraffic } from './world/newsLayer';
import { loadTerrain } from './world/terrain';
import { type TerrainLayer, outsideGeometry } from './world/terrainLod';
import { ALWAYS_DAY, type Lighting, lighting, litShare } from './world/daylight';
import { litUniform, nightUniform } from './world/nightLights';
import { BuiltArea, StreetLightLayer } from './world/streetLights';
import { Precipitation } from './world/precipitation';
import { sunAt, zagrebOffset, zagrebToday } from './world/sun';
import { TRAFFIC_BANDS, TrafficLayer } from './world/trafficLayer';
import { type CrossingArrays, PedestrianLayer } from './world/pedestrianLayer';
import { VehicleLayer } from './world/vehicleLayer';
import { FrameStats, type Perf, PerfOverlay } from './ui/perfOverlay';
import {
  type LiveWeather,
  WEATHER,
  WEATHER_CREDIT,
  type WeatherKind,
  greyed,
  liveWeather,
  loadWeather,
} from './world/weather';

const SKY = new THREE.Color(0xb9cfe0);
/** Roads a planned project adds, drawn over the map. */
const PROJECT_COLOR = 0x12a4a0;

/** Car trips per weekday without demand data: 767k residents × 1.84 trips × 46 % by car ÷ 1.3. */
const DAILY_TRIPS = 500_000;
/** The simulation starts at 07:00 after filling the streets from 06:50 at full speed, or
 * at `?start=HH:MM` after filling them for ten minutes before. */
const DEFAULT_START = 7 * 3600;
const WARM = 10 * 60;

/** Simulated time (s since midnight) to start at, from `?start=HH:MM`. */
export function startOf(param: string | null): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(param ?? '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return DEFAULT_START;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}
const START = startOf(new URLSearchParams(location.search).get('start'));
const START_TIME = Math.max(0, START - WARM);
const WARM_UNTIL = START;
const LIGHT_KEY = 'zg-city-sim:always-day';
const WEATHER_KEY = 'zg-city-sim:weather';
const WASM_URL = `${import.meta.env.BASE_URL}sim/zg_sim.wasm`;

/** Arrays of a packed data layer (by its index path), or undefined if it fails to load. */
async function loadLayerArrays(
  indexPath: string | undefined,
  what: string,
): Promise<Record<string, TypedArray> | undefined> {
  if (!indexPath) return undefined;
  try {
    const response = await fetch(DATA_URL + indexPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as PackedIndex;
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    return await loadPacked(DATA_URL + folder + index.file, index);
  } catch (error) {
    console.warn(`${what} could not be loaded`, error);
    return undefined;
  }
}

/** Pedestrian crossings (M8c): their arrays, with each hour's share of the day's pedestrians
 * as `crossingHourly`. */
async function loadCrossings(
  indexPath: string | undefined,
): Promise<Record<string, TypedArray> | undefined> {
  if (!indexPath) return undefined;
  try {
    const response = await fetch(DATA_URL + indexPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as PackedIndex & { hourly: number[] };
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const arrays = await loadPacked(DATA_URL + folder + index.file, index);
    return { ...arrays, crossingHourly: Float32Array.from(index.hourly) };
  } catch (error) {
    console.warn('Pedestrian crossings could not be loaded', error);
    return undefined;
  }
}

/** Roads with a cycle track or lane and bike trip ends (M8d): their arrays, with the trips a
 * day as `bikeDaily`. */
async function loadCycling(
  indexPath: string | undefined,
): Promise<Record<string, TypedArray> | undefined> {
  if (!indexPath) return undefined;
  try {
    const response = await fetch(DATA_URL + indexPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as PackedIndex & { bikeTripsDaily: number };
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const arrays = await loadPacked(DATA_URL + folder + index.file, index);
    return { ...arrays, bikeDaily: Float32Array.of(index.bikeTripsDaily) };
  } catch (error) {
    console.warn('Cycle tracks and bike trips could not be loaded', error);
    return undefined;
  }
}

/** HŽ's stations in the map with their trains (M8e), named in the transit index. */
/** The lines' stops and patterns (M9a) with the transit index's route table, named in the
 * transit index; loaded when the Public transport panel first opens. */
async function loadLines(
  indexPath: string | undefined,
): Promise<{ routes: Route[]; file: LinesFile } | undefined> {
  if (!indexPath) return undefined;
  try {
    const response = await fetch(DATA_URL + indexPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as { routes?: Route[]; lines?: string };
    if (!index.lines || !index.routes) return undefined;
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const lines = await fetch(DATA_URL + folder + index.lines);
    if (!lines.ok) throw new Error(`HTTP ${lines.status}`);
    return { routes: index.routes, file: (await lines.json()) as LinesFile };
  } catch (error) {
    console.warn('The lines could not be loaded', error);
    return undefined;
  }
}

async function loadStations(indexPath: string | undefined): Promise<Station[]> {
  if (!indexPath) return [];
  try {
    const response = await fetch(DATA_URL + indexPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = (await response.json()) as { stations?: string };
    if (!index.stations) return [];
    const folder = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const stations = await fetch(DATA_URL + folder + index.stations);
    if (!stations.ok) throw new Error(`HTTP ${stations.status}`);
    return ((await stations.json()) as { stations: Station[] }).stations;
  } catch (error) {
    console.warn("HŽ's stations could not be loaded", error);
    return [];
  }
}

/** What the simulation needs besides the network: where people live and work, timetables. */
interface TravelData {
  arrays: Record<string, TypedArray>;
  dailyTrips: number;
  demandScale: number;
}

/** Start the traffic simulation in a worker on the loaded network. `render`: false for a
 * simulation that is only compared with, not drawn. */
function startSimulation(
  net: RoadNetwork,
  travel: TravelData,
  height: HeightFn,
  speed: number,
  render = true,
): SimClient {
  const arrays = networkArrays(net, height);
  return new SimClient(
    {
      wasmUrl: new URL(WASM_URL, document.baseURI).href,
      // Views share the network's buffer, which is copied once; the heights are moved.
      arrays: { ...arrays, ...travel.arrays },
      seed: 1,
      dailyTrips: travel.dailyTrips,
      demandScale: travel.demandScale,
      startTime: START_TIME,
      warmUntil: WARM_UNTIL,
      speed,
      render,
    },
    [arrays.laneShapeY.buffer],
  );
}

/** A network's arrays as the engine takes them: shapes decoded, heights of bridges. */
function networkArrays(net: RoadNetwork, height: HeightFn) {
  const laneShapeY = laneShapeHeights(net, height);
  return { ...net.arrays, laneShape: net.laneShape, laneShapeY };
}

/** Lane pieces as the engine reads them: four words each, positions as f32 bits. */
function pieceWords(pieces: ReturnType<typeof lanePieces>): Uint32Array {
  const words = new Uint32Array(pieces.length * 4);
  const f = new Float32Array(1);
  const bits = new Uint32Array(f.buffer);
  pieces.forEach((p, i) => {
    words[i * 4] = p.old;
    f[0] = p.from;
    words[i * 4 + 1] = bits[0];
    words[i * 4 + 2] = p.lane;
    f[0] = p.shift;
    words[i * 4 + 3] = bits[0];
  });
  return words;
}

/** Free the geometry of a layer taken off the scene. */
function disposeObject(object: THREE.Object3D): void {
  object.traverse((o) => {
    if ('geometry' in o && o.geometry instanceof THREE.BufferGeometry) o.geometry.dispose();
  });
}

/** Hooks for automated tests and debugging from the console. */
export interface DebugApi {
  ready: boolean;
  /** True once the road network is loaded (or known to be missing). */
  roadsReady: boolean;
  backend: string;
  setView(mode: ViewMode): void;
  /** Centre the view on scene (x, z) showing `viewHeight` metres. */
  lookAt(x: number, z: number, viewHeight: number): void;
  rig?: CameraRig;
  roads?: RoadLayer;
  buildings?: BuildingLayer;
  /** True once buildings are loaded (or known to be missing). */
  buildingsReady: boolean;
  sim?: SimClient;
  vehicles?: VehicleLayer;
  pedestrians?: PedestrianLayer;
  railMarkers?: RailMarkers;
  transit?: TransitPanel;
  timetable?: Timetable;
  traffic?: TrafficLayer;
  news?: NewsLayer;
  newsPanel?: NewsPanel;
  /** Live road closures in force, placed on the network. */
  closures?: PlacedClosure[];
  /** The Build tools, once the road network is loaded. */
  build?: BuildPanel;
  roadIndex?: RoadIndex;
  /** Edits in force, matched to the network. */
  edits?: ResolvedEdit[];
  /** Pick the road at a screen point (CSS pixels in the canvas), as a click would. */
  pickAt?(x: number, y: number): number | undefined;
  /** The simulation of today's roads while comparing (Build panel, Before and after). */
  baseline?: SimClient;
  /** Comparisons shown so far: simulated time of the last measures and travel times. */
  compared?: { stats: number; travel: number; diff: number };
  /** Planned projects, and the one whose network is running (?project=id). */
  projects?: ProjectInfo[];
  project?: string;
  /** The network the player's simulation runs (with any roads drawn), and the roads drawn:
   * their edges, and those that could not be built. */
  network?: RoadNetwork;
  drawn?: { roads: number[][]; problems: BuiltNetwork['problems'] };
  /** The tool for drawing roads. */
  drawer?: RoadDrawer;
  /** The ground point under a screen point (CSS pixels in the canvas). */
  groundAt?(x: number, y: number): { x: number; z: number } | undefined;
  /** The Zones tool, once the lots are loaded. */
  zoning?: ZoningTool;
  /** The City's money. */
  budget?: BudgetTool;
  /** The light now, and the simulated time it is for (M6a). */
  light?: Lighting & { time: number };
  streetLights?: StreetLightLayer;
  /** The city's sound (M6e). */
  sound?: CitySound;
  /** The weather: the player's choice, the kind in force and the live observation (M6b). */
  weather?: { choice: string; kind: WeatherKind; live?: LiveWeather };
  /** How fast the app runs, with `?perf` (M6f): refreshed twice a second. */
  perf?: Perf;
  /** The terrain's tiles (M6f). */
  terrain?: TerrainLayer;
}

declare global {
  interface Window {
    __ZG__?: DebugApi;
  }
}

export async function startApp(container: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const debug: DebugApi = {
    ready: false,
    roadsReady: false,
    buildingsReady: false,
    backend: 'none',
    setView: () => {},
    lookAt: () => {},
  };
  window.__ZG__ = debug;

  let rig: CameraRig | undefined;
  let sim: SimClient | undefined;
  let traffic: TrafficLayer | undefined;
  let newsPanel: NewsPanel | undefined;
  let closureMarkers: ClosureMarkers | undefined;
  /** HŽ's stations and the level crossings, on the traffic map (M8e). */
  let railMarkers: RailMarkers | undefined;
  /** The Public transport panel, the line it shows drawn on the map and its stops (M9a). */
  let transitPanel: TransitPanel | undefined;
  let transitMarkers: StopMarkers | undefined;
  let openTransit: (() => void) | undefined;
  /** Whether the player wants the panel open (it loads its data on first opening). */
  let transitWanted = false;
  /** ZET's and HŽ's lines as the engine runs them (M9a, M9b), once loaded; the trips the
   * engine said it runs, and how often lines run where edits change it (by route). */
  let timetable: Timetable | undefined;
  let serviceNow: Uint32Array | undefined;
  let frequenciesNow = new Map<number, number>();
  /** Public transport's riders as the engine last said (M9d). */
  let ridersNow: Riders | undefined;
  /** New lines' ways sent to the engine with the edits, in order (M9c). */
  let newWaysNow: NewWay[] = [];
  /** Change the edits in force (set up with the Build tools); cost them again once the
   * engine says how far new lines run; the roads (tracks) new lines' stops go on. */
  let changeEdits: (change: (list: Edit[]) => Edit[]) => void = () => {};
  let refreshCosts = () => {};
  let stopRoadsNow: ((mode: LineMode) => RoadIndex) | undefined;
  /** Trains, pedestrians and cyclists drawn (M8e). */
  const shown = new Set<Shown>(['trains', 'pedestrians', 'bikes']);
  let closureLayer: ClosureLayer | undefined;
  let closedEdges: Uint32Array | undefined;
  let buildPanel: BuildPanel | undefined;
  let zoning: ZoningTool | undefined;
  /** Homes and jobs of buildings grown (M5c), today's demand, and the two merged for the
   * player's simulation. */
  let grownDemand: EdgeDemand | undefined;
  let todayDemand: TravelData | undefined;
  let demandNow: DemandArrays | undefined;
  const applyDemand = () => {
    if (!grownDemand || !todayDemand?.arrays.demandEdge) return;
    demandNow = mergeDemand(todayDemand.arrays, todayDemand.dailyTrips, grownDemand);
    sim?.setDemandWeights(demandNow.arrays, demandNow.dailyTrips);
  };
  let baseline: SimClient | undefined;
  let setCompare: (on: boolean) => void = () => {};
  /** The network the player's simulation runs: as loaded, with the roads drawn. */
  let networkNow: { net: RoadNetwork; index: RoadIndex } | undefined;
  /** Replace the layers drawn from the network (roads, traffic) for a changed network. */
  let useNetwork: (net: RoadNetwork) => void = () => {};
  /** Send the network with the roads drawn to a simulation started on the one loaded. */
  let sendNetwork: (target: SimClient, fresh: boolean) => void = () => {};
  let setDiffMap: (on: boolean) => void = () => {};
  let invalidateView = () => {};
  // Edits: from a shared link, else saved in this browser.
  const editsFromLink = /[#&]edits=([^&]+)/.exec(location.hash)?.[1];
  let edits: Edit[] = loadSavedEdits();
  let editWordsNow: Uint32Array | undefined;
  let alwaysDay = false;
  try {
    alwaysDay = localStorage.getItem(LIGHT_KEY) === '1';
  } catch {
    // Storage blocked: light as the time of day.
  }
  // The weather: as observed in Zagreb ('live'), or a kind the player picks (M6b).
  let weatherChoice: 'live' | WeatherKind = 'live';
  try {
    const kept = localStorage.getItem(WEATHER_KEY);
    if (kept && kept in WEATHER) weatherChoice = kept as WeatherKind;
  } catch {
    // Storage blocked: the live weather.
  }
  let live: LiveWeather | undefined;
  const weatherKind = (): WeatherKind =>
    weatherChoice === 'live' ? (live?.kind ?? 'clear') : weatherChoice;
  /** Tell the simulations, the layers and the HUD (set once the scene exists). */
  let applyWeather = () => {};
  // The city's sound (M6e), off until the player turns it on.
  const sound = new CitySound();
  debug.sound = sound;
  const hudCallbacks: HudCallbacks = {
    onSound: (on) => {
      sound.setEnabled(on).catch((error: unknown) => console.warn('No sound', error));
    },
    onWeather: (choice) => {
      weatherChoice = choice === 'live' || !(choice in WEATHER) ? 'live' : (choice as WeatherKind);
      try {
        if (weatherChoice === 'live') localStorage.removeItem(WEATHER_KEY);
        else localStorage.setItem(WEATHER_KEY, weatherChoice);
      } catch {
        // Not kept: storage blocked.
      }
      applyWeather();
    },
    onAlwaysDay: (on) => {
      alwaysDay = on;
      try {
        if (on) localStorage.setItem(LIGHT_KEY, '1');
        else localStorage.removeItem(LIGHT_KEY);
      } catch {
        // Not kept: storage blocked.
      }
      invalidateView();
    },
    onMode: (mode) => rig?.setMode(mode),
    onRotateIso: (direction) => rig?.rotateIso(direction),
    onFaceNorth: () => rig?.faceNorth(),
    onPause: (paused) => {
      sim?.setPaused(paused);
      baseline?.setPaused(paused);
    },
    onSpeed: (speed) => {
      for (const s of [sim, baseline]) {
        s?.setSpeed(speed);
        if (s?.paused) s.setPaused(false);
      }
    },
    onTrafficMap: (enabled) => {
      if (traffic) traffic.enabled = enabled;
      railMarkers?.setVisible(enabled && shown.has('trains'));
      invalidateView();
    },
    onShow: (kind, on) => {
      if (on) shown.add(kind);
      else shown.delete(kind);
      railMarkers?.setVisible(!!traffic?.enabled && shown.has('trains'));
      invalidateView();
    },
    onNews: (enabled) => {
      newsPanel?.setVisible(enabled);
      invalidateView();
    },
    onClosures: (enabled) => {
      closureMarkers?.setVisible(enabled);
      if (closureLayer) closureLayer.object.visible = enabled;
      invalidateView();
    },
    onBuild: (enabled) => {
      // One panel on the right at a time.
      if (enabled && transitPanel?.visible) hud.setTransit(false, hudCallbacks);
      if (enabled && zoning?.panel.visible) {
        hud.setZones(false);
        zoning.setVisible(false);
      }
      if (enabled && budgetTool.panel.visible) {
        hud.setBudget(false);
        budgetTool.setVisible(false);
      }
      buildPanel?.setVisible(enabled);
      invalidateView();
    },
    onZones: (enabled) => {
      if (enabled && transitPanel?.visible) hud.setTransit(false, hudCallbacks);
      if (enabled && buildPanel?.visible) {
        hud.setBuild(false);
        buildPanel.setVisible(false);
      }
      if (enabled && budgetTool.panel.visible) {
        hud.setBudget(false);
        budgetTool.setVisible(false);
      }
      zoning?.setVisible(enabled);
      invalidateView();
    },
    onBudget: (enabled) => {
      if (enabled && transitPanel?.visible) hud.setTransit(false, hudCallbacks);
      if (enabled && buildPanel?.visible) {
        hud.setBuild(false);
        buildPanel.setVisible(false);
      }
      if (enabled && zoning?.panel.visible) {
        hud.setZones(false);
        zoning.setVisible(false);
      }
      budgetTool.setVisible(enabled);
    },
    onTransit: (enabled) => {
      transitWanted = enabled;
      if (enabled) {
        if (buildPanel?.visible) {
          hud.setBuild(false);
          buildPanel.setVisible(false);
        }
        if (zoning?.panel.visible) {
          hud.setZones(false);
          zoning.setVisible(false);
        }
        if (budgetTool.panel.visible) {
          hud.setBudget(false);
          budgetTool.setVisible(false);
        }
        if (transitPanel) transitPanel.setVisible(true);
        else openTransit?.();
      } else {
        transitPanel?.setVisible(false);
      }
      invalidateView();
    },
  };
  const hud = new Hud(container, hudCallbacks);
  hud.setAlwaysDay(alwaysDay);
  // The City's money: building costs it, what grows pays into it (M5e).
  const budgetTool = new BudgetTool({
    hud: hud.element,
    onClose: () => hud.setBudget(false, hudCallbacks),
    growth: () =>
      zoning && {
        growth: zoning.growth,
        value: zoning.landValue.access.measured ? zoning.landValue.value : undefined,
      },
  });
  debug.budget = budgetTool;
  hud.enableBudget();
  hud.setTrafficLegend(TRAFFIC_BANDS.map(({ color, label }) => ({ color, label })));

  try {
    // WebGL 2 by default: it is verified in CI. WebGPU is opt-in (?webgpu) until it has been
    // tested on real devices; three.js r186 needed a shim for some Chrome versions.
    const renderer = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL: !params.has('webgpu'),
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.prepend(renderer.domElement);
    await renderer.init();
    const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'WebGPU'
      : 'WebGL 2';
    debug.backend = backend;

    const manifest = await loadManifest();
    const frame = WorldFrame.fromManifest(manifest);
    // A planned project (?project=id) runs on a network of its own in place of today's;
    // today's layers stay at hand to compare with.
    const today: WorldManifest['layers'] = { ...manifest.layers };
    let projects: ProjectInfo[] = [];
    if (manifest.layers.projects) {
      projects = await loadProjects(DATA_URL + manifest.layers.projects.index).catch(
        (error: unknown) => {
          console.warn('Planned projects could not be loaded', error);
          return [];
        },
      );
    }
    const project = projects.find((p) => p.id === params.get('project'));
    if (project) Object.assign(manifest.layers, project.layers);
    debug.projects = projects;
    debug.project = project?.id;

    const coarsePointer = matchMedia('(pointer: coarse)').matches;
    const stride = Number(params.get('stride')) || (coarsePointer ? 4 : 2);
    const terrain = await loadTerrain(manifest, frame, stride, renderer.getMaxAnisotropy());

    const scene = new THREE.Scene();
    scene.background = SKY;
    scene.add(terrain.layer.object);
    debug.terrain = terrain.layer;

    // Ground beyond the data extent, so the world doesn't end in a void.
    const outside = new THREE.Mesh(
      outsideGeometry(terrain.layer.tree, 300_000),
      new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 1 }),
    );
    outside.position.y = terrain.minHeight - 3;
    scene.add(outside);

    // Cartographic light from the north-west, so relief reads well on the map.
    // By day, light from the sun where it is (M6a); always-day light comes from the
    // north-west so relief reads well on the map.
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.position.set(-1, 1.4, -0.9);
    const sky = new THREE.HemisphereLight(0xdde8f5, 0x3b3a30, 1.1);
    scene.add(sun, sky);
    const day = zagrebToday();
    let lightKey = '';
    /** Light the scene for simulated time `t` (s); whether it changed. */
    const applyLight = (t: number): boolean => {
      const base: Lighting = alwaysDay ? ALWAYS_DAY : lighting(sunAt(day, t));
      // Cloud dims the sun and greys the sky (M6b).
      const cloud = WEATHER[weatherKind()].cloud;
      const light: Lighting = {
        ...base,
        intensity: base.intensity * (1 - 0.65 * cloud),
        ambient: base.ambient * (1 + 0.1 * cloud),
        background: greyed(base.background, 0.8 * cloud),
        sky: greyed(base.sky, 0.7 * cloud),
      };
      const lit = litShare(t);
      const key = `${light.color}:${light.intensity.toFixed(3)}:${light.background}:${light.night.toFixed(3)}:${lit.toFixed(2)}:${light.direction.map((v) => v.toFixed(2))}`;
      if (key === lightKey) return false;
      lightKey = key;
      sun.position.set(...light.direction);
      sun.color.setHex(light.color);
      sun.intensity = light.intensity;
      sky.color.setHex(light.sky);
      sky.groundColor.setHex(light.ground);
      sky.intensity = light.ambient;
      SKY.setHex(light.background);
      nightUniform.value = light.night;
      litUniform.value = lit;
      debug.light = { ...light, time: t };
      return true;
    };
    const precipitation = new Precipitation();
    scene.add(precipitation.object);
    applyWeather = () => {
      const kind = weatherKind();
      const look = WEATHER[kind];
      for (const s of [sim, baseline]) s?.setWeather(look.driving);
      precipitation.set(look.falling, look.amount);
      lightKey = '';
      debug.weather = { choice: weatherChoice, kind, live };
      const liveLabel = live
        ? `Live: ${WEATHER[live.kind].label}${live.temperature === null ? '' : `, ${live.temperature.toFixed(0)} °C`}`
        : liveFailed
          ? 'Live: not available'
          : 'Live: loading…';
      hud.setWeatherChoices(
        liveLabel,
        (Object.keys(WEATHER) as WeatherKind[]).map((id) => ({ id, label: WEATHER[id].label })),
        weatherChoice,
      );
      invalidateView();
    };
    let liveFailed = false;
    applyWeather();
    if (params.get('weather') !== 'off') {
      loadWeather()
        .then((feed) => {
          live = liveWeather(feed);
          if (!live) liveFailed = true;
          applyWeather();
        })
        .catch((error: unknown) => {
          console.warn('The live weather could not be loaded', error);
          liveFailed = true;
          applyWeather();
        });
    }

    rig = new CameraRig(renderer.domElement, {
      bounds: frame.bounds,
      groundHeight: (x, z) => terrain.heightfield.sample(x, z),
      initial: { x: 0, z: 0, viewHeight: 16_000 },
    });
    const activeRig = rig;
    debug.rig = rig;
    debug.setView = (mode) => activeRig.setMode(mode, false);
    debug.lookAt = (x, z, viewHeight) => activeRig.jumpTo(x, z, viewHeight);

    let dirty = true;
    const invalidate = () => {
      dirty = true;
    };
    invalidateView = invalidate;
    activeRig.controls.addEventListener('change', invalidate);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      renderer.setSize(w, h, false);
      activeRig.setAspect(w / Math.max(1, h));
      invalidate();
    };
    new ResizeObserver(resize).observe(container);
    resize();

    hud.setCredits(
      [...attributions(manifest), WEATHER_CREDIT],
      `Renderer: ${backend} · terrain mesh every ${stride * terrain.heightfield.resolution} m near the view · data built ${manifest.generated}`,
    );

    /** The ground point under a screen point (CSS pixels in the canvas). */
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const groundAt = (px: number, py: number): { x: number; z: number } | undefined => {
      const canvas = renderer.domElement;
      const ndc = new THREE.Vector2(
        (px / canvas.clientWidth) * 2 - 1,
        -(py / canvas.clientHeight) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, activeRig.camera);
      const view = activeRig.state();
      let ground = terrain.heightfield.sample(view.target.x, view.target.z);
      for (let i = 0; i < 3; i++) {
        plane.constant = -ground;
        if (!raycaster.ray.intersectPlane(plane, hit)) return undefined;
        ground = terrain.heightfield.sample(hit.x, hit.z);
      }
      return { x: hit.x, z: hit.z };
    };
    debug.groundAt = groundAt;

    /** The Build tools: road picking, the panel, the edits layer and the edit list. */
    const setUpBuild = (net: RoadNetwork, surface: HeightFn): BuildPanel => {
      const loaded = { net, index: new RoadIndex(net) };
      /** Whether a junction had traffic lights before any edit (new lights cost more). */
      const hasLights = (x: number, z: number) => loaded.index.findSignal({ x, z }) !== undefined;
      /** Lines by name and mode, and their vehicle-km a weekday, once the timetable is in;
       * the roads and tracks new lines' stops go on, on the network now. */
      const lineKm: LineKm = (line, mode, isNew) => {
        if (!timetable) return undefined;
        const route = isNew ? timetable.newRoute(line, mode) : timetable.routeIndex(line, mode);
        return route === undefined ? undefined : timetable.km(route);
      };
      const costs = (list: readonly Edit[]) => editsCost(list, hasLights, lineKm);
      const stopIndexes = new WeakMap<RoadNetwork, Map<LineMode, RoadIndex>>();
      const stopRoads = (mode: LineMode): RoadIndex => {
        const byMode = stopIndexes.get(current.net) ?? new Map<LineMode, RoadIndex>();
        stopIndexes.set(current.net, byMode);
        let index = byMode.get(mode);
        if (!index) {
          index = stopIndex(current.net, mode);
          byMode.set(mode, index);
        }
        return index;
      };
      stopRoadsNow = stopRoads;
      const transitMatch = (): TransitMatch | undefined => {
        const t = timetable;
        return t
          ? {
              route: (line, mode) => t.routeIndex(line, mode),
              newRoute: (name, mode) => t.newRoute(name, mode),
              stopRoads,
            }
          : undefined;
      };
      let missing = 0;
      /** The network with the roads drawn, and where its lanes lie on the one loaded. */
      let current = {
        net,
        index: loaded.index,
        origins: new Map<number, LaneOrigin>(),
        roads: [] as number[][],
        key: '[]',
      };
      let built: { key: string; result: BuiltNetwork } | undefined;
      /** Where the lanes of the network the player's simulation runs lie. */
      let simOrigins = new Map<number, LaneOrigin>();
      networkNow = { net, index: loaded.index };
      debug.roadIndex = loaded.index;
      debug.network = net;
      let layer = new EditLayer(net, surface);
      scene.add(layer.object);
      const drawLayer = new DrawLayer(surface);
      scene.add(drawLayer.object);
      let resolved: ResolvedEdit[] = [];
      const redraw = () => {
        const groups: { edges: number[]; color: number; width?: number }[] = (
          Object.keys(EDIT_COLORS) as (keyof typeof EDIT_COLORS)[]
        )
          .filter((kind) => kind !== 'selected' && kind !== 'road')
          .map((kind) => ({
            color: EDIT_COLORS[kind],
            edges: resolved
              .filter((r) => r.edit.kind === kind)
              .flatMap((r) => (r.edit.kind === 'ban' ? r.edges.slice(0, 1) : r.edges)),
          }));
        if (project) groups.unshift({ color: PROJECT_COLOR, edges: project.newEdges, width: 6 });
        groups.unshift({ color: EDIT_COLORS.road, edges: current.roads.flat(), width: 6 });
        const selected = panel.selected;
        if (selected !== undefined) {
          groups.push({ color: EDIT_COLORS.selected, edges: [selected], width: 8 });
        }
        layer.show(groups);
        invalidate();
      };
      /** The network loaded with these roads and junctions (built once per list). */
      const buildRoads = (roads: NetworkEdit[]): BuiltNetwork => {
        const key = JSON.stringify(roads);
        if (built?.key !== key) {
          built = { key, result: buildNetwork(loaded.net, roads, loaded.index) };
        }
        return built.result;
      };
      /** A new road or junction edit added to those in force (in place of those `replaces`
       * picks), if it can be built; else why not. */
      const tryNetworkEdit = (
        edit: NetworkEdit,
        replaces?: (e: Edit) => boolean,
      ): string | undefined => {
        const list = withEdit(replaces ? edits.filter((e) => !replaces(e)) : edits, edit);
        const network = list.filter(isNetworkEdit);
        const result = buildRoads(network);
        const problem = result.problems.find((p) => p.road === network.indexOf(edit));
        if (problem) return problem.reason;
        const unpaid = budgetTool.afford(costs(list).build);
        if (unpaid) return unpaid;
        apply(list);
        return undefined;
      };
      sendNetwork = (target, fresh) => {
        if (fresh) simOrigins = new Map();
        if (current.net === loaded.net && simOrigins.size === 0) return;
        const pieces = lanePieces(simOrigins, current.origins, (l) => loaded.net.laneLength[l]);
        target.setNetwork(networkArrays(current.net, surface), pieceWords(pieces));
        simOrigins = current.origins;
      };
      /** Build the roads and junctions in the list into the network the player's
       * simulation runs. */
      const useRoads = (list: Edit[]): BuiltNetwork['problems'] => {
        const roads = list.filter(isNetworkEdit);
        const key = JSON.stringify(roads);
        if (key === current.key) return [];
        let problems: BuiltNetwork['problems'] = [];
        if (roads.length === 0) {
          current = { ...loaded, origins: new Map(), roads: [], key };
        } else {
          const result = buildRoads(roads);
          problems = result.problems;
          const next = new RoadNetwork(
            { ...loaded.net.index, types: result.types },
            result.arrays,
            {
              lane: result.laneShape,
              junction: result.junctionShape,
            },
          );
          current = {
            net: next,
            index: new RoadIndex(next),
            origins: result.origins,
            roads: result.roads,
            key,
          };
        }
        networkNow = { net: current.net, index: current.index };
        debug.roadIndex = current.index;
        debug.network = current.net;
        debug.drawn = { roads: current.roads, problems };
        scene.remove(layer.object);
        disposeObject(layer.object);
        layer = new EditLayer(current.net, surface);
        scene.add(layer.object);
        panel.setIndex(current.index);
        useNetwork(current.net);
        // Comparing goes on the network it started with: stop it.
        if (baseline) setCompare(false);
        if (sim) sendNetwork(sim, false);
        return problems;
      };
      const apply = (list: Edit[]) => {
        useRoads(list);
        edits = list;
        const matched = resolveEdits(current.index, list, transitMatch());
        resolved = matched.resolved;
        missing = matched.missing.length;
        debug.edits = resolved;
        panel.setEdits(list, resolved, missing);
        saveEdits(list);
        budgetTool.setEdits(costs(list), list.length);
        editWordsNow = editWords(resolved);
        sim?.setEdits(editWordsNow);
        newWaysNow = resolved.flatMap((r) =>
          r.edit.kind === 'line'
            ? (r.ways ?? []).map((stops) => ({
                route: r.record[1],
                name: (r.edit as LineEdit).name,
                mode: (r.edit as LineEdit).mode,
                stops,
              }))
            : [],
        );
        frequenciesNow = new Map(
          resolved.flatMap((r) =>
            r.edit.kind === 'frequency' ? [[r.record[1], r.edit.factor] as [number, number]] : [],
          ),
        );
        transitPanel?.setFrequencies(frequenciesNow);
        if (list.length === 0) panel.setStatus('');
        if (!sim) panel.setInForce(0);
        redraw();
      };
      const panel = new BuildPanel(hud.element, loaded.index, {
        // Building needs money: edits that cost more than the City has are refused.
        onEdits: (list) => {
          const unpaid = budgetTool.afford(costs(list).build);
          if (!unpaid) return apply(list);
          panel.setEdits(edits, resolved, missing);
          panel.setStatus(unpaid);
        },
        costOf: (edit) => {
          const cost = costs([edit]);
          if (edit.kind !== 'frequency' && edit.kind !== 'line') return euros(cost.build);
          if (!cost.service) return '';
          return `${euros(Math.abs(cost.service))} a year ${cost.service > 0 ? 'more' : 'less'}`;
        },
        onNetworkEdit: tryNetworkEdit,
        onSelect: () => redraw(),
        onClose: () => {
          hud.setBuild(false);
          panel.setVisible(false);
          invalidate();
        },
        shareLink: async (list) =>
          `${location.origin}${location.pathname}${location.search}#edits=${await encodeEditsForUrl(list)}`,
        importFile: async (file) => parseEdits(await file.text()),
        onCompare: (on) => setCompare(on),
        onDiffMap: (on) => setDiffMap(on),
        exportFile: (list) => {
          const blob = new Blob([serializeEdits(list)], { type: 'application/json' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'zg-city-sim-edits.json';
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        },
      });
      debug.build = panel;
      changeEdits = (change) => {
        const list = change(edits);
        const unpaid = budgetTool.afford(costs(list).build);
        if (unpaid) panel.setStatus(unpaid);
        else apply(list);
      };
      refreshCosts = () => {
        budgetTool.setEdits(costs(edits), edits.length);
        panel.setEdits(edits, resolved, missing);
      };
      hud.enableBuild();
      if (project) panel.setScenario(project.name);
      const drawer = new RoadDrawer(panel.drawSlot, {
        onDrawing: (on) => {
          if (on) panel.select(undefined);
          invalidate();
        },
        onPoints: (points) => {
          drawLayer.show(points);
          invalidate();
        },
        onRoad: (road) => tryNetworkEdit(road),
      });
      debug.drawer = drawer;
      if (projects.length) {
        new ProjectsSection(panel.element, projects, project?.id, {
          onOpen: (id) => location.assign(projectUrl(location.href, id)),
          onShow: (p) => activeRig.flyTo(p.centre[0], p.centre[1], 5000),
        });
      }
      if (project) {
        // Show what the project builds.
        hud.setBuild(true);
        panel.setVisible(true);
        activeRig.flyTo(project.centre[0], project.centre[1], 5000);
      }

      // A click (not a drag) on the map picks the road there while the panel is open.
      const pickAt = (px: number, py: number): number | undefined => {
        const p = groundAt(px, py);
        if (!p) return undefined;
        const canvas = renderer.domElement;
        const metersPerPixel = activeRig.state().viewHeight / Math.max(1, canvas.clientHeight);
        const radius = Math.min(60, Math.max(6, metersPerPixel * 12));
        return current.index.pick(p.x, p.z, radius);
      };
      debug.pickAt = pickAt;
      let down: { x: number; y: number; t: number } | undefined;
      renderer.domElement.addEventListener('pointerdown', (event) => {
        down = { x: event.offsetX, y: event.offsetY, t: performance.now() };
      });
      renderer.domElement.addEventListener('pointerup', (event) => {
        if (!panel.visible || !down || event.button !== 0) return;
        const moved = Math.hypot(event.offsetX - down.x, event.offsetY - down.y);
        if (moved > 6 || performance.now() - down.t > 600) return;
        if (drawer.active) {
          const p = groundAt(event.offsetX, event.offsetY);
          if (p) drawer.addPoint(p);
          return;
        }
        const edge = pickAt(event.offsetX, event.offsetY);
        if (edge !== undefined) panel.select(edge);
      });

      // Edits from a shared link: at start, or pasted into this tab later.
      const loadFromLink = (encoded: string) =>
        decodeEditsFromUrl(encoded)
          .then((list) => {
            apply(list);
            hud.setBuild(true);
            panel.setVisible(true);
            panel.setStatus(
              `Loaded ${list.length} edit${list.length === 1 ? '' : 's'} from the link.`,
            );
          })
          .catch(() => panel.setStatus('The link has no edits that could be read.'))
          .finally(() => history.replaceState(null, '', location.pathname + location.search));
      if (editsFromLink) loadFromLink(editsFromLink);
      else apply(edits);
      window.addEventListener('hashchange', () => {
        const encoded = /[#&]edits=([^&]+)/.exec(location.hash)?.[1];
        if (encoded) loadFromLink(encoded);
      });
      return panel;
    };

    /** What the player's simulation is compared with: today's roads, run with the same
     * trips. With a project open, today's network is another network, loaded when first
     * compared; `toToday` takes an edge of the player's network to the same road on it. */
    interface Baseline {
      net: RoadNetwork;
      travel: TravelData;
      index: RoadIndex;
      toToday?: Int32Array;
    }

    /** Before and after: run the day again with the edits next to today's roads. */
    const setUpCompare = (
      net: RoadNetwork,
      surface: HeightFn,
      travelData: TravelData,
      launch: (speed: number) => SimClient,
    ) => {
      const loadedIndex = debug.roadIndex;
      if (!loadedIndex) return;
      let diffLayer = new EditLayer(net, surface);
      scene.add(diffLayer.object);
      let timer: ReturnType<typeof setInterval> | undefined;
      let diffOn = false;
      let busy = false;
      let run = 0;
      const compared = { stats: 0, travel: -Infinity, diff: -Infinity, transit: false };
      let todayRoads: Promise<Baseline> | undefined;
      const baselineData = (): Promise<Baseline> => {
        if (!project) {
          // Today's roads are the roads loaded; with roads drawn the networks differ.
          const now = networkNow ?? { net, index: loadedIndex };
          const toToday = now.net === net ? undefined : edgeMap(now.index, loadedIndex);
          return Promise.resolve({ net, travel: travelData, index: loadedIndex, toToday });
        }
        todayRoads ??= (async () => {
          const [todayNet, demand, transit, crossings, cycling] = await Promise.all([
            loadRoadNetwork(today.network!.index),
            loadLayerArrays(today.demand?.index, 'Travel demand'),
            loadLayerArrays(today.transit?.index, 'The ZET timetable'),
            loadCrossings(today.pedestrians?.index),
            loadCycling(today.cycling?.index),
          ]);
          const todayIndex = new RoadIndex(todayNet);
          return {
            net: todayNet,
            travel: {
              arrays: { ...demand, ...transit, ...crossings, ...cycling },
              dailyTrips: today.demand?.dailyCarTrips ?? DAILY_TRIPS,
              demandScale: today.demand?.demandScale ?? 1,
            },
            index: todayIndex,
          };
        })();
        // The project's network may have roads drawn on it since: match roads now.
        return todayRoads.then((base) => ({
          ...base,
          toToday: edgeMap((networkNow ?? { index: loadedIndex }).index, base.index),
        }));
      };

      setDiffMap = (on) => {
        diffOn = on;
        compared.diff = -Infinity;
        if (!on) diffLayer.show([]);
        invalidate();
      };
      setCompare = (on) => {
        run++;
        if (timer) clearInterval(timer);
        timer = undefined;
        baseline?.dispose();
        baseline = undefined;
        debug.baseline = undefined;
        setDiffMap(false);
        buildPanel?.setComparing(on);
        if (!on) return;
        const thisRun = run;
        if (project) buildPanel?.setStatus("Loading today's roads to compare with…");
        baselineData()
          .then((base) => {
            if (thisRun === run) start(base);
            if (project) buildPanel?.setStatus('');
          })
          .catch((error: unknown) => {
            console.error(error);
            buildPanel?.setStatus("Today's roads could not be loaded to compare with.");
            buildPanel?.setComparing(false);
          });
      };

      const start = (base: Baseline) => {
        const { net: playerNet, index } = networkNow ?? { net, index: loadedIndex };
        if (diffLayer.object.parent) scene.remove(diffLayer.object);
        disposeObject(diffLayer.object);
        diffLayer = new EditLayer(playerNet, surface);
        scene.add(diffLayer.object);
        // Travel times between every two of the places, from the road nearest each on
        // either network.
        const placeEdges = PLACES.map((p) => index.pick(p.x, p.z, 600));
        const todayEdges = PLACES.map((p) => base.index.pick(p.x, p.z, 600));
        const pairs: [number, number][] = [];
        for (let i = 0; i < PLACES.length; i++) {
          for (let j = 0; j < PLACES.length; j++) {
            const ends = [placeEdges[i], placeEdges[j], todayEdges[i], todayEdges[j]];
            if (i !== j && ends.every((e) => e !== undefined)) pairs.push([i, j]);
          }
        }
        const words = (edges: (number | undefined)[]) =>
          Uint32Array.from(pairs.flatMap(([i, j]) => [edges[i]!, edges[j]!]));
        const [editedPairs, todayPairs] = [words(placeEdges), words(todayEdges)];
        // By public transport (M9e): between the places themselves, today and with the edits,
        // as the player's simulation works its riders out.
        const placePoints = Float32Array.from(PLACES.flatMap((p) => [p.x, p.z]));
        const allPairs: [number, number][] = [];
        for (let i = 0; i < PLACES.length; i++) {
          for (let j = 0; j < PLACES.length; j++) if (i !== j) allPairs.push([i, j]);
        }

        // Both start at 06:50 with the same trips: the player's with the edits.
        const speed = sim?.speed ?? 1;
        sim?.dispose();
        sim = launch(speed);
        const todaySim = startSimulation(base.net, base.travel, surface, speed, false);
        if (closedEdges) {
          const map = base.toToday;
          const closed = map ? Array.from(closedEdges, (e) => map[e]).filter((e) => e >= 0) : [];
          todaySim.setClosures(map ? Uint32Array.from(closed) : closedEdges);
        }
        todaySim.setWeather(WEATHER[weatherKind()].driving);
        baseline = todaySim;
        debug.baseline = todaySim;
        compared.stats = 0;
        compared.travel = -Infinity;
        compared.diff = -Infinity;
        compared.transit = false;
        let carTimes: TravelTimeSummary | undefined;
        debug.compared = compared;
        timer = setInterval(() => {
          const edited = sim;
          if (!edited?.stats || !todaySim.stats) return;
          const [tToday, tEdited] = [todaySim.stats[STAT.time], edited.stats[STAT.time]];
          // Keep in step: the one ahead waits.
          edited.setHeld(tEdited - tToday > 10);
          todaySim.setHeld(tToday - tEdited > 10);
          const time = Math.min(tToday, tEdited);
          // Measures as of the same simulated minute in both.
          const minute = commonMinute(todaySim.minutes, edited.minutes);
          if (minute !== undefined) {
            compared.stats = minute * 60;
            const rows = compareStats(todaySim.minutes.get(minute)!, edited.minutes.get(minute)!);
            // Public transport's riders today and with the edits (M9e).
            if (ridersNow?.ready && !ridersNow.busy) rows.push(...ridersRows(ridersNow));
            buildPanel?.setComparison(minute * 60, rows);
          }
          if (busy) return;
          // By car every five simulated minutes; by public transport then too, and as soon
          // as the player's simulation has worked its riders out (M9e).
          const n = PLACES.length;
          const transitSummary = (pt: Float32Array) =>
            pt.length === 2 * n * n
              ? summariseTravelTimes(
                  allPairs,
                  pairTimes(allPairs, n, pt.subarray(0, n * n)),
                  pairTimes(allPairs, n, pt.subarray(n * n)),
                )
              : undefined;
          if (time - compared.travel >= 300) {
            busy = true;
            Promise.all([
              todaySim.routeTimes(todayPairs),
              edited.routeTimes(editedPairs),
              edited.ptJourneys(placePoints),
            ])
              .then(([a, b, pt]) => {
                compared.travel = Math.min(a.time, b.time);
                carTimes = summariseTravelTimes(pairs, a.times, b.times);
                const transit = transitSummary(pt);
                compared.transit = transit !== undefined;
                buildPanel?.setTravelTimes(compared.travel, carTimes, transit);
              })
              .finally(() => {
                busy = false;
              });
          } else if (!compared.transit && carTimes && edited.ready) {
            busy = true;
            const car = carTimes;
            edited
              .ptJourneys(placePoints)
              .then((pt) => {
                const transit = transitSummary(pt);
                compared.transit = transit !== undefined;
                if (transit) buildPanel?.setTravelTimes(compared.travel, car, transit);
              })
              .finally(() => {
                busy = false;
              });
          } else if (diffOn && time >= DIFF_FROM && time - compared.diff >= 60) {
            busy = true;
            // Both counted as of the same simulated time.
            const at = Math.floor(time / 60) * 60;
            Promise.all([todaySim.volumes(at), edited.volumes(at)])
              .then(([a, b]) => {
                compared.diff = Math.min(a.time, b.time);
                // Today's counts on the player's roads: a project's new roads have none.
                const todayCounts = base.toToday ? pullCounts(a.counts, base.toToday) : a.counts;
                const bands = diffBands(todayCounts, b.counts, (e) => index.editable(e));
                diffLayer.show(
                  DIFF_BANDS.map((band, k) => ({ color: band.color, edges: bands[k] })).filter(
                    (g) => g.edges.length > 0,
                  ),
                );
                invalidate();
              })
              .finally(() => {
                busy = false;
              });
          }
        }, 1000);
      };
    };

    // Roads load after the terrain is on screen, then traffic starts on them.
    let roads: RoadLayer | undefined;
    let streetLights: StreetLightLayer | undefined;
    // Street lamps once both the roads and the buildings are in: streets among buildings.
    let lampInputs: { net?: RoadNetwork; height?: HeightFn; centres?: Float32Array } = {};
    const lightStreets = (net?: RoadNetwork, height?: HeightFn, centres?: Float32Array) => {
      lampInputs = {
        net: net ?? lampInputs.net,
        height: height ?? lampInputs.height,
        centres: centres ?? lampInputs.centres,
      };
      const { net: n, height: h, centres: c } = lampInputs;
      if (!n || !h || !c || streetLights) return;
      streetLights = new StreetLightLayer(n, h, new BuiltArea(c));
      scene.add(streetLights.object);
      debug.streetLights = streetLights;
      invalidate();
    };
    let vehicles: VehicleLayer | undefined;
    let pedestrians: PedestrianLayer | undefined;
    let news: NewsLayer | undefined;
    let speeds: Uint8Array | undefined;
    let simChanged = false;
    const networkLayer = manifest.layers.network;
    if (networkLayer) {
      hud.setNotice('Loading road network…');
      const surface = terrain.heightfield.meshSurface(stride);
      // Car trips come from where people live and work (without that data, from the
      // streets); trams and buses run to ZET's timetable.
      const {
        demand: demandLayer,
        transit: transitLayer,
        pedestrians: pedestriansLayer,
        cycling: cyclingLayer,
      } = manifest.layers;
      const travel: Promise<TravelData> = Promise.all([
        loadLayerArrays(demandLayer?.index, 'Travel demand'),
        loadLayerArrays(transitLayer?.index, 'The ZET timetable'),
        loadCrossings(pedestriansLayer?.index),
        loadCycling(cyclingLayer?.index),
      ]).then(([demand, transit, crossings, cycling]) => ({
        arrays: { ...demand, ...transit, ...crossings, ...cycling },
        dailyTrips: demand && demandLayer ? demandLayer.dailyCarTrips : DAILY_TRIPS,
        demandScale: demandLayer?.demandScale ?? 1,
      }));
      const stations = loadStations(transitLayer?.index);
      loadRoadNetwork(networkLayer.index)
        .then(async (net) => {
          roads = new RoadLayer(net, surface);
          scene.add(roads.object);
          lightStreets(net, surface);
          debug.roads = roads;
          invalidate();
          // Roads drawn change the network: the layers drawn from it are made again.
          useNetwork = (next) => {
            if (roads) {
              scene.remove(roads.object);
              disposeObject(roads.object);
            }
            roads = new RoadLayer(next, surface);
            scene.add(roads.object);
            debug.roads = roads;
            if (traffic) {
              const enabled = traffic.enabled;
              scene.remove(traffic.object);
              disposeObject(traffic.object);
              traffic = new TrafficLayer(next, surface);
              traffic.enabled = enabled;
              scene.add(traffic.object);
              debug.traffic = traffic;
            }
            invalidate();
          };
          buildPanel = setUpBuild(net, surface);
          const newsInfo = manifest.layers.news;
          if (newsInfo) {
            loadNews(newsInfo.index)
              .then((data) => {
                const layer = new NewsLayer(net, surface, data);
                news = layer;
                scene.add(layer.object);
                newsPanel = new NewsPanel(hud.element, data, {
                  onSelect: (hotspot) => {
                    layer.select(hotspot);
                    if (hotspot) {
                      // On a phone the reports cover the lower half: keep the place above.
                      const narrow = container.clientWidth <= 640;
                      activeRig.flyTo(hotspot.x, hotspot.z, undefined, narrow ? 0.25 : 0);
                      newsPanel?.setTraffic(
                        speeds ? placeTraffic(net, hotspot.edges, speeds) : sim ? undefined : null,
                      );
                    }
                    invalidate();
                  },
                });
                debug.news = layer;
                debug.newsPanel = newsPanel;
                const reports = data.hotspots.reduce((n, h) => n + h.reports.length, 0);
                hud.enableNews(data.hotspots.length, reports);
              })
              .catch((error: unknown) => console.warn('News reports could not be loaded', error));
          }
          if (params.get('closures') !== 'off') {
            loadClosures()
              .then((feed) => {
                const placed = placeClosures(
                  net,
                  activeClosures(feed.closures, zagrebNow()),
                  manifest.origin,
                );
                debug.closures = placed;
                if (placed.length === 0) return;
                closureLayer = new ClosureLayer(net, surface);
                closureLayer.show(placed);
                scene.add(closureLayer.object);
                closureMarkers = new ClosureMarkers(hud.element);
                closureMarkers.set(placed);
                hud.enableClosures(placed.length, feed.fetched);
                // The simulation routes around them.
                closedEdges = Uint32Array.from(placed.flatMap((p) => p.edges));
                sim?.setClosures(closedEdges);
                invalidate();
              })
              .catch((error: unknown) =>
                console.warn('Live road closures could not be loaded', error),
              );
          }
          if (params.get('sim') === 'off') return;
          vehicles = new VehicleLayer(surface);
          scene.add(vehicles.object);
          debug.vehicles = vehicles;
          traffic = new TrafficLayer(networkNow?.net ?? net, surface);
          scene.add(traffic.object);
          debug.traffic = traffic;
          const travelData = await travel;
          todayDemand = travelData;
          if (travelData.arrays.crossingXY) {
            pedestrians = new PedestrianLayer(
              net,
              surface,
              travelData.arrays as unknown as CrossingArrays,
            );
            scene.add(pedestrians.object);
            debug.pedestrians = pedestrians;
            hud.enableShown('pedestrians');
          }
          if (travelData.arrays.transitTripType?.some((t) => t === VEHICLE_TYPES.indexOf('train')))
            hud.enableShown('trains');
          if (travelData.arrays.bikeEdge) hud.enableShown('bikes');
          void stations.then((list) => {
            railMarkers = new RailMarkers(hud.element, list, (j) => {
              const now = networkNow?.net ?? net;
              return {
                x: now.junctionPos[2 * j],
                z: now.junctionPos[2 * j + 1],
                name: junctionName(now, j),
              };
            });
            railMarkers.setVisible(!!traffic?.enabled && shown.has('trains'));
            debug.railMarkers = railMarkers;
          });
          if (travelData.arrays.transitStopRef) {
            hud.enableTransit();
            // The lines load at once: frequency edits need them to reach the engine and the
            // budget.
            const timetableLoad = loadLines(transitLayer?.index).then((lines) => {
              if (!lines) return undefined;
              const loaded = new Timetable(
                lines.routes,
                lines.file,
                travelData.arrays as unknown as TimetableArrays,
              );
              loaded.setService(serviceNow, newWaysNow);
              timetable = loaded;
              debug.timetable = loaded;
              if (edits.some((e) => e.kind === 'frequency' || e.kind === 'line'))
                changeEdits((list) => list);
              return loaded;
            });
            openTransit = () => {
              openTransit = undefined;
              void timetableLoad.then((timetable) => {
                if (!timetable) return;
                const markers = new StopMarkers(hud.element, timetable, (s) =>
                  transitPanel?.openStop(s),
                );
                let routeLayer: EditLayer | undefined;
                /** A fresh layer for a route drawn on the map. */
                const newRouteLayer = (): EditLayer => {
                  if (routeLayer) scene.remove(routeLayer.object);
                  routeLayer = new EditLayer(networkNow?.net ?? net, surface);
                  scene.add(routeLayer.object);
                  return routeLayer;
                };
                let planned = 0;
                transitPanel = new TransitPanel(hud.element, timetable, {
                  onClose: () => hud.setTransit(false, hudCallbacks),
                  onShow: (line) => {
                    const layer = newRouteLayer();
                    markers.set(line?.stops ?? [], line?.color ?? 0);
                    invalidateView();
                    if (!line || !sim) return;
                    void sim.transit(line.trip).then(({ path }) => {
                      layer.show([{ edges: Array.from(path), color: line.color, width: 6 }]);
                      invalidateView();
                    });
                  },
                  // A new line as it is drawn (M9c): its stops marked, its way planned.
                  onDraft: (draft) => {
                    const layer = newRouteLayer();
                    const color = draft ? MODE_COLOR[draft.mode] : 0;
                    markers.setPoints(draft?.stops ?? [], color);
                    invalidateView();
                    const run = ++planned;
                    const roads = stopRoadsNow;
                    if (!draft || !sim || !roads || draft.stops.length < 2) return;
                    const placed = placeStops(roads(draft.mode), draft.stops).filter(
                      (p): p is [number, number] => p !== undefined,
                    );
                    const words = planWords(LINE_VTYPE[draft.mode], placed);
                    void sim.planLine(words).then((answer) => {
                      if (run !== planned) return;
                      const plan = readPlan(answer);
                      transitPanel?.setPlan(plan);
                      if (plan) layer.show([{ edges: plan.path, color, width: 6 }]);
                      invalidateView();
                    });
                  },
                  onAddLine: (draft) => {
                    const edit: LineEdit = { kind: 'line', ...draft };
                    changeEdits((list) => withEdit(list, edit));
                  },
                  onRemoveLine: (route) => {
                    const r = timetable.routes[route];
                    changeEdits((list) =>
                      list.filter(
                        (e) => !(e.kind === 'line' && e.name === r.name && e.mode === r.mode),
                      ),
                    );
                  },
                  lineName: (mode) => {
                    const taken = new Set(
                      timetable.routes.filter((r) => r.mode === mode).map((r) => r.name),
                    );
                    for (const e of edits)
                      if (e.kind === 'line' && e.mode === mode) taken.add(e.name);
                    let n = mode === 'tram' ? 18 : 400;
                    while (taken.has(String(n))) n++;
                    return String(n);
                  },
                  draftNote: (draft, plan) => {
                    const ways = draft.both ? 2 : 1;
                    const km = (plan.metres / 1000) * tripsADay(draft) * ways;
                    const { service } = editCost({ kind: 'line', ...draft }, undefined, () => km);
                    return `About ${Math.round(km).toLocaleString('en-GB')} vehicle-km a weekday; it costs about ${euros(service)} a year to run.`;
                  },
                  onStop: (x, z) => rig?.jumpTo(x, z, 900),
                  onFrequency: (route, factor) => {
                    const r = timetable.routes[route];
                    const edit: FrequencyEdit = {
                      kind: 'frequency',
                      line: r.name,
                      mode: r.mode,
                      factor,
                    };
                    changeEdits((list) =>
                      factor === 1
                        ? list.filter((e) => !sameTarget(e, edit))
                        : withEdit(list, edit),
                    );
                  },
                  frequencyNote: (route, factor) => {
                    const r = timetable.routes[route];
                    const km = timetable.km(route);
                    const base = `${Math.round(km).toLocaleString('en-GB')} vehicle-km a weekday as timetabled`;
                    if (factor === 1) return `${base}.`;
                    const { service } = editCost(
                      { kind: 'frequency', line: r.name, mode: r.mode, factor },
                      undefined,
                      () => km,
                    );
                    return `${base}; this ${service > 0 ? 'costs' : 'saves'} about ${euros(Math.abs(service))} a year.`;
                  },
                });
                transitPanel.setFrequencies(frequenciesNow);
                transitPanel.setRiders(ridersNow);
                transitMarkers = markers;
                debug.transit = transitPanel;
                transitPanel.setVisible(transitWanted);

                // A tap on the map adds a stop to the line drawn: the stop of its mode
                // nearby, else a stop of its own on the nearest road (track).
                let down: { x: number; y: number; t: number } | undefined;
                renderer.domElement.addEventListener('pointerdown', (event) => {
                  down = { x: event.offsetX, y: event.offsetY, t: performance.now() };
                });
                renderer.domElement.addEventListener('pointerup', (event) => {
                  const mode = transitPanel?.drawing;
                  if (!mode || !down || event.button !== 0) return;
                  const moved = Math.hypot(event.offsetX - down.x, event.offsetY - down.y);
                  if (moved > 6 || performance.now() - down.t > 600) return;
                  const p = groundAt(event.offsetX, event.offsetY);
                  const stop = p && snapStop(p.x, p.z, mode);
                  if (stop) transitPanel?.addStop(stop);
                });
                const snapStop = (x: number, z: number, mode: LineMode): LineStop | undefined => {
                  const s = timetable.nearestStop(x, z, mode, SNAP_STOP);
                  if (s !== undefined) return timetable.stop(s);
                  const road = stopRoadsNow?.(mode).near(x, z, STOP_REACH)[0];
                  if (!road) return undefined;
                  const now = networkNow?.net ?? net;
                  return { x, z, name: now.nameOf(road.edge) ?? 'New stop' };
                };
              });
            };
            if (transitWanted) openTransit();
          }
          applyDemand();
          /** The simulation the player sees, with the edits in force. */
          const launch = (speed: number): SimClient => {
            const running = startSimulation(net, travelData, surface, speed);
            running.setWeather(WEATHER[weatherKind()].driving);
            // Homes and jobs grown since: with the trips they make.
            if (demandNow) running.setDemandWeights(demandNow.arrays, demandNow.dailyTrips);
            debug.sim = running;
            if (closedEdges) running.setClosures(closedEdges);
            // Roads drawn: the network with them, then the edits on it.
            sendNetwork(running, true);
            if (editWordsNow) running.setEdits(editWordsNow);
            running.onReady = () => {
              if (running.signals) buildPanel?.setSignals(running.signals);
            };
            running.onEdited = (applied, signals, service) => {
              // The trips that run with the frequency edits and new lines in force.
              serviceNow = service;
              timetable?.setService(service, newWaysNow);
              transitPanel?.refresh();
              refreshCosts();
              buildPanel?.setSignals(signals);
              // A new line both ways is one edit, two ways in the engine.
              const ways = timetable ? timetable.waysInForce - timetable.newLineCount : 0;
              buildPanel?.setInForce(applied - ways);
            };
            running.onNetwork = (signals, error) => {
              buildPanel?.setSignals(signals);
              if (error) {
                console.error(error);
                buildPanel?.setStatus(`The roads could not be built: ${error}`);
              }
            };
            running.onFrame = () => {
              simChanged = true;
              if (running.cur) {
                zoning?.tick(running.cur.time);
                budgetTool.tick(running.cur.time);
              }
            };
            running.onEdgeSpeeds = (latest) => {
              // Speeds measured on the network before roads were drawn or taken away.
              if (latest.length !== (networkNow?.net ?? net).edgeCount) return;
              speeds = latest;
              traffic?.setSpeeds(latest);
              const place = news?.selected;
              if (place) newsPanel?.setTraffic(placeTraffic(net, place.edges, latest));
              invalidate();
            };
            running.onError = (message) => {
              console.error(message);
              hud.setNotice(`The traffic simulation stopped: ${message}`);
            };
            return running;
          };
          sim = launch(Number(params.get('speed')) || 1);
          setUpCompare(net, surface, travelData, launch);
        })
        .catch((error: unknown) => {
          console.error(error);
          hud.setNotice('The road network could not be loaded.');
        })
        .finally(() => {
          debug.roadsReady = true;
          if (roads) hud.setNotice(null);
        });
    } else {
      debug.roadsReady = true;
    }

    let buildings: BuildingLayer | undefined;
    const buildingLayer = manifest.layers.buildings;
    if (buildingLayer) {
      const surface = terrain.heightfield.meshSurface(stride);
      loadBuildings(buildingLayer.index)
        .then((data) => {
          buildings = new BuildingLayer(data, surface);
          scene.add(buildings.object);
          lightStreets(undefined, undefined, buildingCentres(data));
          debug.buildings = buildings;
          invalidate();
        })
        .catch((error: unknown) => console.error(error))
        .finally(() => {
          debug.buildingsReady = true;
        });
    } else {
      debug.buildingsReady = true;
    }

    // The Zones tool: lots along streets, painted with zones.
    const zoningInfo = manifest.layers.zoning;
    const demandInfo = manifest.layers.demand;
    if (zoningInfo) {
      loadLots(zoningInfo.index)
        .then((lots) => {
          zoning = setUpZoning({
            lots,
            scene,
            hud: hud.element,
            canvas: renderer.domElement,
            surface: terrain.heightfield.meshSurface(stride),
            terrain: terrain.layer,
            groundAt,
            setMapDragging: (on) => {
              activeRig.controls.enabled = on;
            },
            invalidate,
            open: () => hud.setZones(true, hudCallbacks),
            onClose: () => hud.setZones(false, hudCallbacks),
            // A project's network has other edges: a lot's trips use the street in front.
            edgeOf: project
              ? (i) => {
                  const right = lots.depth[i] / 2 + 4;
                  const x = lots.x[i] + Math.sin(lots.angle[i]) * right;
                  const z = lots.z[i] - Math.cos(lots.angle[i]) * right;
                  return networkNow?.index.pick(x, z, 30) ?? -1;
                }
              : undefined,
            onDemand: (added) => {
              grownDemand = added;
              applyDemand();
            },
            sim: () => sim,
            startTime: START_TIME,
            // A project's network numbers its roads afresh: only the street in front counts.
            loudOf: project ? () => -1 : undefined,
            jobsPerResident: demandInfo ? demandInfo.jobs / demandInfo.residents : undefined,
          });
          debug.zoning = zoning;
          hud.enableZones();
          invalidate();
        })
        .catch((error: unknown) => console.warn('Zoning could not be loaded', error));
    }

    const fog = new THREE.Fog(SKY, 1, 2);
    const marker = new THREE.Vector3();
    let lastHudSim = 0;
    let lastTransit = 0;
    let lastRiders = 0;
    /** Draw a frame if anything changed; whether it drew. */
    const drawFrame = (time: number): boolean => {
      const moving = activeRig.update(time);
      const camera = activeRig.camera;
      const view = activeRig.state();
      const distance = camera.position.distanceTo(view.target);
      const aspect = container.clientWidth / Math.max(1, container.clientHeight);

      // Traffic moves between simulation frames, so it is drawn every display frame.
      let trafficMoving = false;
      if (sim?.cur && vehicles) {
        const now = performance.now();
        const alpha = sim.alpha(now);
        const wasVisible = vehicles.object.visible;
        trafficMoving = simChanged || alpha < 1 || moving;
        for (const [kind, type] of [
          ['trains', VEHICLE_TYPES.indexOf('train')],
          ['bikes', VEHICLE_TYPES.indexOf('bike')],
        ] as const) {
          if (shown.has(kind) === vehicles.hidden.has(type)) {
            if (shown.has(kind)) vehicles.hidden.delete(type);
            else vehicles.hidden.add(type);
            trafficMoving = true;
          }
        }
        if (trafficMoving) {
          vehicles.update(sim.prev?.render, sim.cur.render, alpha, {
            target: view.target,
            viewHeight: view.viewHeight,
            radius:
              camera instanceof THREE.PerspectiveCamera
                ? Math.min(4_000, distance * 3)
                : view.viewHeight * Math.max(1, aspect) * 0.8,
          });
        }
        trafficMoving = trafficMoving && (vehicles.object.visible || wasVisible);
        if (pedestrians) {
          if (pedestrians.object.visible !== shown.has('pedestrians')) {
            pedestrians.object.visible = shown.has('pedestrians');
            dirty = true;
          }
          if (simChanged || moving) pedestrians.update(sim.crossings, view.target, view.viewHeight);
        }
        if (railMarkers?.visible && simChanged) {
          railMarkers.update(sim.displayTime(now), sim.levelCrossings);
        }
        // The Public transport panel's vehicles running, every two seconds while it is open.
        if (transitPanel?.visible && now - lastTransit > 2000) {
          lastTransit = now;
          const panel = transitPanel;
          const client = sim;
          void client.transit(-1).then(({ running }) => {
            panel.update(client.displayTime(performance.now()), running);
          });
        }
        // Public transport's riders (M9d), every three seconds: the panel, and the fares.
        if (now - lastRiders > 3000) {
          lastRiders = now;
          void sim.riders().then((words) => {
            ridersNow = readRiders(words);
            transitPanel?.setRiders(ridersNow);
            const t = timetable;
            if (ridersNow?.ready && !ridersNow.busy && t)
              budgetTool.setFares(faresFrom(ridersNow, (r) => t.routes[r]?.mode));
          });
        }
        simChanged = false;
        if (sim.stats && (now - lastHudSim > 250 || sim.paused)) {
          lastHudSim = now;
          hud.updateSim({
            time: sim.displayTime(now),
            paused: sim.paused,
            speed: sim.speed,
            rate: sim.rate,
            warming: sim.warming,
            vehicles: sim.stats[STAT.running],
            outside: sim.stats[STAT.outside] ?? 0,
            trams: sim.stats[STAT.trams],
            buses: sim.stats[STAT.buses],
            trains: sim.stats[STAT.trains] ?? 0,
            bikes: sim.stats[STAT.bikes] ?? 0,
            meanSpeed: sim.stats[STAT.meanSpeed] * 3.6,
          });
        }
      }
      // The terrain's tiles for this view (M6f).
      const terrainChanged = terrain.layer.update(camera, container.clientHeight);
      if (roads) roads.overviewHidden = traffic?.shows(view.viewHeight) ?? false;
      const roadsChanged =
        roads?.update({
          mode: activeRig.mode,
          target: view.target,
          viewHeight: view.viewHeight,
          distance: camera instanceof THREE.PerspectiveCamera ? distance : 0,
          aspect,
        }) ?? false;
      const buildingsChanged =
        buildings?.update(
          {
            target: view.target,
            viewHeight: view.viewHeight,
            distance,
            aspect,
            perspective: camera instanceof THREE.PerspectiveCamera,
          },
          5,
        ) ?? false;
      const trafficMapChanged = traffic?.update(view.viewHeight) ?? false;
      // The light of the simulated time of day (the clock in Zagreb without a simulation).
      const nowMs = Date.now();
      const clock = sim?.cur
        ? sim.displayTime(performance.now())
        : (((nowMs / 1000 + zagrebOffset(nowMs) * 3600) % 86_400) + 86_400) % 86_400;
      let lightChanged = applyLight(clock);
      // Lit windows only while it is dark (they cost something on every wall pixel).
      const dark = nightUniform.value > 0.01;
      if (buildings?.setNight(dark)) lightChanged = true;
      if (zoning?.grown.setNight(dark)) lightChanged = true;
      const lampsChanged = streetLights?.update(view.target, view.viewHeight) ?? false;
      const look = WEATHER[weatherKind()];
      if (roads?.setWet(look.wet ? 1 : 0)) lightChanged = true;
      const falling = precipitation.update(
        view.target,
        terrain.heightfield.sample(view.target.x, view.target.z),
        view.viewHeight,
        activeRig.mode === 'map',
      );
      if (falling) lightChanged = true;
      if (sound.enabled && vehicles) {
        const { near } = vehicles;
        sound.update({
          vehicles: near.vehicles,
          speed: near.speed,
          trams: near.trams,
          rain: look.falling === 'rain' ? look.amount : 0,
          snow: look.falling === 'snow' ? look.amount : 0,
          viewHeight: view.viewHeight,
        });
      }
      // Both every frame: one rebuilding must not hold the other up.
      const lotsChanged = zoning?.layer.update(view.target, view.viewHeight) ?? false;
      const grownChanged = zoning?.grown.update(view.viewHeight) ?? false;
      const zonesChanged = lotsChanged || grownChanged;
      if (
        !moving &&
        !dirty &&
        !roadsChanged &&
        !buildingsChanged &&
        !trafficMoving &&
        !trafficMapChanged &&
        !zonesChanged &&
        !lightChanged &&
        !lampsChanged &&
        !terrainChanged
      ) {
        return false;
      }
      dirty = false;

      // Haze that hides the edge of the data in the 3D view; rain, snow and fog add a haze
      // that reaches the point looked at (in the map view too, where everything on the
      // ground is about as far from the camera).
      const haze = WEATHER[weatherKind()].haze;
      if (camera instanceof THREE.PerspectiveCamera || haze > 0) {
        fog.near = camera instanceof THREE.PerspectiveCamera ? Math.max(3_000, distance) : 0;
        fog.far =
          camera instanceof THREE.PerspectiveCamera ? Math.max(20_000, distance * 4) : Infinity;
        if (haze > 0) {
          fog.near = 0;
          fog.far = Math.min(fog.far, distance / haze);
        }
        scene.fog = fog;
      } else {
        scene.fog = null;
      }
      renderer.render(scene, camera);
      const { clientWidth: viewW, clientHeight: viewH } = container;
      const toScreen = (x: number, y: number, z: number): [number, number] | null => {
        marker.set(x, y, z).project(camera);
        if (marker.z > 1 || Math.abs(marker.x) > 1.05 || Math.abs(marker.y) > 1.05) return null;
        return [((marker.x + 1) / 2) * viewW, ((1 - marker.y) / 2) * viewH];
      };
      const closures = closureLayer;
      if (closures && closureMarkers?.visible) {
        closureMarkers.place((x, z) => toScreen(x, closures.markerY(x, z), z));
      }
      if (railMarkers?.visible) {
        railMarkers.place((x, z) => toScreen(x, terrain.heightfield.sample(x, z) + 2, z));
      }
      if (transitMarkers?.visible) {
        transitMarkers.place((x, z) => toScreen(x, terrain.heightfield.sample(x, z) + 2, z));
      }
      const newsLayer = news;
      if (newsLayer && newsPanel?.visible) {
        newsPanel.place((place) => toScreen(place.x, newsLayer.markerY(place), place.z));
      }
      hud.update({
        mode: activeRig.mode,
        azimuth: view.azimuth,
        metersPerPixel: view.viewHeight / Math.max(1, container.clientHeight),
      });
      return true;
    };

    // ?perf: frame rate, frame time, draw calls and the simulation's step time (M6f).
    const frameStats = params.has('perf') ? new FrameStats() : undefined;
    const perfOverlay = frameStats ? new PerfOverlay(container) : undefined;
    let lastPerf = 0;
    renderer.setAnimationLoop((time: number) => {
      const t0 = performance.now();
      const drawn = drawFrame(time);
      if (!frameStats || !perfOverlay) return;
      const t1 = performance.now();
      const { drawCalls, triangles } = renderer.info.render;
      frameStats.add({ at: t0, ms: t1 - t0, drawn, drawCalls, triangles });
      if (t1 - lastPerf < 500) return;
      lastPerf = t1;
      const perf: Perf = frameStats.summary();
      if (sim?.stats) {
        perf.sim = {
          stepMs: sim.stepMs,
          dt: sim.dt,
          rate: sim.rate,
          speed: sim.paused ? 0 : sim.speed,
          vehicles: sim.stats[STAT.running],
        };
      }
      debug.perf = perf;
      perfOverlay.show(perf, t1);
    });

    hud.ready();
    debug.ready = true;
  } catch (error) {
    console.error(error);
    hud.setError(error instanceof Error ? error.message : String(error));
  }
}
