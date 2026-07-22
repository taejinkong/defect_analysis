import type { DefectId } from './settings';

export type PreprocessingStatus = 'PASS' | 'REVIEW' | 'FAIL';

export const REVIEW_REASON = {
  PREPROCESSING_FAILED: 'PREPROCESSING_FAILED',
  CAPTURE_PROFILE_UNVALIDATED: 'CAPTURE_PROFILE_UNVALIDATED',
  GOLDEN_REFERENCE_MISSING: 'GOLDEN_REFERENCE_MISSING',
  UNDEREXPOSED_REVIEW: 'UNDEREXPOSED_REVIEW',
  ACTIVE_AREA_LOW_CONFIDENCE: 'ACTIVE_AREA_LOW_CONFIDENCE',
  FPCB_ALIGNMENT_LOW_CONFIDENCE: 'FPCB_ALIGNMENT_LOW_CONFIDENCE',
  PATTERN_MISSING: 'PATTERN_MISSING',
  RULE_KNN_CONFLICT: 'RULE_KNN_CONFLICT',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  MULTIPLE_DEFECTS: 'MULTIPLE_DEFECTS',
  EDGE_ADJACENT_DEFECT: 'EDGE_ADJACENT_DEFECT',
  OUT_OF_VALIDATED_RANGE: 'OUT_OF_VALIDATED_RANGE',
  DRIVING_ABNORMALITY_REVIEW: 'DRIVING_ABNORMALITY_REVIEW',
  MANUAL_REQUEST: 'MANUAL_REQUEST',
  PATTERN_ONLY_DEFECT: 'PATTERN_ONLY_DEFECT',
} as const;

export type ReviewReason = (typeof REVIEW_REASON)[keyof typeof REVIEW_REASON];
export type AgreementStatus = 'MATCH' | 'PARTIAL_MATCH' | 'CONFLICT' | 'NOT_AVAILABLE';

export const REVIEW_REASON_NAME: Record<ReviewReason, string> = {
  PREPROCESSING_FAILED: '전처리 실패',
  CAPTURE_PROFILE_UNVALIDATED: '촬영 프로파일 미검증',
  GOLDEN_REFERENCE_MISSING: 'Golden 기준 미검증/불일치',
  UNDEREXPOSED_REVIEW: '저휘도 촬영과 미점등 구분 필요',
  ACTIVE_AREA_LOW_CONFIDENCE: 'Active Area 신뢰도 낮음',
  FPCB_ALIGNMENT_LOW_CONFIDENCE: 'FPCB 정렬 신뢰도 낮음',
  PATTERN_MISSING: 'R/G/B/W 패턴 결손',
  RULE_KNN_CONFLICT: 'Rule·kNN 판정 불일치',
  LOW_CONFIDENCE: '자동 판정 신뢰도 낮음',
  MULTIPLE_DEFECTS: '복수불량',
  EDGE_ADJACENT_DEFECT: 'Active Area 경계 인접 불량',
  OUT_OF_VALIDATED_RANGE: '검증 범위 밖의 이미지 품질',
  DRIVING_ABNORMALITY_REVIEW: '구동불량 의심 검토',
  MANUAL_REQUEST: '수동 검수 요청',
  PATTERN_ONLY_DEFECT: '단일 패턴 불량 후보',
};

export interface ReviewReasonInput {
  readonly preprocessingReasons?: readonly ReviewReason[];
  readonly ruleId: DefectId;
  readonly knnId: DefectId | null;
  readonly confidence: number;
  readonly missingPatterns: number;
  readonly multiple: boolean;
  readonly edgeAdjacent: boolean;
  readonly drivingAbnormality: boolean;
  readonly patternOnlyDefect?: boolean;
}

export function agreementStatus(ruleId: DefectId, knnId: DefectId | null): AgreementStatus {
  if (knnId === null) return 'NOT_AVAILABLE';
  if (ruleId === knnId) return 'MATCH';
  return ruleId === 'D000' || knnId === 'D000' ? 'PARTIAL_MATCH' : 'CONFLICT';
}

export function deriveReviewReasons(input: ReviewReasonInput): ReviewReason[] {
  const reasons = new Set<ReviewReason>(input.preprocessingReasons ?? []);
  const agreement = agreementStatus(input.ruleId, input.knnId);
  if (input.missingPatterns > 0) reasons.add(REVIEW_REASON.PATTERN_MISSING);
  if (agreement === 'CONFLICT' || agreement === 'PARTIAL_MATCH') reasons.add(REVIEW_REASON.RULE_KNN_CONFLICT);
  if (input.confidence < 0.6) reasons.add(REVIEW_REASON.LOW_CONFIDENCE);
  if (input.multiple) reasons.add(REVIEW_REASON.MULTIPLE_DEFECTS);
  if (input.edgeAdjacent) reasons.add(REVIEW_REASON.EDGE_ADJACENT_DEFECT);
  if (input.drivingAbnormality) reasons.add(REVIEW_REASON.DRIVING_ABNORMALITY_REVIEW);
  if (input.patternOnlyDefect) reasons.add(REVIEW_REASON.PATTERN_ONLY_DEFECT);
  return [...reasons];
}
