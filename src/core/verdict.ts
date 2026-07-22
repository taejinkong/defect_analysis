import type { Pattern } from './types';
import { FRAME_RADIUS, PATTERNS } from './types';
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
  /** Defect kinds with no position/direction-confirmed candidate. Reviewer must look. */
  readonly suppressed: BlobKind[];
  readonly drivingFlag: boolean;
  readonly missingPatterns: Pattern[];
  readonly qualityWarnings: string[];
  readonly patternOnlyDefect: boolean;
  readonly underexposedReview: boolean;
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
      qualityWarnings: [],
      patternOnlyDefect: false,
      underexposedReview: false,
    };
  }

  const noDisplay = images.find((i) => i.noDisplay === 'full' || i.noDisplay === 'partial');
  const underexposedReview = images.some((i) => i.noDisplay === 'underexposed-review');
  const qualityWarnings = [...new Set(images.flatMap((image) => image.qualityWarnings))];
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
      qualityWarnings,
      patternOnlyDefect: false,
      underexposedReview,
    };
  }

  // A real defect must repeat at the same normalized position. Merely seeing
  // the same kind somewhere in two patterns lets unrelated dust/noise confirm
  // each other, so confirmation compares center distance and (for Lines) the
  // axial orientation as well.
  const entries = images.flatMap((image) =>
    image.detections.map((detection) => ({ pattern: image.pattern, detection })),
  );
  const confirmedEntries = new Set<Detection>();
  const occurrenceCount = new Map<Detection, number>();
  for (const entry of entries) {
    const patterns = new Set<Pattern>();
    for (const candidate of entries) {
      if (sameCrossPatternDefect(entry, candidate, settings)) patterns.add(candidate.pattern);
    }
    occurrenceCount.set(entry.detection, patterns.size);
    const minConfirmations = Math.min(confirmationsFor(entry.detection.kind, settings), images.length);
    if (patterns.size >= minConfirmations) confirmedEntries.add(entry.detection);
  }

  // Sum only cross-pattern-confirmed black dot regions within each pattern,
  // then take the largest pattern total to avoid counting one physical defect
  // up to four times.
  const darkAreaPct = Math.max(
    0,
    ...images.map((image) => {
      if (image.activeAreaPx <= 0) return 0;
      let area = 0;
      for (const detection of image.detections) {
        if (detection.kind === 'dark-dot' && confirmedEntries.has(detection)) area += detection.areaPx;
      }
      return (area / image.activeAreaPx) * 100;
    }),
  );
  const darkGrade = gradeDarkDot(darkAreaPct, settings);

  const detected = new Set<DefectId>();
  if (darkGrade) detected.add(darkGrade);

  const confirmedKinds = new Set<BlobKind>();
  const presentKinds = new Set<BlobKind>();
  for (const { detection } of entries) {
    presentKinds.add(detection.kind);
    if (confirmedEntries.has(detection)) confirmedKinds.add(detection.kind);
  }
  for (const kind of confirmedKinds) {
    if (kind !== 'dark-dot') detected.add(KIND_TO_DEFECT[kind]);
  }
  const suppressed = [...presentKinds].filter((kind) => !confirmedKinds.has(kind));

  const labeled: LabeledDetection[] = [];
  for (const image of images) {
    for (const d of image.detections) {
      const defectId = d.kind === 'dark-dot' ? darkGrade : KIND_TO_DEFECT[d.kind];
      if (!defectId) continue;
      labeled.push({
        ...d,
        pattern: image.pattern,
        defectId,
        counted: confirmedEntries.has(d),
      });
    }
  }

  const detectedDefectIds = [...detected].sort();
  const reasons: string[] = [];
  if (darkGrade) reasons.push(`암점 합산 면적비=${darkAreaPct.toFixed(2)}% → ${DEFECT_NAME[darkGrade]}`);
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
  const unconfirmedCount = entries.length - confirmedEntries.size;
  if (unconfirmedCount > 0) {
    parts.push(`패턴 위치/방향 확인 미충족 후보 ${unconfirmedCount}개`);
  }
  if (drivingFlag) parts.push('구동불량 의심 신호 감지 (Rule 단독 판정 불가)');
  if (missingPatterns.length > 0) parts.push(`패턴 결손: ${missingPatterns.join(', ')}`);
  if (qualityWarnings.length > 0) parts.push(...qualityWarnings);
  const patternOnlyDefect = [...confirmedEntries].some((detection) => occurrenceCount.get(detection) === 1);
  if (patternOnlyDefect) parts.push('단일 패턴 후보 — 패턴 특이 불량 가능성 검수 필요');
  if (underexposedReview) parts.push('저휘도 촬영과 실제 미점등 구분 필요');

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
    qualityWarnings,
    patternOnlyDefect,
    underexposedReview,
  };
}

interface DetectionEntry {
  readonly pattern: Pattern;
  readonly detection: Detection;
}

function sameCrossPatternDefect(a: DetectionEntry, b: DetectionEntry, settings: Settings): boolean {
  if (a.pattern === b.pattern || a.detection.kind !== b.detection.kind) return a === b;
  const distance = Math.hypot(a.detection.x - b.detection.x, a.detection.y - b.detection.y) / FRAME_RADIUS;
  if (distance > settings['pattern.position_tolerance_r']) return false;
  const areaSimilarity = Math.min(a.detection.areaPx, b.detection.areaPx) /
    Math.max(1, a.detection.areaPx, b.detection.areaPx);
  if (areaSimilarity < settings['pattern.min_area_similarity']) return false;
  if (bboxIou(a.detection.bbox, b.detection.bbox) < settings['pattern.min_bbox_iou']) return false;
  if (!a.detection.kind.includes('-line-')) return true;
  let angle = Math.abs(a.detection.orientationDeg - b.detection.orientationDeg) % 180;
  if (angle > 90) angle = 180 - angle;
  return angle <= settings['pattern.line_angle_tolerance_deg'];
}

function confirmationsFor(kind: BlobKind, settings: Settings): number {
  if (kind === 'dark-dot') return settings['pattern.dark_dot_min_confirmations'];
  if (kind === 'bright-dot') return settings['pattern.bright_dot_min_confirmations'];
  return settings['pattern.line_min_confirmations'];
}

function bboxIou(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1);
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
  const intersection = w * h;
  const areaA = Math.max(0, a[2] - a[0] + 1) * Math.max(0, a[3] - a[1] + 1);
  const areaB = Math.max(0, b[2] - b[0] + 1) * Math.max(0, b[3] - b[1] + 1);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

function penalize(confidence: number, missingCount: number): number {
  return confidence * 0.85 ** missingCount;
}
