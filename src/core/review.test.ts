import { describe, expect, it } from 'vitest';
import { REVIEW_REASON, agreementStatus, deriveReviewReasons } from './review';

describe('review reason model', () => {
  it('classifies Rule/kNN agreement explicitly', () => {
    expect(agreementStatus('D004', 'D004')).toBe('MATCH');
    expect(agreementStatus('D004', null)).toBe('NOT_AVAILABLE');
    expect(agreementStatus('D000', 'D004')).toBe('PARTIAL_MATCH');
    expect(agreementStatus('D004', 'D005')).toBe('CONFLICT');
  });

  it('retains every applicable reason without duplicates', () => {
    const reasons = deriveReviewReasons({
      preprocessingReasons: [REVIEW_REASON.OUT_OF_VALIDATED_RANGE],
      ruleId: 'D011',
      knnId: 'D004',
      confidence: 0.4,
      missingPatterns: 1,
      multiple: true,
      edgeAdjacent: true,
      drivingAbnormality: true,
    });
    expect(reasons).toEqual(expect.arrayContaining([
      REVIEW_REASON.OUT_OF_VALIDATED_RANGE,
      REVIEW_REASON.PATTERN_MISSING,
      REVIEW_REASON.RULE_KNN_CONFLICT,
      REVIEW_REASON.LOW_CONFIDENCE,
      REVIEW_REASON.MULTIPLE_DEFECTS,
      REVIEW_REASON.EDGE_ADJACENT_DEFECT,
      REVIEW_REASON.DRIVING_ABNORMALITY_REVIEW,
    ]));
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
