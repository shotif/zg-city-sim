import { describe, expect, it } from 'vitest';

import { FrameStats, perfText } from '../src/ui/perfOverlay';

describe('frame statistics', () => {
  it('counts frames drawn and loops over the last two seconds', () => {
    const stats = new FrameStats(2000);
    // Three seconds at 60 loops a second, drawing every other one; the first second drops out.
    for (let i = 0; i <= 180; i++) {
      const drawn = i % 2 === 0;
      stats.add({
        at: i * (1000 / 60),
        ms: drawn ? 4 + (i % 10) : 0.2,
        drawn,
        drawCalls: i,
        triangles: 1000,
      });
    }
    const s = stats.summary();
    expect(s.loops).toBeCloseTo(60, 0);
    expect(s.fps).toBeCloseTo(30, 0);
    expect(s.meanMs).toBeGreaterThan(4);
    expect(s.meanMs).toBeLessThan(13);
    expect(s.worstMs).toBe(12);
    expect(s.p95Ms).toBeLessThanOrEqual(s.worstMs);
    expect(s.drawCalls).toBe(180);
  });

  it('says how much of a core the simulation takes', () => {
    const empty = new FrameStats().summary();
    expect(empty.fps).toBe(0);
    // 2 ms a step of 0.5 s at 16×: 32 steps a second, 64 ms: 6 % of a core.
    const text = perfText({
      ...empty,
      sim: { stepMs: 2, dt: 0.5, rate: 16, speed: 16, vehicles: 12_345 },
    });
    expect(text).toContain('6 % of a core');
    expect(text).toContain('12,345 vehicles');
  });
});
