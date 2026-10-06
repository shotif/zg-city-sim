import { describe, expect, it } from 'vitest';

import { classifyEdgeType } from '../src/world/roadNetwork';

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
