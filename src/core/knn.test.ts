import { describe, expect, it } from 'vitest';
import { knnSearch, type SearchEntry } from './knn';
import { DEFAULT_SETTINGS, type DefectId } from './settings';

function entry(panelId: number, defectId: DefectId, values: number[]): SearchEntry {
  const vector = new Float32Array(values);
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return { panelId, labelDefectId: defectId, vector };
}

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

const settings = { ...DEFAULT_SETTINGS, 'knn.min_train_panels': 3, 'knn.k': 3, 'knn.min_similarity': 0.5 };

describe('knnSearch', () => {
  it('reports insufficient data below the training threshold', () => {
    const result = knnSearch(unit([1, 0, 0]), [entry(1, 'D001', [1, 0, 0])], settings);
    expect(result.status).toBe('insufficient-data');
    if (result.status === 'insufficient-data') expect(result.candidateCount).toBe(1);
  });

  it('returns the nearest label by weighted vote', () => {
    const candidates = [
      entry(1, 'D004', [1, 0, 0]),
      entry(2, 'D004', [0.9, 0.1, 0]),
      entry(3, 'D001', [0, 1, 0]),
    ];
    const result = knnSearch(unit([1, 0.05, 0]), candidates, settings);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.result.verdictId).toBe('D004');
    expect(result.result.neighbors.length).toBeGreaterThanOrEqual(1);
  });

  it('lets a close majority outvote a single very-near neighbor', () => {
    // One D001 at 0.95, two D004 at 0.8 each: summed weight 1.6 beats 0.95.
    const candidates = [
      entry(1, 'D001', [1, 0, 0]),
      entry(2, 'D004', [0.8, 0.6, 0]),
      entry(3, 'D004', [0.8, 0.6, 0.01]),
    ];
    const query = unit([0.85, 0.4, 0]);
    const result = knnSearch(query, candidates, settings);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.result.verdictId).toBe('D004');
  });

  it('returns no-match when nothing clears the similarity floor', () => {
    const candidates = [
      entry(1, 'D001', [1, 0, 0]),
      entry(2, 'D004', [0, 1, 0]),
      entry(3, 'D005', [0, 0, 1]),
    ];
    // Orthogonal to everything.
    const result = knnSearch(unit([0.577, 0.577, 0.577]), candidates, {
      ...settings,
      'knn.min_similarity': 0.9,
    });
    expect(result.status).toBe('no-match');
    if (result.status === 'no-match') expect(result.neighbors.length).toBeGreaterThan(0);
  });

  it('caps neighbors at k', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => entry(i, 'D004', [1, i / 100, 0]));
    const result = knnSearch(unit([1, 0, 0]), candidates, settings);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.result.neighbors.length).toBeLessThanOrEqual(settings['knn.k']);
  });

  it('confidence is the winning vote share', () => {
    const candidates = [
      entry(1, 'D004', [1, 0, 0]),
      entry(2, 'D004', [1, 0, 0]),
      entry(3, 'D004', [1, 0, 0]),
    ];
    const result = knnSearch(unit([1, 0, 0]), candidates, settings);
    if (result.status !== 'ok') throw new Error('expected ok');
    // Unanimous: full confidence.
    expect(result.result.confidence).toBeCloseTo(1, 5);
  });
});
