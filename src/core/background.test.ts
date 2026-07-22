import { describe, expect, it } from 'vitest';
import { fitBackgroundSurface, residual } from './background';
import { circleMask, createGray } from './image';
import type { Gray, Mask } from './types';

const W = 128;
const H = 128;
const MASK: Mask = circleMask(W, H, 64, 64, 60);

function grayOf(fn: (x: number, y: number) => number): Gray {
  const g = createGray(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.data[y * W + x] = fn(x, y);
  return g;
}

function at(g: Gray, x: number, y: number): number {
  return g.data[y * W + x];
}

/** Paint a filled disc of `level` into an existing image. */
function disc(g: Gray, cx: number, cy: number, r: number, level: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) g.data[y * W + x] = level;
    }
  }
}

describe('fitBackgroundSurface', () => {
  it('recovers a flat panel', () => {
    const bg = fitBackgroundSurface(grayOf(() => 180), MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(180, 0);
    expect(at(bg, 64, 20)).toBeCloseTo(180, 0);
  });

  it('recovers radial vignetting exactly', () => {
    // Vignetting is linear in r^2, which the quadratic basis spans exactly.
    const src = grayOf((x, y) => 200 * (1 - 0.15 * (((x - 64) ** 2 + (y - 64) ** 2) / 3600)));
    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(200, 0);
    expect(at(bg, 64, 10)).toBeCloseTo(at(src, 64, 10), 0);
  });

  it('recovers a directional illumination gradient', () => {
    // A purely radial model cannot represent this; the full quadratic can.
    const src = grayOf((x) => 140 + x * 0.4);
    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 30, 64)).toBeCloseTo(at(src, 30, 64), 0);
    expect(at(bg, 98, 64)).toBeCloseTo(at(src, 98, 64), 0);
  });

  it('is not dragged down by a dark defect covering a quarter of the panel', () => {
    // The failure this guards against: a local median would read the blob's own
    // level as background, and the blob would vanish from the residual.
    const src = grayOf(() => 190);
    disc(src, 64, 64, 30, 10);

    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(190, -1);

    const res = residual(src, bg, MASK);
    expect(res[64 * W + 64]).toBeLessThan(-150);
  });

  it('survives a dark defect covering nearly half the panel', () => {
    const src = grayOf(() => 190);
    disc(src, 64, 64, 41, 10); // ~47% of the active area
    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(190, -1);
  });

  it('is not pulled up by a bright line', () => {
    const src = grayOf(() => 150);
    for (let y = 62; y <= 64; y++) for (let x = 10; x < 118; x++) src.data[y * W + x] = 255;

    const bg = fitBackgroundSurface(src, MASK);

    // Tukey suppresses the line but does not erase its pull entirely. The
    // leftover bias must stay far below the 25/30 detection thresholds, or the
    // line would raise the surface enough to mask defects beside it.
    let maxBias = 0;
    for (let i = 0; i < bg.data.length; i++) {
      if (MASK.data[i] === 1) maxBias = Math.max(maxBias, Math.abs(bg.data[i] - 150));
    }
    expect(maxBias).toBeLessThan(5);

    const res = residual(src, bg, MASK);
    expect(res[63 * W + 64]).toBeGreaterThan(90);
  });

  it('does not mistake a thick bright line for the background class', () => {
    const src = grayOf(() => 185);
    for (let y = 52; y <= 75; y++) for (let x = 8; x < 120; x++) src.data[y * W + x] = 245;

    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(185, -1);

    const res = residual(src, bg, MASK);
    expect(res[64 * W + 64]).toBeGreaterThan(45);
  });

  it('leaves a clean panel with a near-zero residual', () => {
    const src = grayOf((x, y) => 190 * (1 - 0.1 * (((x - 64) ** 2 + (y - 64) ** 2) / 3600)));
    const res = residual(src, fitBackgroundSurface(src, MASK), MASK);
    let maxAbs = 0;
    for (let i = 0; i < res.length; i++) if (MASK.data[i] === 1) maxAbs = Math.max(maxAbs, Math.abs(res[i]));
    expect(maxAbs).toBeLessThanOrEqual(2);
  });

  it('ignores everything outside the mask', () => {
    // The dark background behind the display must not enter the fit.
    const src = grayOf((x, y) => (Math.hypot(x - 64, y - 64) <= 60 ? 190 : 0));
    const bg = fitBackgroundSurface(src, MASK);
    expect(at(bg, 64, 64)).toBeCloseTo(190, 0);
    expect(at(bg, 2, 2)).toBe(0);
  });
});
