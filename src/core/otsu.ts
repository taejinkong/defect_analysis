import type { Gray, Mask } from './types';
import { createMask } from './image';

/**
 * Otsu's method: the threshold maximizing between-class variance of the
 * 256-bin intensity histogram. Returns a value in [0, 255]; pixels with
 * intensity strictly greater than it are foreground.
 */
export function otsuThreshold(img: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;

  const total = img.data.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumBg = 0;
  let countBg = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    countBg += hist[t];
    if (countBg === 0) continue;
    const countFg = total - countBg;
    if (countFg === 0) break;

    sumBg += t * hist[t];
    const meanBg = sumBg / countBg;
    const meanFg = (sumAll - sumBg) / countFg;
    const diff = meanBg - meanFg;
    const variance = countBg * countFg * diff * diff;

    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

export interface MaskedOtsu {
  readonly threshold: number;
  /**
   * Distance between the two class means in pooled within-class standard
   * deviations. Otsu always returns *a* threshold, even for a single smooth
   * mode; this says whether splitting there means anything. Two genuinely
   * separate populations score well above 4; a vignetted but defect-free panel
   * scores around 2.
   */
  readonly separation: number;
  /** Share and mean intensity of pixels at or below the threshold. */
  readonly lowerFraction: number;
  readonly lowerMean: number;
  /** Share and mean intensity of pixels above the threshold. */
  readonly upperFraction: number;
  readonly upperMean: number;
}

/** Otsu's threshold over only the pixels inside `mask`, with a bimodality score. */
export function otsuThresholdMasked(img: Gray, mask: Mask): MaskedOtsu {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (mask.data[i] === 0) continue;
    hist[img.data[i]]++;
    total++;
  }
  if (total === 0) {
    return { threshold: 0, separation: 0, lowerFraction: 0, lowerMean: 0, upperFraction: 0, upperMean: 0 };
  }

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  const meanAll = sumAll / total;

  let totalVariance = 0;
  for (let t = 0; t < 256; t++) totalVariance += hist[t] * (t - meanAll) ** 2;
  totalVariance /= total;

  let sumBg = 0;
  let countBg = 0;
  let best = 0;
  let bestScore = -1;
  let bestDiff = 0;
  let bestLowerCount = 0;
  let bestLowerSum = 0;

  for (let t = 0; t < 256; t++) {
    countBg += hist[t];
    if (countBg === 0) continue;
    const countFg = total - countBg;
    if (countFg === 0) break;
    sumBg += t * hist[t];
    const diff = (sumAll - sumBg) / countFg - sumBg / countBg;
    const score = countBg * countFg * diff * diff;
    if (score > bestScore) {
      bestScore = score;
      best = t;
      bestDiff = diff;
      bestLowerCount = countBg;
      bestLowerSum = sumBg;
    }
  }

  // sigma_between^2 = bestScore / total^2, and within = total - between.
  const between = bestScore / (total * total);
  const within = Math.max(totalVariance - between, 1e-9);
  const upperCount = total - bestLowerCount;
  return {
    threshold: best,
    separation: Math.abs(bestDiff) / Math.sqrt(within),
    lowerFraction: bestLowerCount / total,
    lowerMean: bestLowerCount > 0 ? bestLowerSum / bestLowerCount : 0,
    upperFraction: upperCount / total,
    upperMean: upperCount > 0 ? (sumAll - bestLowerSum) / upperCount : 0,
  };
}

export function thresholdMask(img: Gray, threshold: number): Mask {
  const mask = createMask(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) mask.data[i] = img.data[i] > threshold ? 1 : 0;
  return mask;
}
