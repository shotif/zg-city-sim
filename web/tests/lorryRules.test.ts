import { describe, expect, it } from 'vitest';

import { lorryRules, lorryRulesText } from '../src/edit/lorryRules';
import type { RoadNetwork } from '../src/world/roadNetwork';
import { MODELS, modelOf } from '../src/world/vehicleModels';
import { VEHICLE_TYPES } from '../src/sim/wasm';

/** Enough of a network for the rules: four edges, the third inside a junction. */
function network(arrays: Record<string, Uint16Array | Float32Array>): RoadNetwork {
  return {
    arrays,
    edgeFlags: new Uint8Array([0, 0, 16, 0]),
    index: {
      flags: { internal: 16 },
      lorryZones: [{ name: 'Central zone', tonnes: 12, areaKm2: 6.36, source: '' }],
    },
  } as unknown as RoadNetwork;
}

describe('lorryRules', () => {
  it('reads the zone and the roads limited by weight, not those inside junctions', () => {
    const rules = lorryRules(
      network({
        edgeMaxWeight: new Uint16Array([0, 50, 35, 120]),
        lorryZone: new Float32Array([0, 0, 100, 0, 100, 100]),
      }),
    )!;
    expect(rules.zone).toEqual([
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 100, z: 100 },
    ]);
    expect(rules.limited).toEqual([1, 3]);
    expect(rules.tonnes).toBe(12);
    const text = lorryRulesText(rules);
    expect(text).toContain('over 12 t may not drive into the central zone (6.4 km²');
    expect(text).toContain('2 road pieces');
  });

  it('is undefined for a network without either', () => {
    expect(lorryRules(network({}))).toBeUndefined();
    expect(lorryRules(network({ edgeMaxWeight: new Uint16Array(4) }))).toBeUndefined();
  });
});

describe('heavy lorries', () => {
  it('are drawn as lorries', () => {
    const heavy = VEHICLE_TYPES.indexOf('heavy');
    expect(heavy).toBe(6);
    expect(MODELS[heavy]).toBe(MODELS[VEHICLE_TYPES.indexOf('truck')]);
    expect(modelOf(heavy, 5)).toBe(modelOf(1, 5));
  });
});
