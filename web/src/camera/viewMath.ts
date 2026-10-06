/** Pure camera maths shared by the camera rig and the HUD. Angles in radians. */

/** Map view looks straight down. A tiny tilt keeps north up and avoids a degenerate lookAt. */
export const MAP_POLAR = 1e-4;

/** True isometric view: the camera is 35.264° above the horizon. */
export const ISO_POLAR = Math.PI / 2 - Math.atan(1 / Math.SQRT2);

/** Default tilt of the free 3D view. */
export const FREE_POLAR = (55 * Math.PI) / 180;

/** Isometric views look from one of the four diagonals: 45°, 135°, 225°, 315°. */
export function isoAzimuth(quadrant: number): number {
  const q = ((quadrant % 4) + 4) % 4;
  return Math.PI / 4 + (q * Math.PI) / 2;
}

/** The isometric quadrant closest to an arbitrary azimuth. */
export function nearestIsoQuadrant(azimuth: number): number {
  const q = Math.round((azimuth - Math.PI / 4) / (Math.PI / 2));
  return ((q % 4) + 4) % 4;
}

/** Distance from target at which a perspective camera sees `viewHeight` metres vertically. */
export function distanceForViewHeight(viewHeight: number, fovDeg: number): number {
  return viewHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

export function viewHeightForDistance(distance: number, fovDeg: number): number {
  return 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
}

/** Orthographic zoom that shows `viewHeight` metres when the frustum is `frustumHeight` at zoom 1. */
export function zoomForViewHeight(viewHeight: number, frustumHeight: number): number {
  return frustumHeight / viewHeight;
}

export function viewHeightForZoom(zoom: number, frustumHeight: number): number {
  return frustumHeight / zoom;
}

/** Shortest-path interpolation between two angles. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Largest 1, 2 or 5 x 10^n that is <= maxMeters (for scale bars). */
export function niceScaleLength(maxMeters: number): number {
  if (!(maxMeters > 0)) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  for (const step of [5, 2, 1]) {
    if (step * magnitude <= maxMeters) return step * magnitude;
  }
  return magnitude;
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}
