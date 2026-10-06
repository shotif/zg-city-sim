import { describe, expect, it } from 'vitest';

import { classifyEdgeType, decodePolylines } from '../src/world/roadNetwork';

describe('classifyEdgeType', () => {
  it('maps SUMO OSM types to road classes', () => {
    expect(classifyEdgeType('highway.motorway')).toBe('motorway');
    expect(classifyEdgeType('highway.primary_link')).toBe('primary');
    expect(classifyEdgeType('highway.residential')).toBe('minor');
    expect(classifyEdgeType('highway.living_street')).toBe('minor');
    expect(classifyEdgeType('highway.service|psv')).toBe('service');
    expect(classifyEdgeType('highway.service|railway.rail')).toBe('service');
    expect(classifyEdgeType('railway.tram')).toBe('tram');
    expect(classifyEdgeType('railway.rail')).toBe('rail');
  });
});

describe('decodePolylines', () => {
  it('accumulates centimetre steps and elevations', () => {
    const out = decodePolylines(
      new Int32Array([100, 200]),
      new Uint32Array([0, 2]),
      new Int16Array([0, 0, 150, -50]),
      new Int16Array([0, 600]),
    );
    expect(Array.from(out)).toEqual([1, 2, 0, 2.5, 1.5, 6]);
  });
});
