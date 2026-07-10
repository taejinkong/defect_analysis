import type { PanelVerdict } from './verdict';
import type { KnnOutcome, Neighbor } from './knn';
import { DEFECT, DEFECT_NAME, type DefectId } from './settings';

export interface FusedVerdict {
  readonly finalJudgementId: DefectId;
  readonly ruleVerdictId: DefectId;
  readonly knnVerdictId: DefectId | null;
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly neighbors: Neighbor[];
  readonly decisionReason: string;
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
export function fuseVerdict(rule: PanelVerdict, knn: KnnOutcome): FusedVerdict {
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

  // Rule found a real defect and kNN agrees: strongest possible call.
  if (knnId !== null && knnId === ruleId && ruleId !== DEFECT.GOOD) {
    return build(ruleId, ruleId, knnId, (0.9 + 0.1 * knnConf) * missingPenalty, false, neighbors,
      `${ruleClause} / ${knnClause} → 일치`);
  }

  // Rule found a real defect but kNN is silent or unavailable: Rule stands.
  if (ruleId !== DEFECT.GOOD && knnId === null) {
    return build(ruleId, ruleId, knnId, 0.6 * missingPenalty, false, neighbors,
      `${ruleClause} / ${knnClause}`);
  }

  // Rule found a real defect and kNN disagrees: Rule wins, but flag it.
  if (ruleId !== DEFECT.GOOD && knnId !== null && knnId !== ruleId) {
    return build(ruleId, ruleId, knnId, 0.45 * missingPenalty, true, neighbors,
      `${ruleClause} / ${knnClause} → 불일치, Rule 우선 · 검수 필요`);
  }

  // Rule says 양품 and kNN names a defect: take kNN, and flag it. This is how a
  // Rule-invisible class (구동불량) surfaces at all.
  if (ruleId === DEFECT.GOOD && knnId !== null && knnId !== DEFECT.GOOD) {
    return build(knnId, ruleId, knnId, 0.5 * knnConf * missingPenalty, true, neighbors,
      `${ruleClause} / ${knnClause} → kNN 채택 · 검수 필요`);
  }

  // Both agree it is good, or kNN is unavailable and Rule says good.
  return build(ruleId, ruleId, knnId, (knnId === DEFECT.GOOD ? 0.8 : 0.6) * missingPenalty, false, neighbors,
    `${ruleClause} / ${knnClause}`);
}

function build(
  finalJudgementId: DefectId,
  ruleVerdictId: DefectId,
  knnVerdictId: DefectId | null,
  confidence: number,
  needsReview: boolean,
  neighbors: Neighbor[],
  decisionReason: string,
): FusedVerdict {
  return {
    finalJudgementId,
    ruleVerdictId,
    knnVerdictId,
    confidence: Math.max(0, Math.min(1, confidence)),
    needsReview,
    neighbors,
    decisionReason,
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
