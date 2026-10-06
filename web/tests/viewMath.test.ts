import { describe, expect, it } from 'vitest';

import {
  ISO_POLAR,
  distanceForViewHeight,
  easeInOutCubic,
  formatDistance,
  isoAzimuth,
  lerpAngle,
  nearestIsoQuadrant,
  niceScaleLength,
  viewHeightForDistance,
  viewHeightForZoom,
  zoomForViewHeight,
} from '../src/camera/viewMath';

const deg = (r: number) => (r * 180) / Math.PI;

describe('view maths', () => {
  it('isometric camera sits 35.264° above the horizon', () => {
    expect(90 - deg(ISO_POLAR)).toBeCloseTo(35.264, 3);
  });

  it('isometric azimuths are the four diagonals', () => {
    expect([0, 1, 2, 3].map((q) => deg(isoAzimuth(q)))).toEqual([45, 135, 225, 315]);
    expect(deg(isoAzimuth(-1))).toBeCloseTo(315);
    expect(nearestIsoQuadrant(0)).toBe(0); // north-facing snaps to 45°
    expect(nearestIsoQuadrant(Math.PI)).toBe(2);
    expect(nearestIsoQuadrant(-Math.PI / 4)).toBe(3);
  });

  it('perspective and orthographic framings agree on visible height', () => {
    const distance = distanceForViewHeight(5000, 45);
    expect(viewHeightForDistance(distance, 45)).toBeCloseTo(5000, 6);
    expect(viewHeightForZoom(zoomForViewHeight(5000, 1000), 1000)).toBeCloseTo(5000, 6);
  });

  it('interpolates angles the short way round', () => {
    expect(lerpAngle(deg2rad(350), deg2rad(10), 0.5)).toBeCloseTo(deg2rad(360), 6);
    expect(lerpAngle(deg2rad(10), deg2rad(350), 0.5)).toBeCloseTo(0, 6);
  });

  it('eases from 0 to 1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('picks 1-2-5 scale bar lengths', () => {
    expect(niceScaleLength(123)).toBe(100);
    expect(niceScaleLength(260)).toBe(200);
    expect(niceScaleLength(7300)).toBe(5000);
    expect(niceScaleLength(0)).toBe(0);
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(2000)).toBe('2 km');
  });
});

function deg2rad(d: number) {
  return (d * Math.PI) / 180;
}
