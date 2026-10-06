import { describe, expect, it } from 'vitest';

import { RENDER } from '../src/sim/wasm';
import { formatClock } from '../src/ui/hud';
import { interpolatePose, lerpAngle } from '../src/world/vehicleLayer';

/** One render frame with a single vehicle in slot 0. */
function frame(serial: number, x: number, z: number, heading: number): Uint32Array {
  const words = new Uint32Array(RENDER.stride);
  const floats = new Float32Array(words.buffer);
  floats[RENDER.x] = x;
  floats[RENDER.y] = 0.5;
  floats[RENDER.z] = z;
  floats[RENDER.heading] = heading;
  words[RENDER.serial] = serial;
  return words;
}

describe('lerpAngle', () => {
  it('turns the short way across ±π', () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI, 5);
    expect(lerpAngle(0.2, 0.4, 0.5)).toBeCloseTo(0.3, 6);
  });
});

describe('interpolatePose', () => {
  const pose = new Float64Array(4);

  it('moves a vehicle between frames', () => {
    expect(interpolatePose(frame(7, 0, 0, 0), frame(7, 10, -4, 0.5), 0, 0.25, pose)).toBe(true);
    expect(pose[0]).toBeCloseTo(2.5, 5);
    expect(pose[1]).toBeCloseTo(0.5, 5);
    expect(pose[2]).toBeCloseTo(-1, 5);
    expect(pose[3]).toBeCloseTo(0.125, 5);
  });

  it('does not slide a new vehicle from the slot’s previous one', () => {
    interpolatePose(frame(7, 0, 0, 0), frame(8, 10, -4, 0.5), 0, 0.25, pose);
    expect(pose[0]).toBeCloseTo(10, 5);
  });

  it('skips empty slots', () => {
    expect(interpolatePose(undefined, frame(0, 1, 1, 0), 0, 1, pose)).toBe(false);
  });
});

describe('formatClock', () => {
  it('shows hours and minutes, wrapping at midnight', () => {
    expect(formatClock(7 * 3600 + 5 * 60 + 59)).toBe('07:05');
    expect(formatClock(25 * 3600)).toBe('01:00');
  });
});
