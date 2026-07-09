import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  angleFromOffset,
  angleToClockHour,
  offsetFromAngle,
  regionFromRadius,
  rotateClockwise,
} from './geometry';

describe('angle convention', () => {
  // The contract from docs/defect_taxonomy.md section 5. A sign error here
  // silently corrupts every heatmap and circular statistic downstream.
  it.each([
    ['6 o clock (bottom, FPCB)', 0, 1, 0],
    ['9 o clock (left)', -1, 0, 90],
    ['12 o clock (top)', 0, -1, 180],
    ['3 o clock (right)', 1, 0, 270],
  ])('%s', (_label, dx, dy, expected) => {
    expect(angleFromOffset(dx, dy)).toBeCloseTo(expected, 6);
  });

  it('maps angles to clock hours', () => {
    expect(angleToClockHour(0)).toBeCloseTo(6);
    expect(angleToClockHour(90)).toBeCloseTo(9);
    expect(angleToClockHour(270)).toBeCloseTo(3);
    expect(angleToClockHour(180)).toBeCloseTo(12);
  });

  it('reads just past the top as 12.x, never 0.x', () => {
    // A clock has no 0 o'clock. 187 degrees is a hair past 12, not before 1.
    expect(angleToClockHour(187)).toBeCloseTo(12.233, 2);
    expect(angleToClockHour(179)).toBeCloseTo(11.966, 2);
    expect(angleToClockHour(210)).toBeCloseTo(1);
    expect(angleToClockHour(355)).toBeCloseTo(5.833, 2);
  });

  it('never reports an hour below 1', () => {
    // Values just past the top run 12.0 .. 12.99 before wrapping to 1.0, the
    // way a clock face is actually read. What must never appear is "0.4시".
    for (let a = 0; a < 360; a += 0.5) {
      const h = angleToClockHour(a);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThan(13);
    }
  });

  it('round-trips offset and angle', () => {
    for (let a = 0; a < 360; a += 7) {
      const { dx, dy } = offsetFromAngle(a);
      expect(angleFromOffset(dx, dy)).toBeCloseTo(a, 6);
    }
  });

  it('measures the shorter way around', () => {
    expect(angleDelta(350, 10)).toBeCloseTo(20);
    expect(angleDelta(10, 350)).toBeCloseTo(20);
    expect(angleDelta(0, 180)).toBeCloseTo(180);
  });
});

describe('rotateClockwise', () => {
  it('sends 3 o clock to 6 o clock for +90 degrees', () => {
    const p = rotateClockwise(1, 0, 90);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it('advances the clock angle by the rotation amount', () => {
    const { dx, dy } = offsetFromAngle(30);
    const p = rotateClockwise(dx, dy, 45);
    expect(angleFromOffset(p.x, p.y)).toBeCloseTo(75, 6);
  });
});

describe('regionFromRadius', () => {
  it('uses inclusive upper bounds', () => {
    expect(regionFromRadius(0)).toBe('center');
    expect(regionFromRadius(0.35)).toBe('center');
    expect(regionFromRadius(0.3501)).toBe('mid');
    expect(regionFromRadius(0.75)).toBe('mid');
    expect(regionFromRadius(0.7501)).toBe('edge');
    expect(regionFromRadius(1)).toBe('edge');
  });
});
