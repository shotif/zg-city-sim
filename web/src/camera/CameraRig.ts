import * as THREE from 'three/webgpu';
import { MapControls } from 'three/addons/controls/MapControls.js';

import type { SceneBounds } from '../world/frame';
import {
  FREE_POLAR,
  ISO_POLAR,
  MAP_POLAR,
  distanceForViewHeight,
  easeInOutCubic,
  isoAzimuth,
  lerpAngle,
  nearestIsoQuadrant,
  viewHeightForDistance,
  viewHeightForZoom,
  zoomForViewHeight,
} from './viewMath';

export type ViewMode = 'map' | 'iso' | 'free';
type Projection = 'perspective' | 'orthographic';

export interface ViewState {
  target: THREE.Vector3;
  /** Rotation around the vertical axis; 0 looks north. */
  azimuth: number;
  /** Angle from straight down. */
  polar: number;
  /** Metres of ground visible vertically through the target. */
  viewHeight: number;
}

export interface CameraRigOptions {
  bounds: SceneBounds;
  groundHeight: (x: number, z: number) => number;
  initial: { x: number; z: number; viewHeight: number };
}

const FOV_DEG = 45;
const ORTHO_FRUSTUM = 1000; // orthographic frustum height at zoom 1, metres
const ORTHO_DISTANCE = 40_000; // orthographic camera distance from its target
const MIN_VIEW_HEIGHT = 60;
const MAX_VIEW_HEIGHT = 75_000;
const MIN_CLEARANCE = 8; // keep the perspective camera this far above the ground
const TRANSITION_MS = 750;

interface Transition {
  from: ViewState;
  to: ViewState;
  start: number;
  projection: Projection;
}

/**
 * Owns the perspective and orthographic cameras and switches between three views:
 * map (orthographic, straight down, north up), isometric (orthographic, 90° steps) and
 * free 3D (perspective, orbit and tilt).
 */
export class CameraRig {
  readonly perspective = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 300_000);
  readonly orthographic = new THREE.OrthographicCamera(
    -ORTHO_FRUSTUM / 2,
    ORTHO_FRUSTUM / 2,
    ORTHO_FRUSTUM / 2,
    -ORTHO_FRUSTUM / 2,
    1,
    ORTHO_DISTANCE * 2 + 20_000,
  );
  readonly controls: MapControls;

  private currentMode: ViewMode = 'map';
  private transition: Transition | null = null;
  private isoQuadrant = 0;
  private readonly bounds: SceneBounds;
  private readonly groundHeight: (x: number, z: number) => number;

  constructor(dom: HTMLElement, options: CameraRigOptions) {
    this.bounds = options.bounds;
    this.groundHeight = options.groundHeight;

    this.controls = new MapControls(this.orthographic, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 1.4;
    this.controls.keyPanSpeed = 25;
    this.controls.listenToKeyEvents(window);

    const { x, z, viewHeight } = options.initial;
    const target = new THREE.Vector3(x, this.groundHeight(x, z), z);
    this.apply({ target, azimuth: 0, polar: MAP_POLAR, viewHeight }, 'orthographic');
    this.applyConstraints();
  }

  get mode(): ViewMode {
    return this.currentMode;
  }

  /** The camera to render with. */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.controls.object as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  }

  setAspect(aspect: number): void {
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.orthographic.left = (-ORTHO_FRUSTUM * aspect) / 2;
    this.orthographic.right = (ORTHO_FRUSTUM * aspect) / 2;
    this.orthographic.updateProjectionMatrix();
  }

  /** The active camera's current view. */
  state(): ViewState {
    const camera = this.camera;
    const offset = new THREE.Vector3().subVectors(camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const viewHeight =
      camera instanceof THREE.OrthographicCamera
        ? viewHeightForZoom(camera.zoom, ORTHO_FRUSTUM)
        : viewHeightForDistance(spherical.radius, FOV_DEG);
    return {
      target: this.controls.target.clone(),
      azimuth: spherical.theta,
      polar: spherical.phi,
      viewHeight,
    };
  }

  setMode(mode: ViewMode, animate = true): void {
    if (mode === this.currentMode && !this.transition) return;
    const from = this.transition ? this.transition.to : this.state();
    const to: ViewState = { ...from, target: from.target.clone() };
    if (mode === 'map') {
      to.polar = MAP_POLAR;
      to.azimuth = 0;
    } else if (mode === 'iso') {
      this.isoQuadrant = nearestIsoQuadrant(from.azimuth);
      to.polar = ISO_POLAR;
      to.azimuth = isoAzimuth(this.isoQuadrant);
    } else {
      to.polar = FREE_POLAR;
    }
    // Animate in perspective whenever the free view is involved, so the tilt is visible.
    const projection: Projection =
      mode === 'free' || this.currentMode === 'free' ? 'perspective' : 'orthographic';
    this.currentMode = mode;
    this.startTransition(from, to, projection, animate);
  }

  /** Rotate the isometric view by 90° (direction 1 = clockwise). */
  rotateIso(direction: 1 | -1): void {
    if (this.currentMode !== 'iso') return;
    const from = this.transition ? this.transition.to : this.state();
    this.isoQuadrant = (this.isoQuadrant + direction + 4) % 4;
    this.startTransition(from, { ...from, azimuth: isoAzimuth(this.isoQuadrant) }, 'orthographic');
  }

  /** Turn the free view back to face north. */
  faceNorth(): void {
    if (this.currentMode !== 'free') return;
    const from = this.transition ? this.transition.to : this.state();
    this.startTransition(from, { ...from, azimuth: 0 }, 'perspective');
  }

  /** Move instantly to look at scene (x, z) showing `viewHeight` metres, keeping the angles. */
  jumpTo(x: number, z: number, viewHeight: number): void {
    const state = this.transition ? this.transition.to : this.state();
    this.transition = null;
    const target = new THREE.Vector3(x, this.groundHeight(x, z), z);
    this.settle({ ...state, target, viewHeight });
  }

  /** Advance transitions and inertia. Returns true while the view is still changing. */
  update(now: number): boolean {
    const transition = this.transition;
    if (transition) {
      const t = Math.min(1, (now - transition.start) / TRANSITION_MS);
      this.apply(
        interpolate(transition.from, transition.to, easeInOutCubic(t)),
        transition.projection,
      );
      if (t >= 1) {
        this.transition = null;
        this.settle(transition.to);
      }
      return true;
    }
    const changed = this.controls.update();
    this.keepAboveGround();
    if (this.camera instanceof THREE.PerspectiveCamera) this.updateClipping();
    return changed;
  }

  private startTransition(from: ViewState, to: ViewState, projection: Projection, animate = true) {
    this.controls.enabled = false;
    if (!animate) {
      this.transition = null;
      this.settle(to);
      return;
    }
    // Switch projection at the start, keeping the same framing.
    this.apply(from, projection);
    this.transition = { from, to, start: performance.now(), projection };
  }

  /** End of a transition: final projection, constraints, and no leftover inertia. */
  private settle(state: ViewState) {
    this.apply(state, this.currentMode === 'free' ? 'perspective' : 'orthographic');
    clearInertia(this.controls);
    this.applyConstraints();
    this.controls.enabled = true;
    this.controls.update();
  }

  private apply(state: ViewState, projection: Projection) {
    const camera = projection === 'perspective' ? this.perspective : this.orthographic;
    let radius = ORTHO_DISTANCE;
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = zoomForViewHeight(state.viewHeight, ORTHO_FRUSTUM);
      camera.updateProjectionMatrix();
    } else {
      radius = distanceForViewHeight(state.viewHeight, FOV_DEG);
    }
    camera.position.setFromSphericalCoords(radius, state.polar, state.azimuth).add(state.target);
    camera.lookAt(state.target);
    this.controls.object = camera;
    this.controls.target.copy(state.target);
    if (camera instanceof THREE.PerspectiveCamera) this.updateClipping();
  }

  private applyConstraints() {
    const c = this.controls;
    const free = this.currentMode === 'free';
    c.enableRotate = free;
    const polar = this.currentMode === 'map' ? MAP_POLAR : ISO_POLAR;
    c.minPolarAngle = free ? (2 * Math.PI) / 180 : polar;
    c.maxPolarAngle = free ? (84 * Math.PI) / 180 : polar;
    c.minDistance = distanceForViewHeight(MIN_VIEW_HEIGHT, FOV_DEG);
    c.maxDistance = free ? distanceForViewHeight(MAX_VIEW_HEIGHT, FOV_DEG) : Infinity;
    c.minZoom = zoomForViewHeight(MAX_VIEW_HEIGHT, ORTHO_FRUSTUM);
    c.maxZoom = zoomForViewHeight(MIN_VIEW_HEIGHT, ORTHO_FRUSTUM);
  }

  /** Keep the target inside the world and on the ground; keep the camera above the ground. */
  private keepAboveGround() {
    const target = this.controls.target;
    const camera = this.camera;
    const x = THREE.MathUtils.clamp(target.x, this.bounds.minX, this.bounds.maxX);
    const z = THREE.MathUtils.clamp(target.z, this.bounds.minZ, this.bounds.maxZ);
    const y = this.groundHeight(x, z);
    const dx = x - target.x;
    const dy = y - target.y;
    const dz = z - target.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      target.set(x, y, z);
      camera.position.add(new THREE.Vector3(dx, dy, dz));
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      const floor = this.groundHeight(camera.position.x, camera.position.z) + MIN_CLEARANCE;
      if (camera.position.y < floor) {
        camera.position.y = floor;
        camera.lookAt(target);
      }
    }
  }

  private updateClipping() {
    const distance = this.perspective.position.distanceTo(this.controls.target);
    this.perspective.near = THREE.MathUtils.clamp(distance * 0.002, 0.5, 50);
    this.perspective.far = Math.max(150_000, distance * 20);
    this.perspective.updateProjectionMatrix();
  }
}

function interpolate(a: ViewState, b: ViewState, t: number): ViewState {
  return {
    target: a.target.clone().lerp(b.target, t),
    azimuth: lerpAngle(a.azimuth, b.azimuth, t),
    polar: a.polar + (b.polar - a.polar) * t,
    viewHeight: a.viewHeight * Math.pow(b.viewHeight / a.viewHeight, t),
  };
}

/** OrbitControls keeps damping momentum in private fields; drop it after a programmatic move. */
function clearInertia(controls: MapControls) {
  const internals = controls as unknown as {
    _sphericalDelta?: THREE.Spherical;
    _panOffset?: THREE.Vector3;
    _scale?: number;
  };
  internals._sphericalDelta?.set(0, 0, 0);
  internals._panOffset?.set(0, 0, 0);
  if (internals._scale !== undefined) internals._scale = 1;
}
