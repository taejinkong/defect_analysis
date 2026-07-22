import type { PanelVerdict } from './verdict';
import type { KnnOutcome, Neighbor } from './knn';
import { DEFECT, DEFECT_NAME, type DefectId } from './settings';
import {
  REVIEW_REASON,
  agreementStatus,
  deriveReviewReasons,
  type AgreementStatus,
  type ReviewReason,
} from './review';

export interface FusedVerdict {
  readonly finalJudgementId: DefectId;
  readonly ruleVerdictId: DefectId;
  readonly knnVerdictId: DefectId | null;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly agreementStatus: AgreementStatus;
  readonly reviewReasons: ReviewReason[];
  readonly neighbors: Neighbor[];
  readonly decisionReason: string;
  /** Fail-safe export: unresolved or unvalidated cases can never become OK. */
  readonly sortingDisposition: 'OK' | 'NG' | 'HOLD';
}

/**
 * Combine the Rule verdict with the kNN outcome, per docs/matching_engine.md
 * section 6.
 *
 * The governing asymmetry: when Rule has named a concrete defect it wins, since
 * the dark-dot grade and the line geometry are deterministic and kNN has no
 * standing to overturn them. But when Rule says 양품, kNN is allowed to promote
 * a defect, because that is the only path by which a class Rule structurally
 * misses — 구동불량 above all — can ever be caught. Either disagreement flags
 * the panel for review, and the reviewer's correction becomes tomorrow's
 * training data.
 */
export function fuseVerdict(
  rule: PanelVerdict,
  knn: KnnOutcome,
  preprocessingReasons: readonly ReviewReason[] = [],
): FusedVerdict {
  const ruleId = rule.finalJudgementId;
  const knnId = knn.status === 'ok' ? knn.result.verdictId : null;
  const knnConf = knn.status === 'ok' ? knn.result.confidence : 0;
  // Only matched neighbors count. The near-misses of a no-match are described in
  // the decision text, but exposing them here would make the UI badge claim
  // "kNN neighbor: 1" for a panel that in fact matched nothing.
  const neighbors = knn.status === 'ok' ? knn.result.neighbors : [];

  const missingPenalty = 0.85 ** rule.missingPatterns.length;
  const ruleClause = `Rule: ${DEFECT_NAME[ruleId]}`;
  const knnClause = knnClauseText(knn);
  const qualityIssue = (rule.qualityWarnings?.length ?? 0) > 0;
  const baseReviewReasons = deriveReviewReasons({
    preprocessingReasons,
    ruleId,
    knnId,
    confidence: 1,
    missingPatterns: rule.missingPatterns.length,
    multiple: ruleId === DEFECT.MULTI,
    edgeAdjacent: rule.labeled.some((item) => item.counted && item.rRatio >= 0.95),
    drivingAbnormality: rule.drivingFlag,
    patternOnlyDefect: rule.patternOnlyDefect,
  });
  if (rule.underexposedReview) baseReviewReasons.push(REVIEW_REASON.UNDEREXPOSED_REVIEW);
  if (qualityIssue) baseReviewReasons.push(REVIEW_REASON.OUT_OF_VALIDATED_RANGE);
  const withQuality = (reason: string): string =>
    qualityIssue ? `${reason} / 품질 경고: ${rule.qualityWarnings!.join(' · ')}` : reason;

  // Rule found a real defect and kNN agrees: strongest possible call.
  if (knnId !== null && knnId === ruleId && ruleId !== DEFECT.GOOD) {
    return build(ruleId, ruleId, knnId, (0.9 + 0.1 * knnConf) * missingPenalty, qualityIssue, neighbors,
      withQuality(`${ruleClause} / ${knnClause} → 일치`), baseReviewReasons);
  }

  // Rule found a real defect but kNN is silent or unavailable: Rule stands.
  if (ruleId !== DEFECT.GOOD && knnId === null) {
    return build(ruleId, ruleId, knnId, 0.6 * missingPenalty, qualityIssue, neighbors,
      withQuality(`${ruleClause} / ${knnClause}`), baseReviewReasons);
  }

  // Rule found a real defect and kNN disagrees: Rule wins, but flag it.
  if (ruleId !== DEFECT.GOOD && knnId !== null && knnId !== ruleId) {
    return build(ruleId, ruleId, knnId, 0.45 * missingPenalty, true, neighbors,
      withQuality(`${ruleClause} / ${knnClause} → 불일치, Rule 우선 · 검수 필요`), baseReviewReasons);
  }

  // Rule says 양품 and kNN names a defect: take kNN, and flag it. This is how a
  // Rule-invisible class (구동불량) surfaces at all.
  if (ruleId === DEFECT.GOOD && knnId !== null && knnId !== DEFECT.GOOD) {
    return build(knnId, ruleId, knnId, 0.5 * knnConf * missingPenalty, true, neighbors,
      withQuality(`${ruleClause} / ${knnClause} → kNN 채택 · 검수 필요`), baseReviewReasons);
  }

  // Both agree it is good, or kNN is unavailable and Rule says good.
  return build(ruleId, ruleId, knnId, (knnId === DEFECT.GOOD ? 0.8 : 0.6) * missingPenalty, qualityIssue, neighbors,
    withQuality(`${ruleClause} / ${knnClause}`), baseReviewReasons);
}

function build(
  finalJudgementId: DefectId,
  ruleVerdictId: DefectId,
  knnVerdictId: DefectId | null,
  confidence: number,
  needsReview: boolean,
  neighbors: Neighbor[],
  decisionReason: string,
  baseReviewReasons: readonly ReviewReason[],
): FusedVerdict {
  const reviewReasons = new Set(baseReviewReasons);
  if (confidence < 0.6) reviewReasons.add(REVIEW_REASON.LOW_CONFIDENCE);
  const requiresReview = needsReview || reviewReasons.size > 0;
  return {
    finalJudgementId,
    ruleVerdictId,
    knnVerdictId,
    confidence: Math.max(0, Math.min(1, confidence)),
    needsReview: requiresReview,
    agreementStatus: agreementStatus(ruleVerdictId, knnVerdictId),
    reviewReasons: [...reviewReasons],
    neighbors,
    decisionReason,
    sortingDisposition: requiresReview ? 'HOLD' : finalJudgementId === DEFECT.GOOD ? 'OK' : 'NG',
  };
}

function knnClauseText(knn: KnnOutcome): string {
  switch (knn.status) {
    case 'insufficient-data':
      return `kNN: 학습 부족 (${knn.candidateCount}개, 비활성)`;
    case 'no-match': {
      const best = knn.neighbors[0];
      return best ? `kNN: 유사 패널 없음 (최고 ${best.similarity.toFixed(2)})` : 'kNN: 유사 패널 없음';
    }
    case 'ok': {
      const r = knn.result;
      return `kNN: ${DEFECT_NAME[r.verdictId]} (${r.neighbors.length}표, 신뢰 ${r.confidence.toFixed(2)})`;
    }
  }
}
