import { describe, expect, it } from 'vitest';

import { type ServicesData, serviceTotals } from '../src/ui/servicesPanel';

describe("today's services", () => {
  it('sums each kind in the City, leaving those beyond it out', () => {
    const data: ServicesData = {
      kinds: ['school', 'kindergarten', 'health', 'fire', 'police'],
      districts: ['Donji grad'],
      services: [
        { kind: 'school', name: 'OŠ A', x: 0, z: 0, edge: 1, district: 0, places: 562 },
        { kind: 'school', name: 'PŠ B', x: 0, z: 0, edge: 1, district: 0, places: 100 },
        { kind: 'school', name: 'OŠ Samobor', x: 0, z: 0, edge: 1, district: -1, places: 562 },
        {
          kind: 'fire',
          name: 'Vatrogasna postaja Centar',
          x: 0,
          z: 0,
          edge: 1,
          district: 0,
          places: 0,
        },
      ],
    };
    const t = serviceTotals(data);
    expect(t.school).toEqual({ count: 2, places: 662 });
    expect(t.fire).toEqual({ count: 1, places: 0 });
    expect(t.police).toEqual({ count: 0, places: 0 });
  });
});
