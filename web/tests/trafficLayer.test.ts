import { describe, expect, it } from 'vitest';

import { TRAFFIC_BANDS, trafficColor } from '../src/world/trafficLayer';

describe('trafficColor', () => {
  it('maps the share of the speed limit to the bands', () => {
    const [flowing, slow, congested, jammed] = TRAFFIC_BANDS.map((b) => b.color);
    expect(trafficColor(254)).toBe(flowing);
    expect(trafficColor(Math.round(0.7 * 254))).toBe(flowing);
    expect(trafficColor(Math.round(0.5 * 254))).toBe(slow);
    expect(trafficColor(Math.round(0.3 * 254))).toBe(congested);
    expect(trafficColor(0)).toBe(jammed);
  });

  it('shows roads without traffic in grey', () => {
    expect(TRAFFIC_BANDS.map((b) => b.color)).not.toContain(trafficColor(255));
  });
});
