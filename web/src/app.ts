import * as THREE from 'three/webgpu';

import { CameraRig, type ViewMode } from './camera/CameraRig';
import { attributions, loadManifest } from './manifest';
import { SimClient } from './sim/client';
import { STAT } from './sim/wasm';
import { Hud } from './ui/hud';
import { BuildingLayer, loadBuildings } from './world/buildingLayer';
import { WorldFrame } from './world/frame';
import type { HeightFn } from './world/roadGeometry';
import { RoadLayer } from './world/roadLayer';
import { type RoadNetwork, laneShapeHeights, loadRoadNetwork } from './world/roadNetwork';
import { loadTerrain } from './world/terrain';
import { VehicleLayer } from './world/vehicleLayer';

const SKY = new THREE.Color(0xb9cfe0);

/** Car trips per weekday: 767k residents × 1.84 trips × 46 % by car ÷ 1.3 per car. */
const DAILY_TRIPS = 500_000;
/** The simulation starts at 07:00 after filling the streets from 06:50 at full speed. */
const START_TIME = 6 * 3600 + 50 * 60;
const WARM_UNTIL = 7 * 3600;
const WASM_URL = `${import.meta.env.BASE_URL}sim/zg_sim.wasm`;

/** Start the traffic simulation in a worker on the loaded network. */
function startSimulation(net: RoadNetwork, height: HeightFn, speed: number): SimClient {
  const laneShapeY = laneShapeHeights(net, height);
  return new SimClient(
    {
      wasmUrl: new URL(WASM_URL, document.baseURI).href,
      // Views share the network's buffer, which is copied once; the heights are moved.
      arrays: { ...net.arrays, laneShape: net.laneShape, laneShapeY },
      seed: 1,
      dailyTrips: DAILY_TRIPS,
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
  const hud = new Hud(container, {
    onMode: (mode) => rig?.setMode(mode),
    onRotateIso: (direction) => rig?.rotateIso(direction),
    onFaceNorth: () => rig?.faceNorth(),
    onPause: (paused) => sim?.setPaused(paused),
    onSpeed: (speed) => {
      sim?.setSpeed(speed);
      if (sim?.paused) sim.setPaused(false);
    },
  });

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

    // Roads load after the terrain is on screen, then traffic starts on them.
    let roads: RoadLayer | undefined;
    let vehicles: VehicleLayer | undefined;
    let simChanged = false;
    const networkLayer = manifest.layers.network;
    if (networkLayer) {
      hud.setNotice('Loading road network…');
      const surface = terrain.heightfield.meshSurface(stride);
      loadRoadNetwork(networkLayer.index)
        .then((net) => {
          roads = new RoadLayer(net, surface);
          scene.add(roads.object);
          debug.roads = roads;
          invalidate();
          if (params.get('sim') === 'off') return;
          vehicles = new VehicleLayer(surface);
          scene.add(vehicles.object);
          debug.vehicles = vehicles;
          sim = startSimulation(net, surface, Number(params.get('speed')) || 1);
          debug.sim = sim;
          sim.onFrame = () => {
            simChanged = true;
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
            meanSpeed: sim.stats[STAT.meanSpeed] * 3.6,
          });
        }
      }
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
      if (!moving && !dirty && !roadsChanged && !buildingsChanged && !trafficMoving) return;
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
