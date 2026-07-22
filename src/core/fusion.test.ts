import { describe, expect, it } from 'vitest';
import { fuseVerdict } from './fusion';
import type { PanelVerdict } from './verdict';
import type { KnnOutcome, Neighbor } from './knn';
import { DEFECT, type DefectId } from './settings';

function rule(finalJudgementId: DefectId, missing: number = 0): PanelVerdict {
  return {
    finalJudgementId,
    primaryDefectId: finalJudgementId,
    detectedDefectIds: finalJudgementId === DEFECT.GOOD ? [] : [finalJudgementId],
    darkAreaPct: 0,
    confidence: 0.6,
    decisionReason: '',
    labeled: [],
    suppressed: [],
    drivingFlag: false,
    missingPatterns: Array.from({ length: missing }, () => 'B' as const),
    qualityWarnings: [],
    patternOnlyDefect: false,
    underexposedReview: false,
  };
}

function knnOk(verdictId: DefectId, confidence = 1): KnnOutcome {
  const neighbors: Neighbor[] = [{ panelId: 1, defectId: verdictId, similarity: 0.9 }];
  return { status: 'ok', result: { verdictId, confidence, neighbors } };
}

const knnInsufficient: KnnOutcome = { status: 'insufficient-data', candidateCount: 2 };
const knnNoMatch: KnnOutcome = { status: 'no-match', neighbors: [{ panelId: 9, defectId: 'D001', similarity: 0.4 }] };

describe('fuseVerdict', () => {
  it('agrees confidently when Rule and kNN concur on a defect', () => {
    const fused = fuseVerdict(rule(DEFECT.BRIGHT_DOT), knnOk(DEFECT.BRIGHT_DOT, 1));
    expect(fused.finalJudgementId).toBe(DEFECT.BRIGHT_DOT);
    expect(fused.needsReview).toBe(false);
    expect(fused.confidence).toBeGreaterThan(0.9);
    expect(fused.sortingDisposition).toBe('NG');
  });

  it('keeps the Rule defect when kNN is unavailable', () => {
    const fused = fuseVerdict(rule(DEFECT.DARK_DOT_MEDIUM), knnInsufficient);
    expect(fused.finalJudgementId).toBe(DEFECT.DARK_DOT_MEDIUM);
    expect(fused.needsReview).toBe(false);
    expect(fused.sortingDisposition).toBe('NG');
    expect(fused.confidence).toBeCloseTo(0.6, 5);
    expect(fused.decisionReason).toContain('학습 부족');
  });

  it('lets Rule win a disagreement but flags it', () => {
    const fused = fuseVerdict(rule(DEFECT.DARK_DOT_LARGE), knnOk(DEFECT.BRIGHT_DOT));
    // Area grade is deterministic; kNN cannot overturn it.
    expect(fused.finalJudgementId).toBe(DEFECT.DARK_DOT_LARGE);
    expect(fused.needsReview).toBe(true);
    expect(fused.confidence).toBeLessThan(0.6);
  });

  it('promotes a kNN defect when Rule says good', () => {
    // The only path by which 구동불량 surfaces at all.
    const fused = fuseVerdict(rule(DEFECT.GOOD), knnOk(DEFECT.DRIVING, 0.8));
    expect(fused.finalJudgementId).toBe(DEFECT.DRIVING);
    expect(fused.needsReview).toBe(true);
    expect(fused.decisionReason).toContain('kNN 채택');
  });

  it('stays good when both agree it is good', () => {
    const fused = fuseVerdict(rule(DEFECT.GOOD), knnOk(DEFECT.GOOD));
    expect(fused.finalJudgementId).toBe(DEFECT.GOOD);
    expect(fused.needsReview).toBe(false);
    expect(fused.sortingDisposition).toBe('OK');
  });

  it('stays good when Rule says good and kNN is unavailable', () => {
    const fused = fuseVerdict(rule(DEFECT.GOOD), knnInsufficient);
    expect(fused.finalJudgementId).toBe(DEFECT.GOOD);
    expect(fused.needsReview).toBe(false);
  });

  it('stays good when Rule says good and kNN finds no match', () => {
    const fused = fuseVerdict(rule(DEFECT.GOOD), knnNoMatch);
    expect(fused.finalJudgementId).toBe(DEFECT.GOOD);
    expect(fused.needsReview).toBe(false);
  });

  it('penalizes confidence for missing patterns', () => {
    const full = fuseVerdict(rule(DEFECT.BRIGHT_DOT, 0), knnOk(DEFECT.BRIGHT_DOT, 1));
    const partial = fuseVerdict(rule(DEFECT.BRIGHT_DOT, 2), knnOk(DEFECT.BRIGHT_DOT, 1));
    expect(partial.confidence).toBeLessThan(full.confidence);
  });

  it('forces review when image quality can hide a bright defect', () => {
    const warned = { ...rule(DEFECT.GOOD), qualityWarnings: ['W 패턴 포화'] };
    const fused = fuseVerdict(warned, knnOk(DEFECT.GOOD));
    expect(fused.finalJudgementId).toBe(DEFECT.GOOD);
    expect(fused.needsReview).toBe(true);
    expect(fused.decisionReason).toContain('W 패턴 포화');
    expect(fused.sortingDisposition).toBe('HOLD');
  });

  it('never releases an unvalidated dark capture as OK', () => {
    const held = { ...rule(DEFECT.GOOD), underexposedReview: true };
    const fused = fuseVerdict(held, knnOk(DEFECT.GOOD));
    expect(fused.needsReview).toBe(true);
    expect(fused.sortingDisposition).toBe('HOLD');
  });

  it('carries matched kNN neighbors through for the reviewer', () => {
    const fused = fuseVerdict(rule(DEFECT.GOOD), knnOk(DEFECT.DRIVING, 0.8));
    expect(fused.neighbors).toHaveLength(1);
    expect(fused.neighbors[0]!.panelId).toBe(1);
  });

  it('exposes no neighbors for a no-match, only in the reason text', () => {
    const fused = fuseVerdict(rule(DEFECT.DARK_DOT_MEDIUM), knnNoMatch);
    expect(fused.neighbors).toHaveLength(0);
    expect(fused.decisionReason).toContain('유사 패널 없음');
  });

  it('clamps confidence into [0, 1]', () => {
    const fused = fuseVerdict(rule(DEFECT.BRIGHT_DOT), knnOk(DEFECT.BRIGHT_DOT, 1));
    expect(fused.confidence).toBeLessThanOrEqual(1);
    expect(fused.confidence).toBeGreaterThanOrEqual(0);
  });
});
