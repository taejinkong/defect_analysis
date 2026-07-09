import { describe, expect, it } from 'vitest';
import { convexHull, findBlobs, minAreaRect, type Point } from './blobs';
import { createMask } from './image';
import type { Mask } from './types';

function maskOf(width: number, height: number, set: (x: number, y: number) => boolean): Mask {
  const m = createMask(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) m.data[y * width + x] = set(x, y) ? 1 : 0;
  return m;
}

function rectPoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const pts: Point[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pts.push({ x, y });
  return pts;
}

describe('findBlobs', () => {
  it('separates disjoint components and computes centroids', () => {
    const mask = maskOf(40, 20, (x, y) => (x >= 2 && x <= 6 && y >= 2 && y <= 6) || (x >= 20 && x <= 22 && y >= 10 && y <= 12));
    const blobs = findBlobs(mask).sort((a, b) => b.areaPx - a.areaPx);

    expect(blobs).toHaveLength(2);
    expect(blobs[0]!.areaPx).toBe(25);
    expect(blobs[0]!.cx).toBeCloseTo(4);
    expect(blobs[0]!.cy).toBeCloseTo(4);
    expect(blobs[1]!.areaPx).toBe(9);
    expect(blobs[1]!.cx).toBeCloseTo(21);
  });

  it('joins diagonal neighbors (8-connected)', () => {
    const mask = maskOf(10, 10, (x, y) => (x === 3 && y === 3) || (x === 4 && y === 4));
    expect(findBlobs(mask)).toHaveLength(1);
  });

  it('drops components below minArea', () => {
    const mask = maskOf(20, 20, (x, y) => (x < 2 && y < 2) || (x === 15 && y === 15));
    expect(findBlobs(mask, 4)).toHaveLength(1);
  });
});

describe('convexHull', () => {
  it('reduces a filled square to its four corners', () => {
    const hull = convexHull(rectPoints(0, 0, 5, 5));
    expect(hull).toHaveLength(4);
    const xs = hull.map((p) => p.x).sort();
    expect(xs).toEqual([0, 0, 5, 5]);
  });
});

describe('minAreaRect', () => {
  it('measures an axis-aligned horizontal bar', () => {
    const rect = minAreaRect(rectPoints(0, 0, 99, 4));
    expect(rect.long).toBeCloseTo(100, 0);
    expect(rect.short).toBeCloseTo(5, 0);
    expect(rect.angleDeg).toBeCloseTo(0, 0);
  });

  it('measures an axis-aligned vertical bar', () => {
    const rect = minAreaRect(rectPoints(0, 0, 4, 99));
    expect(rect.long).toBeCloseTo(100, 0);
    expect(rect.short).toBeCloseTo(5, 0);
    expect(rect.angleDeg).toBeCloseTo(90, 0);
  });

  it('gives a single-pixel row a finite width and aspect', () => {
    // Without the +1 pixel correction the short side is 0, the aspect is
    // Infinity, and every stray scanline becomes a line defect.
    const rect = minAreaRect(rectPoints(0, 0, 49, 0));
    expect(rect.short).toBe(1);
    expect(rect.long).toBeCloseTo(50, 0);
    expect(Number.isFinite(rect.long / rect.short)).toBe(true);
  });

  it('reports a square as aspect ~1', () => {
    const rect = minAreaRect(rectPoints(0, 0, 9, 9));
    expect(rect.long / rect.short).toBeCloseTo(1, 1);
  });

  it('finds the rotated axis of a diagonal bar', () => {
    const pts: Point[] = [];
    for (let t = 0; t < 80; t++) {
      for (let k = -1; k <= 1; k++) {
        pts.push({ x: Math.round(t * 0.7071 - k * 0.7071), y: Math.round(t * 0.7071 + k * 0.7071) });
      }
    }
    const rect = minAreaRect(pts);
    expect(rect.angleDeg).toBeCloseTo(45, 0);
    expect(rect.long / rect.short).toBeGreaterThan(8);
  });
});
