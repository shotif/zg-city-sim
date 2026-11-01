/**
 * Today's lorry rules (M21), as the network step found them (`pipeline/lorries.py`): the
 * roads OpenStreetMap closes to lorries or limits by weight (`edgeMaxWeight`, tenths of a
 * tonne), and Zagreb's central zone (`lorryZone`), which lorries over 12 t may not drive
 * into but by permit. The engine keeps both whatever the player does: lorry routes count an
 * hour for a road limited to less than the lorry weighs, and for each road over the zone's
 * edge if the lorry is heavy, so lorries use them only to reach places there.
 */
import type { RoadNetwork } from '../world/roadNetwork';
import type { AreaPoint } from './policies';

export interface LorryRules {
  /** The central zone's corners (empty if the network has none). */
  zone: AreaPoint[];
  /** Lorries over this may not enter it (t). */
  tonnes: number;
  /** Its area (km²). */
  areaKm2: number;
  /** Edges (not inside junctions) closed to lorries or limited by weight. */
  limited: number[];
}

/** The rules in network `net`, or undefined if it has neither a zone nor limits. */
export function lorryRules(net: RoadNetwork): LorryRules | undefined {
  const zoneArray = net.arrays.lorryZone as Float32Array | undefined;
  const weights = net.arrays.edgeMaxWeight as Uint16Array | undefined;
  const zone: AreaPoint[] = [];
  for (let i = 0; zoneArray && i + 1 < zoneArray.length; i += 2) {
    zone.push({ x: zoneArray[i], z: zoneArray[i + 1] });
  }
  const internal = net.index.flags.internal;
  const limited: number[] = [];
  for (let e = 0; weights && e < weights.length; e++) {
    if (weights[e] > 0 && !(net.edgeFlags[e] & internal)) limited.push(e);
  }
  if (zone.length < 3 && limited.length === 0) return undefined;
  const info = net.index.lorryZones?.[0];
  return {
    zone: zone.length >= 3 ? zone : [],
    tonnes: info?.tonnes ?? 12,
    areaKm2: info?.areaKm2 ?? 0,
    limited,
  };
}

/** The rules in plain words. */
export function lorryRulesText(rules: LorryRules): string {
  const n = (x: number) => x.toLocaleString('en-GB');
  const parts: string[] = [];
  if (rules.zone.length) {
    parts.push(
      `lorries over ${n(rules.tonnes)} t may not drive into the central zone ` +
        `(${rules.areaKm2.toFixed(1)} km², the City's order of 2024) but by permit`,
    );
  }
  if (rules.limited.length) {
    parts.push(
      `${n(rules.limited.length)} road pieces (each way counted) are closed to lorries or ` +
        'limited by weight (OpenStreetMap)',
    );
  }
  return (
    `Today ${parts.join(', and ')}. Lorries keep off them unless they have business there; ` +
    'lorries over 12 t are about half of all lorries on trips in the City (an estimate from ' +
    'the counts).'
  );
}
