import { describe, expect, it } from 'vitest';

import { describeTraffic, formatReportDate } from '../src/ui/newsPanel';
import { placeTraffic } from '../src/world/newsLayer';
import type { RoadNetwork } from '../src/world/roadNetwork';

describe('formatReportDate', () => {
  it('writes dates out and marks undated reports', () => {
    expect(formatReportDate('2022-09-26')).toBe('26 Sep 2022');
    expect(formatReportDate(undefined)).toBe('Undated');
    expect(formatReportDate('soon')).toBe('soon');
  });
});

describe('placeTraffic', () => {
  // Three edges, one lane each: 100 m at 50 km/h, 300 m at 50 km/h, 100 m at 90 km/h.
  const net = {
    edgeLaneStart: new Uint32Array([0, 1, 2]),
    laneLength: new Float32Array([100, 300, 100]),
    laneSpeed: new Float32Array([50 / 3.6, 50 / 3.6, 90 / 3.6]),
  } as unknown as RoadNetwork;

  it('weights speeds by length and skips roads without traffic', () => {
    // 100 % on the short road, 50 % on the long one, none on the third.
    const traffic = placeTraffic(net, [0, 1, 2], new Uint8Array([254, 127, 255]));
    expect(traffic?.share).toBeCloseTo((100 * 1 + 300 * 0.5) / 400, 3);
    expect(traffic?.kmh).toBeCloseTo((100 * 50 + 300 * 25) / 400, 1);
  });

  it('is undefined when nothing drove there', () => {
    expect(placeTraffic(net, [0, 2], new Uint8Array([255, 0, 255]))).toBeUndefined();
  });
});

describe('describeTraffic', () => {
  it('names the traffic map band', () => {
    expect(describeTraffic({ share: 0.3, kmh: 15 })).toBe(
      'Simulation now: congested, 15 km/h (30 % of the speed limit).',
    );
    expect(describeTraffic(undefined)).toMatch(/no traffic/);
    expect(describeTraffic(null)).toMatch(/not running/);
  });
});
