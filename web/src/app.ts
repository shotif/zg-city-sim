import * as THREE from 'three/webgpu';

import { CameraRig, type ViewMode } from './camera/CameraRig';
import { attributions, loadManifest } from './manifest';
import { Hud } from './ui/hud';
import { WorldFrame } from './world/frame';
import { loadTerrain } from './world/terrain';

const SKY = new THREE.Color(0xb9cfe0);

/** Hooks for automated tests and debugging from the console. */
export interface DebugApi {
  ready: boolean;
  backend: string;
  setView(mode: ViewMode): void;
  rig?: CameraRig;
}

declare global {
  interface Window {
    __ZG__?: DebugApi;
  }
}

export async function startApp(container: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const debug: DebugApi = { ready: false, backend: 'none', setView: () => {} };
  window.__ZG__ = debug;

  let rig: CameraRig | undefined;
  const hud = new Hud(container, {
    onMode: (mode) => rig?.setMode(mode),
    onRotateIso: (direction) => rig?.rotateIso(direction),
    onFaceNorth: () => rig?.faceNorth(),
  });

  try {
    const renderer = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL: params.has('webgl'),
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

    const fog = new THREE.Fog(SKY, 1, 2);
    renderer.setAnimationLoop((time: number) => {
      const moving = activeRig.update(time);
      if (!moving && !dirty) return;
      dirty = false;

      const camera = activeRig.camera;
      const view = activeRig.state();
      if (camera instanceof THREE.PerspectiveCamera) {
        // Haze that hides the edge of the data in the 3D view.
        const distance = camera.position.distanceTo(view.target);
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
