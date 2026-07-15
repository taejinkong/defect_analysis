import type { Circle, Rgba } from './types';
import { boxBlur, toIntensity } from './image';
import { otsuThreshold, thresholdMask } from './otsu';
import { boundaryPoints, fillHoles, largestComponent } from './components';
import { fitCircleRobust, refineCircleEdge } from './circle';
import { estimateFpcb, type FpcbEstimate } from './fpcb';
import { normalizeFrame, type NormalizedFrame } from './normalize';

export interface DetectOptions {
  /** Reject a component covering less than this fraction of the image. */
  readonly minAreaFraction: number;
  /** Reject a fit whose RMS residual exceeds this fraction of the radius. */
  readonly maxResidualFraction: number;
  /** Below this robust-sigma score the FPCB estimate is reported as unreliable. */
  readonly minFpcbStrength: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minAreaFraction: 0.05,
  maxResidualFraction: 0.05,
  minFpcbStrength: 3,
};

export type DetectFailure =
  | 'no-foreground'
  | 'component-too-small'
  | 'fit-failed'
  | 'not-circular';

export interface DetectSuccess {
  readonly ok: true;
  readonly circle: Circle;
  readonly rmsResidual: number;
  readonly areaFraction: number;
  readonly fpcb: FpcbEstimate;
  /** True when the FPCB estimate cleared `minFpcbStrength`. */
  readonly fpcbReliable: boolean;
}

export interface DetectError {
  readonly ok: false;
  readonly reason: DetectFailure;
  readonly message: string;
  /** Present when a circle was fit but rejected, so the UI can seed manual entry. */
  readonly circle?: Circle;
}

export type DetectResult = DetectSuccess | DetectError;

/**
 * Locate the active display circle and suggest an FPCB rotation.
 *
 * A lit circular display is a single bright convex blob on a dark background,
 * so Otsu plus the largest connected component plus a least-squares circle fit
 * is both simpler and faster than a Hough transform. See docs/matching_engine.md
 * section 2.1.
 */
export function detectActiveCircle(src: Rgba, opts: DetectOptions = DEFAULT_DETECT_OPTIONS): DetectResult {
  // Max-channel, not luma: see toIntensity. The FPCB tab outshines a blue panel
  // under Rec. 709 weights, and Otsu would then segment the tab.
  const intensity = toIntensity(src);
  const blurred = boxBlur(intensity, 1, 2);

  const threshold = otsuThreshold(blurred);
  const fg = thresholdMask(blurred, threshold);

  const component = largestComponent(fg);
  if (!component) {
    return { ok: false, reason: 'no-foreground', message: 'Otsu 이진화 결과 전경 픽셀이 없습니다.' };
  }

  const areaFraction = component.area / (src.width * src.height);
  if (areaFraction < opts.minAreaFraction) {
    return {
      ok: false,
      reason: 'component-too-small',
      message: `최대 연결 성분이 이미지의 ${(areaFraction * 100).toFixed(1)}% 로, 기준 ${(
        opts.minAreaFraction * 100
      ).toFixed(0)}% 미만입니다.`,
    };
  }

  // Fill first: a dark defect inside the panel leaves a hole whose rim would
  // otherwise be treated as boundary. Image-border pixels are excluded from the
  // boundary: a cropped capture clips the circle at the crop rectangle, and
  // those straight runs would drag the fit off the true rim.
  const solid = fillHoles(component.mask);
  const coarse = fitCircleRobust(boundaryPoints(solid, true));
  if (!coarse) {
    return { ok: false, reason: 'fit-failed', message: '경계점이 부족하거나 일직선이라 원을 피팅할 수 없습니다.' };
  }

  // The Otsu boundary sits wherever the halo crosses the threshold, so on real
  // captures with bloom it overestimates the radius. Snap to the strongest
  // radial intensity drop, which stays on the physical rim; fall back to the
  // coarse fit when the gradient evidence is too thin (e.g. tight crops).
  const fit = refineCircleEdge(blurred, coarse) ?? coarse;

  const circle: Circle = { cx: fit.cx, cy: fit.cy, r: fit.r };

  if (fit.rmsResidual > fit.r * opts.maxResidualFraction) {
    return {
      ok: false,
      reason: 'not-circular',
      message: `원 피팅 잔차 RMS가 반지름의 ${((fit.rmsResidual / fit.r) * 100).toFixed(1)}% 로 너무 큽니다. 원형이 아닐 수 있습니다.`,
      circle,
    };
  }

  const fpcb = estimateFpcb(intensity, circle);

  return {
    ok: true,
    circle,
    rmsResidual: fit.rmsResidual,
    areaFraction,
    fpcb,
    fpcbReliable: fpcb.strength >= opts.minFpcbStrength,
  };
}

/**
 * Full stage-1 pipeline for one image: detect, then resample into the
 * normalized frame using the confirmed rotation.
 *
 * `rotationDeg` defaults to the automatic estimate, which callers must treat as
 * a suggestion pending user confirmation.
 */
export function preprocess(
  src: Rgba,
  opts: DetectOptions = DEFAULT_DETECT_OPTIONS,
  rotationDeg?: number,
): { detect: DetectResult; frame: NormalizedFrame | null } {
  const detect = detectActiveCircle(src, opts);
  if (!detect.ok) return { detect, frame: null };

  const rotation = rotationDeg ?? detect.fpcb.rotationDeg;
  return { detect, frame: normalizeFrame(src, detect.circle, rotation) };
}
