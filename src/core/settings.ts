/**
 * Rule engine thresholds, per docs/database_schema.md section 3.7.
 *
 * These are estimates, not values validated against real captures. They live in
 * one place so they can be tuned from the UI and exported as JSON without
 * touching code.
 */
export interface Settings {
  readonly 'preprocessing.min_circle_confidence': number;
  readonly 'preprocessing.min_fpcb_strength': number;
  readonly 'preprocessing.max_clipping_ratio': number;
  readonly 'preprocessing.min_blur_score': number;
  readonly 'preprocessing.min_mean_luminance': number;
  readonly 'preprocessing.max_mean_luminance': number;
  readonly 'preprocessing.max_saturation_ratio': number;
  readonly 'dark_dot.small_max_pct': number;
  readonly 'dark_dot.medium_max_pct': number;
  readonly 'dark.residual_threshold': number;
  readonly 'bright.residual_threshold': number;
  /** W pattern needs a lower white-on-white contrast floor than RGB patterns. */
  readonly 'bright.w_residual_threshold': number;
  readonly 'blob.min_area_px': number;
  readonly 'line.min_aspect_ratio': number;
  /** Relaxed aspect threshold used only by components substantially longer than the normal minimum. */
  readonly 'line.thick_min_aspect_ratio': number;
  readonly 'line.min_length_ratio': number;
  readonly 'line.angle_tolerance_deg': number;
  /** Minimum filled share between the first and last abnormal pixel of a projected line. */
  readonly 'line.min_continuity_ratio': number;
  readonly 'line.max_gap_ratio': number;
  /** High-resolution projection pass is used when the source diameter exceeds this value. */
  readonly 'line.native_min_diameter_px': number;
  readonly 'no_display.mean_luma_threshold': number;
  readonly 'no_display.partial_area_ratio': number;
  readonly 'region.center_max_r': number;
  readonly 'region.mid_max_r': number;
  /** A dot/line must appear in at least this many of R/G/B/W to be believed. */
  readonly 'pattern.min_confirmations': number;
  /** Maximum normalized center distance for detections to count as the same cross-pattern defect. */
  readonly 'pattern.position_tolerance_r': number;
  /** Maximum axial orientation difference for cross-pattern Line confirmation. */
  readonly 'pattern.line_angle_tolerance_deg': number;
  readonly 'pattern.min_area_similarity': number;
  readonly 'pattern.min_bbox_iou': number;
  readonly 'pattern.dark_dot_min_confirmations': number;
  readonly 'pattern.bright_dot_min_confirmations': number;
  readonly 'pattern.line_min_confirmations': number;
  readonly 'knn.k': number;
  readonly 'knn.min_similarity': number;
  /** Below this many searchable training panels, kNN stays off and Rule decides alone. */
  readonly 'knn.min_train_panels': number;
}

export const DEFAULT_SETTINGS: Settings = {
  'preprocessing.min_circle_confidence': 0.5,
  'preprocessing.min_fpcb_strength': 3,
  'preprocessing.max_clipping_ratio': 0.02,
  'preprocessing.min_blur_score': 4,
  'preprocessing.min_mean_luminance': 15,
  'preprocessing.max_mean_luminance': 245,
  'preprocessing.max_saturation_ratio': 0.25,
  'dark_dot.small_max_pct': 5,
  'dark_dot.medium_max_pct': 15,
  'dark.residual_threshold': 25,
  'bright.residual_threshold': 30,
  'bright.w_residual_threshold': 20,
  'blob.min_area_px': 6,
  'line.min_aspect_ratio': 8,
  'line.thick_min_aspect_ratio': 3.5,
  'line.min_length_ratio': 0.4,
  'line.angle_tolerance_deg': 20,
  'line.min_continuity_ratio': 0.7,
  'line.max_gap_ratio': 0.2,
  'line.native_min_diameter_px': 600,
  'no_display.mean_luma_threshold': 15,
  'no_display.partial_area_ratio': 0.6,
  'region.center_max_r': 0.35,
  'region.mid_max_r': 0.75,
  'pattern.min_confirmations': 2,
  'pattern.position_tolerance_r': 0.08,
  'pattern.line_angle_tolerance_deg': 15,
  'pattern.min_area_similarity': 0.2,
  'pattern.min_bbox_iou': 0,
  'pattern.dark_dot_min_confirmations': 2,
  'pattern.bright_dot_min_confirmations': 1,
  'pattern.line_min_confirmations': 1,
  'knn.k': 5,
  'knn.min_similarity': 0.75,
  'knn.min_train_panels': 10,
};

export type SettingKey = keyof Settings;

export interface SettingSpec {
  readonly key: SettingKey;
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Decimal places to show. */
  readonly precision: number;
  readonly unit?: string;
}

/**
 * Slider bounds for every threshold.
 *
 * Ranges are deliberately wide. The defaults were chosen against synthetic
 * images and have never seen a real capture, so the useful value may sit well
 * away from where it starts.
 */
export const SETTING_SPECS: readonly SettingSpec[] = [
  {
    key: 'preprocessing.min_circle_confidence',
    group: '전처리 품질',
    label: '원 검출 최소 신뢰도',
    hint: '원 피팅 잔차로 계산한 신뢰도가 이 값보다 낮으면 검수 대상으로 보냅니다.',
    min: 0.1,
    max: 0.95,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'preprocessing.min_fpcb_strength',
    group: '전처리 품질',
    label: 'FPCB 최소 신뢰도',
    hint: 'FPCB 방향 신호가 이 robust-sigma 값보다 낮으면 수동 정렬 검수가 필요합니다.',
    min: 0.5,
    max: 20,
    step: 0.5,
    precision: 1,
    unit: 'σ',
  },
  {
    key: 'preprocessing.max_clipping_ratio',
    group: '전처리 품질',
    label: '최대 원 경계 잘림 비율',
    hint: '사진 밖으로 벗어난 Active 원 둘레 비율이 이 값보다 크면 검수 대상으로 보냅니다.',
    min: 0,
    max: 0.5,
    step: 0.01,
    precision: 2,
  },
  {
    key: 'preprocessing.min_blur_score',
    group: '전처리 품질',
    label: '최소 선명도 점수',
    hint: 'Active 영역 Laplacian 분산이 이 값보다 낮으면 과도한 흐림으로 표시합니다.',
    min: 0,
    max: 500,
    step: 1,
    precision: 0,
  },
  {
    key: 'preprocessing.min_mean_luminance',
    group: '전처리 품질',
    label: '유효 평균 휘도 하한',
    hint: '전체 미점등 판정과 별개로 촬영 노출 검증에 사용하는 하한입니다.',
    min: 0,
    max: 120,
    step: 1,
    precision: 0,
  },
  {
    key: 'preprocessing.max_mean_luminance',
    group: '전처리 품질',
    label: '유효 평균 휘도 상한',
    hint: '평균 휘도가 이 값보다 높으면 과노출 가능성으로 검수 대상으로 보냅니다.',
    min: 120,
    max: 255,
    step: 1,
    precision: 0,
  },
  {
    key: 'preprocessing.max_saturation_ratio',
    group: '전처리 품질',
    label: '최대 포화 비율',
    hint: 'Active 픽셀 중 RGB가 모두 250 이상인 비율의 허용 상한입니다.',
    min: 0,
    max: 1,
    step: 0.01,
    precision: 2,
  },
  {
    key: 'dark.residual_threshold',
    group: '검출 감도',
    label: '암부 잔차 임계',
    hint: '배경보다 이만큼 어두우면 암부 후보. 낮출수록 더 많이 검출됩니다.',
    min: 1,
    max: 120,
    step: 1,
    precision: 0,
  },
  {
    key: 'bright.residual_threshold',
    group: '검출 감도',
    label: '명부 잔차 임계',
    hint: '배경보다 이만큼 밝으면 명부 후보. 패널이 포화되면 명점이 보이지 않습니다.',
    min: 1,
    max: 120,
    step: 1,
    precision: 0,
  },
  {
    key: 'bright.w_residual_threshold',
    group: '검출 감도',
    label: 'W 명부 잔차 임계',
    hint: 'W 점등에서 정상 White보다 더 밝은 명점·명선을 찾는 기준. 낮출수록 W 패턴 명부를 더 민감하게 검출합니다.',
    min: 1,
    max: 120,
    step: 1,
    precision: 0,
  },
  {
    key: 'blob.min_area_px',
    group: '검출 감도',
    label: '최소 검출 면적',
    hint: '이보다 작은 연결 성분은 노이즈로 보고 버립니다.',
    min: 1,
    max: 200,
    step: 1,
    precision: 0,
    unit: 'px',
  },
  {
    key: 'pattern.position_tolerance_r',
    group: '검출 감도',
    label: '패턴 위치 일치 허용거리',
    hint: 'R/G/B/W 검출 중심이 Active 반지름 대비 이 거리 안에 있어야 같은 불량으로 확인합니다.',
    min: 0.01,
    max: 0.3,
    step: 0.01,
    precision: 2,
  },
  {
    key: 'pattern.line_angle_tolerance_deg',
    group: '검출 감도',
    label: '패턴 Line 방향 일치각',
    hint: '패턴 간 Line 주축 방향 차이가 이 값 이하여야 같은 Line으로 확인합니다.',
    min: 1,
    max: 45,
    step: 1,
    precision: 0,
    unit: '°',
  },
  {
    key: 'pattern.min_area_similarity',
    group: '검출 감도',
    label: '패턴 면적 유사도 하한',
    hint: '같은 위치 후보의 작은 면적/큰 면적 비율입니다. 패턴별 발현 크기 차이를 허용하려면 낮춥니다.',
    min: 0,
    max: 1,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'pattern.min_bbox_iou',
    group: '검출 감도',
    label: '패턴 Box IoU 하한',
    hint: '정합 후 경계 상자 겹침 하한입니다. 0이면 중심거리만 사용하고, Golden 정합이 검증된 뒤 올립니다.',
    min: 0,
    max: 0.9,
    step: 0.05,
    precision: 2,
  },
  ...([
    ['pattern.dark_dot_min_confirmations', '암점 교차 확인 수', '암점은 합산 면적 등급에 포함되기 전 필요한 패턴 수입니다.'],
    ['pattern.bright_dot_min_confirmations', '명점 교차 확인 수', '특정 subpixel 패턴에서만 보이는 명점을 허용하려면 1로 둡니다.'],
    ['pattern.line_min_confirmations', 'Line 교차 확인 수', '명선·암선이 한 패턴에서만 발현될 수 있으면 1로 둡니다.'],
  ] as const).map(([key, label, hint]) => ({
    key,
    group: '검출 감도',
    label,
    hint,
    min: 1,
    max: 4,
    step: 1,
    precision: 0,
    unit: '개',
  })),

  {
    key: 'dark_dot.small_max_pct',
    group: '암점 등급',
    label: '암점 小 상한',
    hint: 'Active 영역 대비 암점 총 면적 비율. 이 값 이하면 小.',
    min: 0.1,
    max: 20,
    step: 0.1,
    precision: 1,
    unit: '%',
  },
  {
    key: 'dark_dot.medium_max_pct',
    group: '암점 등급',
    label: '암점 中 상한',
    hint: '이 값 이하면 中, 초과하면 大. 小 상한보다 커야 합니다.',
    min: 0.2,
    max: 50,
    step: 0.1,
    precision: 1,
    unit: '%',
  },

  {
    key: 'line.min_aspect_ratio',
    group: 'Line 판정',
    label: '최소 종횡비',
    hint: '길이/두께가 이 값 이상이어야 Line. 미만이면 점으로 분류됩니다.',
    min: 2,
    max: 40,
    step: 0.5,
    precision: 1,
  },
  {
    key: 'line.thick_min_aspect_ratio',
    group: 'Line 판정',
    label: '두꺼운 Line 최소 종횡비',
    hint: '최소 길이의 1.5배 이상인 긴 성분에 적용합니다. 두꺼운 명선·암선을 놓치면 낮추고, 긴 얼룩이 Line으로 잡히면 올립니다.',
    min: 1.5,
    max: 12,
    step: 0.5,
    precision: 1,
  },
  {
    key: 'line.min_length_ratio',
    group: 'Line 판정',
    label: '최소 길이 (지름 대비)',
    hint: 'Active 지름 대비 길이. 짧은 줄무늬는 점으로 남습니다.',
    min: 0.05,
    max: 1,
    step: 0.01,
    precision: 2,
  },
  {
    key: 'line.angle_tolerance_deg',
    group: 'Line 판정',
    label: '가로/세로 허용각',
    hint: '수평 또는 수직에서 이 각도 이내여야 Line으로 인정합니다.',
    min: 1,
    max: 45,
    step: 1,
    precision: 0,
    unit: '°',
  },
  {
    key: 'line.min_continuity_ratio',
    group: 'Line 판정',
    label: 'Line 최소 연속성',
    hint: '선 시작~끝 구간 중 실제 이상 픽셀이 차지해야 하는 최소 비율입니다.',
    min: 0.2,
    max: 1,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'line.max_gap_ratio',
    group: 'Line 판정',
    label: 'Line 최대 끊김 비율',
    hint: '끊어진 Line 내부에서 허용하는 빈 구간 비율입니다.',
    min: 0,
    max: 0.8,
    step: 0.05,
    precision: 2,
  },
  {
    key: 'line.native_min_diameter_px',
    group: 'Line 판정',
    label: '고해상도 Line 분석 시작 지름',
    hint: '원본 Active 지름이 이 값 이상이면 원본 기반 고해상도 projection 보조 검출을 실행합니다.',
    min: 300,
    max: 2000,
    step: 50,
    precision: 0,
    unit: 'px',
  },

  {
    key: 'no_display.mean_luma_threshold',
    group: '미점등',
    label: '전체 미점등 평균 휘도',
    hint: 'Active 영역 평균 휘도가 이 값 미만이면 전체 미점등.',
    min: 1,
    max: 120,
    step: 1,
    precision: 0,
  },
  {
    key: 'no_display.partial_area_ratio',
    group: '미점등',
    label: '부분 미점등 면적비',
    hint: '단일 암부가 Active 영역의 이 비율 이상이면 암점 大가 아니라 미점등.',
    min: 0.2,
    max: 0.95,
    step: 0.01,
    precision: 2,
  },

  {
    key: 'region.center_max_r',
    group: '위치 구분',
    label: 'center 상한 반경비',
    hint: '중심에서 이 비율 이내면 center.',
    min: 0.05,
    max: 0.6,
    step: 0.01,
    precision: 2,
  },
  {
    key: 'region.mid_max_r',
    group: '위치 구분',
    label: 'mid 상한 반경비',
    hint: '이 비율 이내면 mid, 초과하면 edge. center 상한보다 커야 합니다.',
    min: 0.2,
    max: 0.98,
    step: 0.01,
    precision: 2,
  },

  {
    key: 'knn.min_train_panels',
    group: 'kNN 매칭',
    label: 'kNN 활성 최소 학습 수',
    hint: '승인된 학습 패널이 이 수 미만이면 kNN을 끄고 Rule 단독으로 판정합니다.',
    min: 1,
    max: 100,
    step: 1,
    precision: 0,
    unit: '개',
  },
  {
    key: 'knn.k',
    group: 'kNN 매칭',
    label: '이웃 수 (k)',
    hint: '가장 비슷한 학습 패널 몇 개로 다수결할지.',
    min: 1,
    max: 25,
    step: 1,
    precision: 0,
    unit: '개',
  },
  {
    key: 'knn.min_similarity',
    group: 'kNN 매칭',
    label: '최소 유사도',
    hint: '코사인 유사도가 이 값 이상인 이웃만 인정합니다. 낮추면 더 자주 매칭됩니다.',
    min: 0.3,
    max: 0.99,
    step: 0.01,
    precision: 2,
  },
];

export const SETTING_GROUPS: readonly string[] = [
  '전처리 품질',
  '검출 감도',
  '암점 등급',
  'Line 판정',
  '미점등',
  '위치 구분',
  'kNN 매칭',
];

const SPEC_BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

/**
 * Coerce arbitrary input into a valid Settings object.
 *
 * Unknown keys are dropped and missing keys fall back to the default, so an
 * exported file from an older build still loads. Ordering constraints between
 * dependent thresholds are repaired rather than rejected: a settings file that
 * says 小 <= 10% and 中 <= 5% describes an empty 中 band, which would silently
 * make 암점 中 unreachable.
 */
export function sanitizeSettings(raw: unknown): { settings: Settings; repaired: string[] } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = { ...DEFAULT_SETTINGS };
  const repaired: string[] = [];

  for (const spec of SETTING_SPECS) {
    const value = input[spec.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    if (clamped !== value) repaired.push(`${spec.label}: ${value} → ${clamped} (범위 밖)`);
    out[spec.key] = clamped;
  }
  // Legacy global confirmation count is retained in JSON/DB for migration but
  // hidden from the UI now that each defect family has its own setting.
  const legacyConfirmations = input['pattern.min_confirmations'];
  if (typeof legacyConfirmations === 'number' && Number.isFinite(legacyConfirmations)) {
    out['pattern.min_confirmations'] = Math.min(4, Math.max(1, legacyConfirmations));
  }

  if (out['dark_dot.medium_max_pct']! <= out['dark_dot.small_max_pct']!) {
    const fixed = Math.min(50, out['dark_dot.small_max_pct']! + 0.1);
    repaired.push(`암점 中 상한이 小 상한 이하 → ${fixed.toFixed(1)}%로 보정`);
    out['dark_dot.medium_max_pct'] = fixed;
  }
  if (out['preprocessing.max_mean_luminance']! <= out['preprocessing.min_mean_luminance']!) {
    const fixed = Math.min(255, out['preprocessing.min_mean_luminance']! + 1);
    repaired.push(`평균 휘도 상한이 하한 이하 → ${fixed.toFixed(0)}로 보정`);
    out['preprocessing.max_mean_luminance'] = fixed;
  }
  if (out['line.thick_min_aspect_ratio']! > out['line.min_aspect_ratio']!) {
    const fixed = out['line.min_aspect_ratio']!;
    repaired.push(`두꺼운 Line 최소 종횡비가 일반 Line 기준 초과 → ${fixed.toFixed(1)}로 보정`);
    out['line.thick_min_aspect_ratio'] = fixed;
  }
  if (out['region.mid_max_r']! <= out['region.center_max_r']!) {
    const fixed = Math.min(0.98, out['region.center_max_r']! + 0.01);
    repaired.push(`mid 상한이 center 상한 이하 → ${fixed.toFixed(2)}로 보정`);
    out['region.mid_max_r'] = fixed;
  }

  return { settings: out as unknown as Settings, repaired };
}

export function formatSetting(key: SettingKey, value: number): string {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return String(value);
  return `${value.toFixed(spec.precision)}${spec.unit ?? ''}`;
}

/** Keys whose value differs from the shipped default. */
export function changedKeys(settings: Settings): SettingKey[] {
  return SETTING_SPECS.filter((s) => settings[s.key] !== DEFAULT_SETTINGS[s.key]).map((s) => s.key);
}

/** Defect ids from docs/defect_taxonomy.md section 1. */
export const DEFECT = {
  GOOD: 'D000',
  DARK_DOT_SMALL: 'D001',
  DARK_DOT_MEDIUM: 'D002',
  DARK_DOT_LARGE: 'D003',
  BRIGHT_DOT: 'D004',
  BRIGHT_LINE_H: 'D005',
  BRIGHT_LINE_V: 'D006',
  DARK_LINE_H: 'D007',
  DARK_LINE_V: 'D008',
  DRIVING: 'D009',
  NO_DISPLAY: 'D010',
  MULTI: 'D011',
} as const;

export type DefectId = (typeof DEFECT)[keyof typeof DEFECT];

export const DEFECT_NAME: Record<DefectId, string> = {
  D000: '양품',
  D001: '암점 小',
  D002: '암점 中',
  D003: '암점 大',
  D004: '명점',
  D005: '명선_가로줄',
  D006: '명선_세로줄',
  D007: '암선_가로줄',
  D008: '암선_세로줄',
  D009: '구동불량',
  D010: '미점등',
  D011: '복수불량',
};

/** The three panel-level grades that are derived from one combined dark area. */
export const DARK_DOT_DEFECTS: readonly DefectId[] = [
  DEFECT.DARK_DOT_SMALL,
  DEFECT.DARK_DOT_MEDIUM,
  DEFECT.DARK_DOT_LARGE,
];

export function isDarkDotDefect(defectId: DefectId): boolean {
  return DARK_DOT_DEFECTS.includes(defectId);
}

/**
 * Defects a person may place on an image.
 *
 * 양품 and 복수불량 are derived from the label set, never drawn, so they must not
 * appear in the labeling picker. See docs/defect_taxonomy.md section 1.
 */
export const LABELABLE_DEFECTS: readonly DefectId[] = [
  DEFECT.DARK_DOT_SMALL,
  DEFECT.DARK_DOT_MEDIUM,
  DEFECT.DARK_DOT_LARGE,
  DEFECT.BRIGHT_DOT,
  DEFECT.BRIGHT_LINE_H,
  DEFECT.BRIGHT_LINE_V,
  DEFECT.DARK_LINE_H,
  DEFECT.DARK_LINE_V,
  DEFECT.DRIVING,
  DEFECT.NO_DISPLAY,
];

/** Higher wins when choosing a panel's primary defect. */
export const DEFECT_SEVERITY: Record<DefectId, number> = {
  D000: 0,
  D001: 1,
  D002: 2,
  D003: 3,
  D004: 2,
  D005: 3,
  D006: 3,
  D007: 3,
  D008: 3,
  D009: 4,
  D010: 4,
  D011: 4,
};
