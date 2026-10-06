import { describe, expect, it } from 'vitest';

import { type PackedIndex, unpack } from '../src/data/packed';

describe('unpack', () => {
  it('creates typed views at the recorded offsets', () => {
    const buffer = new ArrayBuffer(16);
    new Uint8Array(buffer, 0, 3).set([1, 2, 3]);
    new Float32Array(buffer, 4, 2).set([1.5, -2.25]);
    new Uint32Array(buffer, 12, 1).set([0xffffffff]);
    const index: PackedIndex = {
      file: 'x.bin.gz',
      byteLength: 16,
      arrays: {
        a: { type: 'u8', offset: 0, length: 3 },
        b: { type: 'f32', offset: 4, length: 2 },
        c: { type: 'u32', offset: 12, length: 1 },
      },
    };
    const out = unpack(buffer, index);
    expect(Array.from(out.a)).toEqual([1, 2, 3]);
    expect(Array.from(out.b)).toEqual([1.5, -2.25]);
    expect(out.c[0]).toBe(0xffffffff);
  });

  it('rejects data of the wrong size', () => {
    expect(() => unpack(new ArrayBuffer(8), { file: '', byteLength: 16, arrays: {} })).toThrow();
  });
});
