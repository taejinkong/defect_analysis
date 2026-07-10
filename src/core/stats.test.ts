import { describe, expect, it } from 'vitest';
import { chiSquareSurvival, circularStats, dbscan, polarBins, regionChiSquare } from './stats';

describe('circularStats', () => {
  it('averages across the 0/360 wrap correctly', () => {
    // The naive arithmetic mean of 350 and 10 is 180 — exactly wrong.
    const s = circularStats([350, 10]);
    expect(Math.min(s.meanDeg, 360 - s.meanDeg)).toBeCloseTo(0, 3);
  });

  it('reports a high resultant for concentrated angles', () => {
    const s = circularStats([88, 90, 92, 89, 91]);
    expect(s.meanDeg).toBeCloseTo(90, 0);
    expect(s.resultant).toBeGreaterThan(0.95);
    expect(s.rayleighP).toBeLessThan(0.05);
  });

  it('reports a low resultant and non-significant p for a uniform spread', () => {
    const angles = Array.from({ length: 24 }, (_, i) => i * 15);
    const s = circularStats(angles);
    expect(s.resultant).toBeLessThan(0.05);
    expect(s.rayleighP).toBeGreaterThan(0.5);
  });

  it('handles the empty set', () => {
    expect(circularStats([])).toMatchObject({ resultant: 0, rayleighP: 1, n: 0 });
  });
});

describe('dbscan', () => {
  it('finds two dense clusters and calls the stray noise', () => {
    const points = [
      { x: 0, y: 0 }, { x: 0.02, y: 0.01 }, { x: 0.01, y: -0.02 }, { x: -0.01, y: 0.01 },
      { x: 1, y: 1 }, { x: 1.02, y: 0.99 }, { x: 0.99, y: 1.01 }, { x: 1.01, y: 1.0 },
      { x: 5, y: 5 },
    ];
    const { clusters, noise } = dbscan(points, 0.08, 3);
    expect(clusters).toHaveLength(2);
    expect(noise).toEqual([8]);
  });

  it('returns no clusters when nothing is dense enough', () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
    const { clusters, noise } = dbscan(points, 0.08, 3);
    expect(clusters).toHaveLength(0);
    expect(noise).toHaveLength(3);
  });

  it('puts the centroid at the cluster center', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.04, y: 0 }, { x: 0.02, y: 0.03 }];
    const { clusters } = dbscan(points, 0.08, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.centroid.x).toBeCloseTo(0.02, 2);
  });
});

describe('chiSquareSurvival', () => {
  // Reference values from standard chi-square tables.
  it('matches known tail probabilities', () => {
    expect(chiSquareSurvival(3.841, 1)).toBeCloseTo(0.05, 2);
    expect(chiSquareSurvival(5.991, 2)).toBeCloseTo(0.05, 2);
    expect(chiSquareSurvival(11.07, 5)).toBeCloseTo(0.05, 2);
    expect(chiSquareSurvival(0, 3)).toBe(1);
  });
});

describe('regionChiSquare', () => {
  const areaFracThresholds = { center: 0.35, mid: 0.75 };

  it('flags edge clustering with a positive residual', () => {
    // All 100 of one defect land at the edge; area predicts most there but not all.
    const byDefect = new Map([['D003', { center: 0, mid: 0, edge: 100 }]]);
    const result = regionChiSquare(byDefect, areaFracThresholds.center, areaFracThresholds.mid);
    const row = result.rows[0]!;
    expect(row.residual[2]).toBeGreaterThan(0); // edge over-represented
    expect(row.residual[0]).toBeLessThan(0); // center under-represented
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('is non-significant when observed matches area proportions', () => {
    // center 12.25%, mid 44%, edge 43.75% of 10000.
    const byDefect = new Map([['D001', { center: 1225, mid: 4400, edge: 4375 }]]);
    const result = regionChiSquare(byDefect, 0.35, 0.75);
    expect(result.chi2).toBeCloseTo(0, 1);
    expect(result.pValue).toBeGreaterThan(0.9);
  });

  it('marks a tiny sample underpowered', () => {
    const byDefect = new Map([['D004', { center: 1, mid: 1, edge: 1 }]]);
    const result = regionChiSquare(byDefect, 0.35, 0.75);
    expect(result.underpowered).toBe(true);
  });
});

describe('polarBins', () => {
  it('normalizes away the outer-ring area bias', () => {
    // Same count in an inner and an outer cell of the same sector: the outer
    // cell covers more area, so its density must be lower.
    const points = [
      { rRatio: 0.1, angleDeg: 10 }, { rRatio: 0.1, angleDeg: 10 },
      { rRatio: 0.95, angleDeg: 10 }, { rRatio: 0.95, angleDeg: 10 },
    ];
    const bins = polarBins(points, 24, 6);
    const inner = bins.find((b) => b.sector === 0 && b.ring === 0)!;
    const outer = bins.find((b) => b.sector === 0 && b.ring === 5)!;
    expect(inner.count).toBe(2);
    expect(outer.count).toBe(2);
    expect(inner.density).toBeGreaterThan(outer.density);
  });

  it('routes a 6 o clock point to sector 0', () => {
    // angle 0 is 6 o'clock in the frame convention.
    const bins = polarBins([{ rRatio: 0.5, angleDeg: 0 }], 24, 6);
    const hit = bins.find((b) => b.count > 0)!;
    expect(hit.sector).toBe(0);
  });

  it('clamps out-of-range radius into the last ring', () => {
    const bins = polarBins([{ rRatio: 1.5, angleDeg: 45 }], 24, 6);
    const hit = bins.find((b) => b.count > 0)!;
    expect(hit.ring).toBe(5);
  });
});
