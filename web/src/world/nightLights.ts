/**
 * Lights at night (M6a), drawn by the GPU from two numbers the app sets each frame: how
 * dark it is, and the share of windows lit at this hour.
 *
 * Windows are a pattern on the walls, not geometry: storeys 3 m high, a window 1.45 m wide
 * every 3.2 m along the wall, each lit or not by a hash of where it is.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  positionLocal,
  distance,
  float,
  floor,
  fract,
  hash,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

/** 0 by day, 1 at night. */
export const nightUniform = uniform(0);
/** Share of windows lit (0-1). */
export const litUniform = uniform(0.4);

/** Storey height and window spacing on walls (m). */
const STOREY = 3;
const BAY = 3.2;
/** Colour of lit windows: warm interior light. */
const WINDOW = vec3(1.0, 0.7, 0.36);

/** Emissive colour for building walls: lit windows at night. */
export function windowGlow() {
  // Walls only: faces whose normal is near horizontal.
  const wall = float(1).sub(step(0.5, abs(normalWorld.y)));
  // Along the wall (the face's horizontal tangent) and up it.
  const along = positionWorld.z.mul(normalWorld.x).sub(positionWorld.x.mul(normalWorld.z));
  const u = along.div(BAY);
  const v = positionWorld.y.div(STOREY);
  const fu = fract(u);
  const fv = fract(v);
  const pane = step(0.27, fu).mul(step(fu, 0.72)).mul(step(0.3, fv)).mul(step(fv, 0.78));
  const seed = floor(u)
    .mul(12.9898)
    .add(floor(v).mul(78.233))
    .add(floor(positionWorld.x.add(positionWorld.z).div(97)));
  const on = step(hash(seed), litUniform);
  return WINDOW.mul(pane.mul(on).mul(wall).mul(nightUniform).mul(0.95));
}

/** Draw order: pools of light come after the ground and roads (0) and before buildings
 * and vehicles, which hide them where they stand in front. */
export const GLOW_ORDER = 1;
export const SOLID_ORDER = 2;

/** Material for pools of light on the ground (street lamps, headlights): additive, fading
 * from the centre of the quad (`uv` 0.5, 0.5) to its edge, shown at night. They are drawn
 * without a depth test (in the opaque pass, at `GLOW_ORDER`), so a pool lies on the
 * ground however the coarse terrain slopes under it. `size` (a uniform) scales each quad
 * about its centre, and dims it as much, so lamps still show as a glow when the view is
 * far out. */
export function glowMaterial(
  color: number,
  strength: number,
  size?: ReturnType<typeof uniform<'float'>>,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: false,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const d = distance(uv(), vec2(0.5, 0.5)).mul(2);
  const fall = float(1).sub(smoothstep(0, 1, d));
  material.color = new THREE.Color(color);
  const opacity = fall.mul(nightUniform).mul(strength);
  if (size) {
    material.positionNode = positionLocal.mul(vec3(size, 1, size));
    material.opacityNode = opacity.div(size.sqrt());
  } else {
    material.opacityNode = opacity;
  }
  return material;
}
