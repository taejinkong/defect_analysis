import type { Pattern } from './types';
import { PATTERNS } from './types';
import type { BlobKind, Detection, ImageDetection } from './defects';
import type { DefectId, Settings } from './settings';
import { DEFAULT_SETTINGS, DEFECT, DEFECT_NAME, DEFECT_SEVERITY } from './settings';

export interface LabeledDetection extends Detection {
  readonly pattern: Pattern;
  readonly defectId: DefectId;
  /** False when the pattern-confirmation rule suppressed this from the verdict. */
  readonly counted: boolean;
}

export interface PanelVerdict {
  readonly finalJudgementId: DefectId;
  readonly primaryDefectId: DefectId;
  readonly detectedDefectIds: DefectId[];
  readonly darkAreaPct: number;
  readonly confidence: number;
  readonly decisionReason: string;
  readonly labeled: LabeledDetection[];
  /** Defects seen in only one pattern and therefore suppressed. Reviewer must look. */
  readonly suppressed: BlobKind[];
  readonly drivingFlag: boolean;
  readonly missingPatterns: Pattern[];
}

const KIND_TO_DEFECT: Record<Exclude<BlobKind, 'dark-dot'>, DefectId> = {
  'bright-dot': DEFECT.BRIGHT_DOT,
  'bright-line-h': DEFECT.BRIGHT_LINE_H,
  'bright-line-v': DEFECT.BRIGHT_LINE_V,
  'dark-line-h': DEFECT.DARK_LINE_H,
  'dark-line-v': DEFECT.DARK_LINE_V,
};

/** Dark-dot grade from total area, per docs/defect_taxonomy.md section 2. */
export function gradeDarkDot(darkAreaPct: number, settings: Settings = DEFAULT_SETTINGS): DefectId | null {
  if (darkAreaPct <= 0) return null;
  if (darkAreaPct <= settings['dark_dot.small_max_pct']) return DEFECT.DARK_DOT_SMALL;
  if (darkAreaPct <= settings['dark_dot.medium_max_pct']) return DEFECT.DARK_DOT_MEDIUM;
  return DEFECT.DARK_DOT_LARGE;
}

/**
 * Combine the per-pattern detections of one panel into a single judgement.
 *
 * Rule order follows docs/defect_taxonomy.md section 7: no-display wins, then
 * two or more distinct defect kinds means 복수불량, then a single kind names the
 * verdict, and an empty set is 양품.
 */
export function judgePanel(
  images: readonly ImageDetection[],
  settings: Settings = DEFAULT_SETTINGS,
): PanelVerdict {
  const present = new Set(images.map((i) => i.pattern));
  const missingPatterns = PATTERNS.filter((p) => !present.has(p));
  const drivingFlag = images.some((i) => i.drivingFlag);

  if (images.length === 0) {
    return {
      finalJudgementId: DEFECT.GOOD,
      primaryDefectId: DEFECT.GOOD,
      detectedDefectIds: [],
      darkAreaPct: 0,
      confidence: 0,
      decisionReason: '이미지가 없습니다.',
      labeled: [],
      suppressed: [],
      drivingFlag: false,
      missingPatterns,
    };
  }

  const noDisplay = images.find((i) => i.noDisplay !== 'none');
  if (noDisplay) {
    return {
      finalJudgementId: DEFECT.NO_DISPLAY,
      primaryDefectId: DEFECT.NO_DISPLAY,
      detectedDefectIds: [DEFECT.NO_DISPLAY],
      darkAreaPct: 0,
      confidence: penalize(0.6, missingPatterns.length),
      decisionReason:
        noDisplay.noDisplay === 'full'
          ? `Rule: ${noDisplay.pattern} 패턴 평균 휘도 ${noDisplay.meanLuma.toFixed(1)} → 전체 미점등`
          : `Rule: ${noDisplay.pattern} 패턴에 Active 영역 60% 이상의 암부 → 부분 미점등`,
      labeled: [],
      suppressed: [],
      drivingFlag,
      missingPatterns,
    };
  }

  // A real pixel defect shows up in every pattern. Requiring confirmation across
  // patterns is what keeps capture noise out of the verdict.
  const patternsByKind = new Map<BlobKind, Set<Pattern>>();
  for (const image of images) {
    for (const d of image.detections) {
      let set = patternsByKind.get(d.kind);
      if (!set) patternsByKind.set(d.kind, (set = new Set()));
      set.add(image.pattern);
    }
  }
  const minConfirmations = Math.min(settings['pattern.min_confirmations'], images.length);
  const confirmed = (kind: BlobKind): boolean =>
    (patternsByKind.get(kind)?.size ?? 0) >= minConfirmations;

  const darkAreaPct = Math.max(...images.map((i) => i.darkAreaPct));
  const darkGrade = gradeDarkDot(darkAreaPct, settings);

  const detected = new Set<DefectId>();
  if (darkGrade) detected.add(darkGrade);

  const suppressed: BlobKind[] = [];
  for (const [kind, patterns] of patternsByKind) {
    if (kind === 'dark-dot') continue; // graded by area, not by count
    if (confirmed(kind)) detected.add(KIND_TO_DEFECT[kind]);
    else if (patterns.size > 0) suppressed.push(kind);
  }

  const labeled: LabeledDetection[] = [];
  for (const image of images) {
    for (const d of image.detections) {
      const defectId = d.kind === 'dark-dot' ? darkGrade : KIND_TO_DEFECT[d.kind];
      if (!defectId) continue;
      labeled.push({
        ...d,
        pattern: image.pattern,
        defectId,
        counted: d.kind === 'dark-dot' ? true : confirmed(d.kind),
      });
    }
  }

  const detectedDefectIds = [...detected].sort();
  const reasons: string[] = [];
  if (darkGrade) reasons.push(`dark_area_ratio=${darkAreaPct.toFixed(2)}% → ${DEFECT_NAME[darkGrade]}`);
  for (const id of detectedDefectIds) if (id !== darkGrade) reasons.push(DEFECT_NAME[id]);

  let finalJudgementId: DefectId;
  if (detectedDefectIds.length >= 2) finalJudgementId = DEFECT.MULTI;
  else if (detectedDefectIds.length === 1) finalJudgementId = detectedDefectIds[0]!;
  else finalJudgementId = DEFECT.GOOD;

  const primaryDefectId =
    detectedDefectIds.length > 0
      ? [...detectedDefectIds].sort((a, b) => DEFECT_SEVERITY[b] - DEFECT_SEVERITY[a])[0]!
      : DEFECT.GOOD;

  const parts = [`Rule: ${reasons.length > 0 ? reasons.join(' + ') : '검출된 불량 없음'}`];
  if (finalJudgementId === DEFECT.MULTI) parts.push(`불량 종류 ${detectedDefectIds.length}개 → 복수불량`);
  if (suppressed.length > 0) parts.push(`단일 패턴 검출로 억제됨: ${suppressed.join(', ')}`);
  if (drivingFlag) parts.push('구동불량 의심 신호 감지 (Rule 단독 판정 불가)');
  if (missingPatterns.length > 0) parts.push(`패턴 결손: ${missingPatterns.join(', ')}`);

  return {
    finalJudgementId,
    primaryDefectId,
    detectedDefectIds,
    darkAreaPct,
    // 0.6 is the "rule only, no kNN" confidence from the fusion table in
    // docs/matching_engine.md section 6. kNN is not built yet.
    confidence: penalize(0.6, missingPatterns.length),
    decisionReason: parts.join(' / '),
    labeled,
    suppressed,
    drivingFlag,
    missingPatterns,
  };
}

function penalize(confidence: number, missingCount: number): number {
  return confidence * 0.85 ** missingCount;
}
