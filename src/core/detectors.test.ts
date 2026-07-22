import { describe, expect, it } from 'vitest';
import { DEFECT_DETECTORS, DETECTOR_VERSION, runDefectDetectors, type CandidateDetection } from './detectors';

const candidate = (kind: CandidateDetection['kind']): CandidateDetection => ({
  kind,
  x: 256,
  y: 256,
  areaPx: 20,
  rRatio: 0,
  angleDeg: 0,
  region: 'center',
  bbox: [250, 250, 262, 262],
  aspect: 10,
  orientationDeg: 0,
  meanContrast: 40,
  peakContrast: 60,
});

describe('modular defect detectors', () => {
  it('routes each candidate to exactly one named/versioned detector', () => {
    const kinds: CandidateDetection['kind'][] = [
      'dark-dot',
      'bright-dot',
      'dark-line-h',
      'dark-line-v',
      'bright-line-h',
      'bright-line-v',
    ];
    const detections = runDefectDetectors('W', kinds.map(candidate));
    expect(detections.map((item) => item.kind).sort()).toEqual([...kinds].sort());
    expect(detections.every((item) => item.detectorVersion === DETECTOR_VERSION)).toBe(true);
    expect(new Set(detections.map((item) => item.detectorId))).toEqual(
      new Set(['dark-dot', 'bright-dot', 'dark-line', 'bright-line']),
    );
  });

  it('exposes the requested detector contract metadata', () => {
    for (const detector of DEFECT_DETECTORS) {
      expect(detector.id).not.toBe('');
      expect(detector.name).not.toBe('');
      expect(detector.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(detector.supportedPatterns).toEqual(['R', 'G', 'B', 'W']);
    }
  });
});
