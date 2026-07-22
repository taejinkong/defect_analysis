import type { DefectId } from './settings';

export interface ValidationSample {
  readonly panelId: number;
  readonly lotId: string;
  readonly equipmentId: string;
  readonly capturedAt: string;
  readonly synthetic: boolean;
  readonly predicted: DefectId;
  readonly actual: DefectId;
}

export interface BinaryValidationMetrics {
  readonly sampleCount: number;
  readonly tp: number;
  readonly fp: number;
  readonly tn: number;
  readonly fn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  readonly falseAcceptRate: number | null;
  readonly falseRejectRate: number | null;
  readonly accuracy95: readonly [number, number] | null;
}

const GOOD = 'D000';

export function binaryValidationMetrics(samples: readonly ValidationSample[]): BinaryValidationMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const sample of samples) {
    const predictedDefect = sample.predicted !== GOOD;
    const actualDefect = sample.actual !== GOOD;
    if (predictedDefect && actualDefect) tp++;
    else if (predictedDefect) fp++;
    else if (actualDefect) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  const n = samples.length;
  return {
    sampleCount: n,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1,
    /** Defective panels incorrectly released as good. */
    falseAcceptRate: ratio(fn, tp + fn),
    /** Good panels incorrectly rejected as defective. */
    falseRejectRate: ratio(fp, tn + fp),
    accuracy95: n > 0 ? wilsonInterval(tp + tn, n) : null,
  };
}

export interface GroupedValidationSplit {
  readonly train: ValidationSample[];
  readonly test: ValidationSample[];
  readonly leakage: string[];
}

/**
 * Deterministic grouped split. Images from one panel/group never cross the
 * boundary, preventing the near-duplicate leakage of a random image split.
 */
export function groupedValidationSplit(
  samples: readonly ValidationSample[],
  groupBy: 'panel' | 'lot' | 'equipment' | 'month' = 'lot',
  testFraction = 0.2,
): GroupedValidationSplit {
  const groups = new Map<string, ValidationSample[]>();
  for (const sample of samples) {
    const key = groupKey(sample, groupBy);
    const values = groups.get(key) ?? [];
    values.push(sample);
    groups.set(key, values);
  }
  const train: ValidationSample[] = [];
  const test: ValidationSample[] = [];
  for (const [key, values] of groups) {
    const bucket = hash01(key) < Math.max(0, Math.min(1, testFraction)) ? test : train;
    bucket.push(...values);
  }
  const trainPanels = new Set(train.map((sample) => sample.panelId));
  const leakage = [...new Set(test.filter((sample) => trainPanels.has(sample.panelId)).map((sample) => String(sample.panelId)))];
  return { train, test, leakage };
}

export function separateRealAndSynthetic(samples: readonly ValidationSample[]): {
  readonly real: ValidationSample[];
  readonly synthetic: ValidationSample[];
} {
  return {
    real: samples.filter((sample) => !sample.synthetic),
    synthetic: samples.filter((sample) => sample.synthetic),
  };
}

function groupKey(sample: ValidationSample, by: 'panel' | 'lot' | 'equipment' | 'month'): string {
  if (by === 'panel') return String(sample.panelId);
  if (by === 'lot') return sample.lotId || `(panel:${sample.panelId})`;
  if (by === 'equipment') return sample.equipmentId || `(panel:${sample.panelId})`;
  return sample.capturedAt.slice(0, 7) || `(panel:${sample.panelId})`;
}

function hash01(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Wilson score interval for a binomial proportion. */
function wilsonInterval(successes: number, total: number): readonly [number, number] {
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
