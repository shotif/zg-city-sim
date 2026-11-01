/**
 * The City's districts of the lots zoned (M19c), for the career's goals on growth: a lot's
 * district is that of the street in front of it where people already live there (the
 * demand's `demandDistrict`), else that of the nearest street where they do. Streets
 * outside the City have none.
 */
import type { Lots } from '../grow/lots';
import type { RoadNetwork } from '../world/roadNetwork';

/** Grid cell for the nearest-street search (m). */
const CELL = 400;

/** Each lot's district: an index into the demand's district names, or -1 outside the City
 * (`demandDistrict` values of `districts` or more). */
export function lotDistricts(
  lots: Lots,
  net: RoadNetwork,
  demandEdge: ArrayLike<number>,
  demandDistrict: ArrayLike<number>,
  districts: number,
): Int16Array {
  const byEdge = new Map<number, number>();
  const grid = new Map<string, { x: number; z: number; d: number }[]>();
  for (let i = 0; i < demandEdge.length; i++) {
    const e = demandEdge[i];
    const d = demandDistrict[i] < districts ? demandDistrict[i] : -1;
    byEdge.set(e, d);
    if (e >= net.edgeLaneStart.length) continue;
    const { start, count } = net.lanePoints(net.edgeLaneStart[e]);
    if (count === 0) continue;
    const p = start + Math.floor(count / 2);
    const x = net.laneShape[p * 3];
    const z = net.laneShape[p * 3 + 1];
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const cell = grid.get(key) ?? [];
    cell.push({ x, z, d });
    grid.set(key, cell);
  }
  const out = new Int16Array(lots.count).fill(-1);
  for (let i = 0; i < lots.count; i++) {
    const known = byEdge.get(lots.edge[i]);
    if (known !== undefined) {
      out[i] = known;
      continue;
    }
    const [x, z] = [lots.x[i], lots.z[i]];
    const [cx, cz] = [Math.floor(x / CELL), Math.floor(z / CELL)];
    let best = Infinity;
    for (let r = 1; r <= 3 && best === Infinity; r++) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gz = cz - r; gz <= cz + r; gz++) {
          for (const s of grid.get(`${gx},${gz}`) ?? []) {
            const dist = (s.x - x) ** 2 + (s.z - z) ** 2;
            if (dist < best) {
              best = dist;
              out[i] = s.d;
            }
          }
        }
      }
    }
  }
  return out;
}
