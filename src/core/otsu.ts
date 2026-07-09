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

export function thresholdMask(img: Gray, threshold: number): Mask {
  const mask = createMask(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) mask.data[i] = img.data[i] > threshold ? 1 : 0;
  return mask;
}
