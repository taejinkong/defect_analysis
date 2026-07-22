import { describe, expect, it } from 'vitest';
import { binaryValidationMetrics, groupedValidationSplit, separateRealAndSynthetic } from './validation';

const samples = [
  { panelId: 1, lotId: 'A', equipmentId: 'E1', capturedAt: '2026-01-01', synthetic: false, predicted: 'D000', actual: 'D000' },
  { panelId: 2, lotId: 'A', equipmentId: 'E1', capturedAt: '2026-01-02', synthetic: false, predicted: 'D000', actual: 'D004' },
  { panelId: 3, lotId: 'B', equipmentId: 'E2', capturedAt: '2026-02-01', synthetic: true, predicted: 'D004', actual: 'D000' },
  { panelId: 4, lotId: 'C', equipmentId: 'E2', capturedAt: '2026-03-01', synthetic: false, predicted: 'D004', actual: 'D004' },
] as const;

describe('validation protocol', () => {
  it('reports escape and false-reject rates separately', () => {
    const result = binaryValidationMetrics(samples);
    expect(result).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1, sampleCount: 4 });
    expect(result.falseAcceptRate).toBe(0.5);
    expect(result.falseRejectRate).toBe(0.5);
    expect(result.accuracy95).not.toBeNull();
  });

  it('never splits a Lot across train and test', () => {
    const split = groupedValidationSplit(samples, 'lot', 0.5);
    const trainLots = new Set(split.train.map((sample) => sample.lotId));
    expect(split.test.every((sample) => !trainLots.has(sample.lotId))).toBe(true);
    expect(split.leakage).toEqual([]);
  });

  it('separates synthetic evidence from real evidence', () => {
    const split = separateRealAndSynthetic(samples);
    expect(split.real).toHaveLength(3);
    expect(split.synthetic).toHaveLength(1);
  });
});
