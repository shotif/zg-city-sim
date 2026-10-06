import { describe, expect, it } from 'vitest';

import {
  type ProjectComparison,
  comparisonRows,
  edgeMap,
  projectUrl,
  pullCounts,
} from '../src/edit/projects';
import { RoadIndex } from '../src/edit/roadIndex';
import { junction } from './fixtures';

const comparison: ProjectComparison = {
  computed: '2026-10-06',
  fromHour: 6,
  hours: 4,
  demandScale: 0.6,
  totals: {
    today: { delayHours: 9000, vehicleKm: 1_500_000, arrived: 120_000, tripMinutes: 26.4 },
    project: { delayHours: 8600, vehicleKm: 1_490_000, arrived: 120_500, tripMinutes: 25.9 },
  },
  travel: { perHour: [{ hour: 8, mean: -0.01 }], mean: -0.01, faster: [], slower: [] },
  roads: [],
  noise: null,
};

describe('planned projects', () => {
  it("opens a project by the page's address, keeping the rest of it", () => {
    const base = 'https://example.org/zg-city-sim/?speed=4#edits=abc';
    expect(projectUrl(base, 'jarunski-most')).toBe(
      'https://example.org/zg-city-sim/?speed=4&project=jarunski-most#edits=abc',
    );
    const open = 'https://example.org/zg-city-sim/?project=jarunski-most&speed=4';
    expect(projectUrl(open, undefined)).toBe('https://example.org/zg-city-sim/?speed=4');
    expect(projectUrl(open, 'sarengradska')).toContain('project=sarengradska');
  });

  it('lists the before and after numbers, today first', () => {
    const rows = comparisonRows(comparison);
    expect(rows.map((r) => r.label)).toEqual(['Delay', 'Mean trip', 'Driven', 'Trips finished']);
    expect(rows[0]).toMatchObject({ today: 9000, edited: 8600, moreIsBetter: false });
    expect(rows[3]).toMatchObject({ today: 120_000, edited: 120_500, moreIsBetter: true });
  });

  it('finds each road again on another build of the network and reads its counts', () => {
    const index = new RoadIndex(junction());
    const map = edgeMap(index, index);
    expect(Array.from(map)).toEqual([0, 1, 2]);
    // A road the other network does not have counts nothing.
    expect(Array.from(pullCounts([10, 20, 30], Int32Array.from([2, -1, 0])))).toEqual([30, 0, 10]);
  });
});
