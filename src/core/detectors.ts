import type { Region } from './geometry';
import type { Pattern } from './types';

export type BlobKind =
  | 'dark-dot'
  | 'bright-dot'
  | 'bright-line-h'
  | 'bright-line-v'
  | 'dark-line-h'
  | 'dark-line-v';

export interface CandidateDetection {
  readonly kind: BlobKind;
  readonly x: number;
  readonly y: number;
  readonly areaPx: number;
  readonly rRatio: number;
  readonly angleDeg: number;
  readonly region: Region;
  readonly bbox: readonly [number, number, number, number];
  readonly aspect: number;
  readonly orientationDeg: number;
  readonly meanContrast: number;
  readonly peakContrast: number;
  readonly continuity?: number;
  readonly gapRatio?: number;
  readonly edgeContact?: boolean;
  readonly analysisScale?: 'normalized-component' | 'high-resolution-projection';
}

export interface Detection extends CandidateDetection {
  readonly detectorId: string;
  readonly detectorName: string;
  readonly detectorVersion: string;
}

export interface DetectionInput {
  readonly pattern: Pattern;
  readonly candidates: readonly CandidateDetection[];
}

export interface DefectDetector {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly supportedPatterns: readonly Pattern[];
  detect(input: DetectionInput): Detection[];
}

class KindDetector implements DefectDetector {
  readonly supportedPatterns = ['R', 'G', 'B', 'W'] as const;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly version: string,
    private readonly kinds: ReadonlySet<BlobKind>,
  ) {}

  detect(input: DetectionInput): Detection[] {
    if (!this.supportedPatterns.includes(input.pattern)) return [];
    return input.candidates
      .filter((candidate) => this.kinds.has(candidate.kind))
      .map((candidate) => ({
        ...candidate,
        detectorId: this.id,
        detectorName: this.name,
        detectorVersion: this.version,
      }));
  }
}

export const DETECTOR_VERSION = '3.0.0';

export const DEFECT_DETECTORS: readonly DefectDetector[] = [
  new KindDetector('dark-dot', 'Dark Dot Detector', DETECTOR_VERSION, new Set(['dark-dot'])),
  new KindDetector('bright-dot', 'Bright Dot Detector', DETECTOR_VERSION, new Set(['bright-dot'])),
  new KindDetector(
    'dark-line',
    'Dark Line Detector',
    DETECTOR_VERSION,
    new Set(['dark-line-h', 'dark-line-v']),
  ),
  new KindDetector(
    'bright-line',
    'Bright Line Detector',
    DETECTOR_VERSION,
    new Set(['bright-line-h', 'bright-line-v']),
  ),
];

export function runDefectDetectors(
  pattern: Pattern,
  candidates: readonly CandidateDetection[],
  detectors: readonly DefectDetector[] = DEFECT_DETECTORS,
): Detection[] {
  const input: DetectionInput = { pattern, candidates };
  return detectors.flatMap((detector) => detector.detect(input));
}
