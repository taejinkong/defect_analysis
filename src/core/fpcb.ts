import type { Circle, Gray } from './types';
import { sampleGray } from './image';
import { angleFromOffset, normalizeAngle, offsetFromAngle } from './geometry';

export interface FpcbEstimate {
  /** Where the tab was found, in the clock convention of the source image. */
  readonly tabAngleDeg: number;
  /** Clockwise rotation that moves the tab to 6 o'clock. */
  readonly rotationDeg: number;
  /**
   * How far the winning sector stands out from the ring's typical brightness,
   * in robust sigmas. Below ~3 the estimate is not trustworthy.
   */
  readonly strength: number;
  readonly profile: Float64Array;
}

const SECTORS = 180; // 2 degrees per bin
const RING_INNER = 1.02;
const RING_OUTER = 1.3;
const RADIAL_STEPS = 12;

/**
 * Estimate the FPCB/bending tab direction by sweeping the annulus just outside
 * the active circle and finding the angular sector whose brightness departs
 * most from the ring's baseline.
 *
 * The tab may be brighter or darker than the background depending on capture
 * setup, so this scores |deviation| rather than assuming a sign.
 *
 * This is a suggestion only. The user confirms it; see docs/matching_engine.md
 * section 2.2 for why an unverified estimate must not reach the dashboard.
 */
export function estimateFpcb(gray: Gray, circle: Circle): FpcbEstimate {
  const profile = new Float64Array(SECTORS);
  const counts = new Int32Array(SECTORS);

  for (let s = 0; s < SECTORS; s++) {
    const angle = (s + 0.5) * (360 / SECTORS);
    const { dx, dy } = offsetFromAngle(angle);
    for (let k = 0; k < RADIAL_STEPS; k++) {
      const t = RING_INNER + ((RING_OUTER - RING_INNER) * k) / (RADIAL_STEPS - 1);
      const x = circle.cx + dx * circle.r * t;
      const y = circle.cy + dy * circle.r * t;
      if (x < 0 || y < 0 || x > gray.width - 1 || y > gray.height - 1) continue;
      profile[s] += sampleGray(gray, x, y);
      counts[s]++;
    }
    profile[s] = counts[s] > 0 ? profile[s] / counts[s] : Number.NaN;
  }

  const valid = Array.from(profile).filter((v) => Number.isFinite(v));
  if (valid.length < SECTORS / 2) {
    return { tabAngleDeg: 0, rotationDeg: 0, strength: 0, profile };
  }

  const med = median(valid);
  const mad = median(valid.map((v) => Math.abs(v - med)));
  // 1.4826 rescales MAD to a standard-deviation estimate for normal data.
  const sigma = Math.max(mad * 1.4826, 1e-6);

  let bestSector = 0;
  let bestScore = -1;
  for (let s = 0; s < SECTORS; s++) {
    if (!Number.isFinite(profile[s])) continue;
    const score = Math.abs(profile[s] - med);
    if (score > bestScore) {
      bestScore = score;
      bestSector = s;
    }
  }

  const tabAngleDeg = refinePeak(profile, bestSector, med);

  return {
    tabAngleDeg,
    rotationDeg: normalizeAngle(-tabAngleDeg),
    strength: bestScore / sigma,
    profile,
  };
}

/**
 * Center-of-mass of the contiguous run of sectors around the peak that stay
 * above half its deviation. A single argmax bin quantizes to 2 degrees; the tab
 * spans several bins, so its centroid is markedly more stable.
 */
function refinePeak(profile: Float64Array, peak: number, baseline: number): number {
  const peakDev = Math.abs(profile[peak] - baseline);
  const half = peakDev / 2;
  const sectorWidth = 360 / SECTORS;

  const inRun = (s: number): boolean => {
    const v = profile[(s + SECTORS) % SECTORS];
    return Number.isFinite(v) && Math.abs(v - baseline) >= half;
  };

  let lo = 0;
  while (lo < SECTORS / 2 && inRun(peak - lo - 1)) lo++;
  let hi = 0;
  while (hi < SECTORS / 2 && inRun(peak + hi + 1)) hi++;

  // Weighted mean of offsets from the peak, avoiding the 0/360 wrap entirely.
  let wSum = 0;
  let offsetSum = 0;
  for (let o = -lo; o <= hi; o++) {
    const w = Math.abs(profile[(peak + o + SECTORS) % SECTORS] - baseline);
    wSum += w;
    offsetSum += o * w;
  }
  const centroid = peak + (wSum > 0 ? offsetSum / wSum : 0);
  return normalizeAngle((centroid + 0.5) * sectorWidth);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Angle of a point in the source image, expressed in the clock convention. */
export function pointAngle(circle: Circle, x: number, y: number): number {
  return angleFromOffset(x - circle.cx, y - circle.cy);
}
