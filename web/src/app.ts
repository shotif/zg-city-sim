import * as THREE from 'three/webgpu';

import { CameraRig, type ViewMode } from './camera/CameraRig';
import { type PackedIndex, type TypedArray, loadPacked } from './data/packed';
import {
  type Edit,
  type ResolvedEdit,
  decodeEditsFromUrl,
  editWords,
  encodeEditsForUrl,
  loadSavedEdits,
  parseEdits,
  resolveEdits,
  saveEdits,
  serializeEdits,
} from './edit/edits';
import { RoadIndex } from './edit/roadIndex';
import { DATA_URL, attributions, loadManifest } from './manifest';
import { SimClient } from './sim/client';
import { STAT } from './sim/wasm';
import { BuildPanel } from './ui/buildPanel';
import { ClosureMarkers } from './ui/closureMarkers';
import { Hud } from './ui/hud';
import { NewsPanel } from './ui/newsPanel';
import { BuildingLayer, loadBuildings } from './world/buildingLayer';
import {
  ClosureLayer,
  type PlacedClosure,
  activeClosures,
  loadClosures,
  placeClosures,
  zagrebNow,
} from './world/closures';
import { EDIT_COLORS, EditLayer } from './world/editLayer';
import { WorldFrame } from './world/frame';
import type { HeightFn } from './world/roadGeometry';
import { RoadLayer } from './world/roadLayer';
import { type RoadNetwork, laneShapeHeights, loadRoadNetwork } from './world/roadNetwork';
import { NewsLayer, loadNews, placeTraffic } from './world/newsLayer';
import { loadTerrain } from './world/terrain';
import { TRAFFIC_BANDS, TrafficLayer } from './world/trafficLayer';
import { VehicleLayer } from './world/vehicleLayer';

const SKY = new THREE.Color(0xb9cfe0);

/** Car trips per weekday without demand data: 767k residents × 1.84 trips × 46 % by car ÷ 1.3. */
const DAILY_TRIPS = 500_000;
/** The simulation starts at 07:00 after filling the streets from 06:50 at full speed. */
const START_TIME = 6 * 3600 + 50 * 60;
const WARM_UNTIL = 7 * 3600;
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

/** What the simulation needs besides the network: where people live and work, timetables. */
interface TravelData {
  arrays: Record<string, TypedArray>;
  dailyTrips: number;
  demandScale: number;
}

/** Start the traffic simulation in a worker on the loaded network. */
function startSimulation(
  net: RoadNetwork,
  travel: TravelData,
  height: HeightFn,
  speed: number,
): SimClient {
  const laneShapeY = laneShapeHeights(net, height);
  return new SimClient(
    {
      wasmUrl: new URL(WASM_URL, document.baseURI).href,
      // Views share the network's buffer, which is copied once; the heights are moved.
      arrays: { ...net.arrays, laneShape: net.laneShape, laneShapeY, ...travel.arrays },
      seed: 1,
      dailyTrips: travel.dailyTrips,
      demandScale: travel.demandScale,
      startTime: START_TIME,
      warmUntil: WARM_UNTIL,
      speed,
    },
    [laneShapeY.buffer],
  );
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
  let closureLayer: ClosureLayer | undefined;
  let closedEdges: Uint32Array | undefined;
  let buildPanel: BuildPanel | undefined;
  let invalidateView = () => {};
  // Edits: from a shared link, else saved in this browser.
  const editsFromLink = /[#&]edits=([^&]+)/.exec(location.hash)?.[1];
  let edits: Edit[] = loadSavedEdits();
  let editWordsNow: Uint32Array | undefined;
  const hud = new Hud(container, {
    onMode: (mode) => rig?.setMode(mode),
    onRotateIso: (direction) => rig?.rotateIso(direction),
    onFaceNorth: () => rig?.faceNorth(),
    onPause: (paused) => sim?.setPaused(paused),
    onSpeed: (speed) => {
      sim?.setSpeed(speed);
      if (sim?.paused) sim.setPaused(false);
    },
    onTrafficMap: (enabled) => {
      if (traffic) traffic.enabled = enabled;
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
      buildPanel?.setVisible(enabled);
      invalidateView();
    },
  });
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

    const coarsePointer = matchMedia('(pointer: coarse)').matches;
    const stride = Number(params.get('stride')) || (coarsePointer ? 4 : 2);
    const terrain = await loadTerrain(manifest, frame, stride, renderer.getMaxAnisotropy());

    const scene = new THREE.Scene();
    scene.background = SKY;
    scene.add(terrain.mesh);

    // Ground beyond the data extent, so the world doesn't end in a void.
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(600_000, 600_000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 1 }),
    );
    outside.position.y = terrain.minHeight - 3;
    scene.add(outside);

    // Cartographic light from the north-west, so relief reads well on the map.
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.position.set(-1, 1.4, -0.9);
    scene.add(sun, new THREE.HemisphereLight(0xdde8f5, 0x3b3a30, 1.1));

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
      attributions(manifest),
      `Renderer: ${backend} · terrain mesh every ${stride * terrain.heightfield.resolution} m · data built ${manifest.generated}`,
    );

    /** The Build tools: road picking, the panel, the edits layer and the edit list. */
    const setUpBuild = (net: RoadNetwork, surface: HeightFn): BuildPanel => {
      const index = new RoadIndex(net);
      debug.roadIndex = index;
      const layer = new EditLayer(net, surface);
      scene.add(layer.object);
      let resolved: ResolvedEdit[] = [];
      const redraw = () => {
        const groups: { edges: number[]; color: number; width?: number }[] = (
          Object.keys(EDIT_COLORS) as (keyof typeof EDIT_COLORS)[]
        )
          .filter((kind) => kind !== 'selected')
          .map((kind) => ({
            color: EDIT_COLORS[kind],
            edges: resolved
              .filter((r) => r.edit.kind === kind)
              .flatMap((r) => (r.edit.kind === 'ban' ? r.edges.slice(0, 1) : r.edges)),
          }));
        const selected = panel.selected;
        if (selected !== undefined) {
          groups.push({ color: EDIT_COLORS.selected, edges: [selected], width: 8 });
        }
        layer.show(groups);
        invalidate();
      };
      const apply = (list: Edit[]) => {
        edits = list;
        const matched = resolveEdits(index, list);
        resolved = matched.resolved;
        debug.edits = resolved;
        panel.setEdits(list, resolved, matched.missing.length);
        saveEdits(list);
        editWordsNow = editWords(resolved);
        sim?.setEdits(editWordsNow);
        if (list.length === 0) panel.setStatus('');
        if (!sim) panel.setInForce(0);
        redraw();
      };
      const panel = new BuildPanel(hud.element, index, {
        onEdits: apply,
        onSelect: () => redraw(),
        onClose: () => {
          hud.setBuild(false);
          panel.setVisible(false);
          invalidate();
        },
        shareLink: async (list) =>
          `${location.origin}${location.pathname}${location.search}#edits=${await encodeEditsForUrl(list)}`,
        importFile: async (file) => parseEdits(await file.text()),
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
      hud.enableBuild();

      // A click (not a drag) on the map picks the road there while the panel is open.
      const raycaster = new THREE.Raycaster();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      const pickAt = (px: number, py: number): number | undefined => {
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
        const metersPerPixel = view.viewHeight / Math.max(1, canvas.clientHeight);
        const radius = Math.min(60, Math.max(6, metersPerPixel * 12));
        return index.pick(hit.x, hit.z, radius);
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

    // Roads load after the terrain is on screen, then traffic starts on them.
    let roads: RoadLayer | undefined;
    let vehicles: VehicleLayer | undefined;
    let news: NewsLayer | undefined;
    let speeds: Uint8Array | undefined;
    let simChanged = false;
    const networkLayer = manifest.layers.network;
    if (networkLayer) {
      hud.setNotice('Loading road network…');
      const surface = terrain.heightfield.meshSurface(stride);
      // Car trips come from where people live and work (without that data, from the
      // streets); trams and buses run to ZET's timetable.
      const { demand: demandLayer, transit: transitLayer } = manifest.layers;
      const travel: Promise<TravelData> = Promise.all([
        loadLayerArrays(demandLayer?.index, 'Travel demand'),
        loadLayerArrays(transitLayer?.index, 'The ZET timetable'),
      ]).then(([demand, transit]) => ({
        arrays: { ...demand, ...transit },
        dailyTrips: demand && demandLayer ? demandLayer.dailyCarTrips : DAILY_TRIPS,
        demandScale: demandLayer?.demandScale ?? 1,
      }));
      loadRoadNetwork(networkLayer.index)
        .then(async (net) => {
          roads = new RoadLayer(net, surface);
          scene.add(roads.object);
          debug.roads = roads;
          invalidate();
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
          traffic = new TrafficLayer(net, surface);
          scene.add(traffic.object);
          debug.traffic = traffic;
          sim = startSimulation(net, await travel, surface, Number(params.get('speed')) || 1);
          debug.sim = sim;
          if (closedEdges) sim.setClosures(closedEdges);
          if (editWordsNow) sim.setEdits(editWordsNow);
          const running = sim;
          sim.onReady = () => {
            if (running.signals) buildPanel?.setSignals(running.signals);
          };
          sim.onEdited = (applied, signals) => {
            buildPanel?.setSignals(signals);
            buildPanel?.setInForce(applied);
          };
          sim.onFrame = () => {
            simChanged = true;
          };
          sim.onEdgeSpeeds = (latest) => {
            speeds = latest;
            traffic?.setSpeeds(latest);
            const place = news?.selected;
            if (place) newsPanel?.setTraffic(placeTraffic(net, place.edges, latest));
            invalidate();
          };
          sim.onError = (message) => {
            console.error(message);
            hud.setNotice(`The traffic simulation stopped: ${message}`);
          };
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

    const fog = new THREE.Fog(SKY, 1, 2);
    const marker = new THREE.Vector3();
    let lastHudSim = 0;
    renderer.setAnimationLoop((time: number) => {
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
            meanSpeed: sim.stats[STAT.meanSpeed] * 3.6,
          });
        }
      }
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
      if (
        !moving &&
        !dirty &&
        !roadsChanged &&
        !buildingsChanged &&
        !trafficMoving &&
        !trafficMapChanged
      ) {
        return;
      }
      dirty = false;

      if (camera instanceof THREE.PerspectiveCamera) {
        // Haze that hides the edge of the data in the 3D view.
        fog.near = Math.max(3_000, distance);
        fog.far = Math.max(20_000, distance * 4);
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
      const newsLayer = news;
      if (newsLayer && newsPanel?.visible) {
        newsPanel.place((place) => toScreen(place.x, newsLayer.markerY(place), place.z));
      }
      hud.update({
        mode: activeRig.mode,
        azimuth: view.azimuth,
        metersPerPixel: view.viewHeight / Math.max(1, container.clientHeight),
      });
    });

    hud.ready();
    debug.ready = true;
  } catch (error) {
    console.error(error);
    hud.setError(error instanceof Error ? error.message : String(error));
  }
}
