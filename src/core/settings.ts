/**
 * Rule engine thresholds, per docs/database_schema.md section 3.7.
 *
 * These are estimates, not values validated against real captures. They live in
 * one place so they can be tuned from the UI and exported as JSON without
 * touching code.
 */
export interface Settings {
  readonly 'dark_dot.small_max_pct': number;
  readonly 'dark_dot.medium_max_pct': number;
  readonly 'dark.residual_threshold': number;
  readonly 'bright.residual_threshold': number;
  readonly 'blob.min_area_px': number;
  readonly 'line.min_aspect_ratio': number;
  readonly 'line.min_length_ratio': number;
  readonly 'line.angle_tolerance_deg': number;
  readonly 'no_display.mean_luma_threshold': number;
  readonly 'no_display.partial_area_ratio': number;
  readonly 'region.center_max_r': number;
  readonly 'region.mid_max_r': number;
  /** A dot/line must appear in at least this many of R/G/B/W to be believed. */
  readonly 'pattern.min_confirmations': number;
}

export const DEFAULT_SETTINGS: Settings = {
  'dark_dot.small_max_pct': 5,
  'dark_dot.medium_max_pct': 15,
  'dark.residual_threshold': 25,
  'bright.residual_threshold': 30,
  'blob.min_area_px': 6,
  'line.min_aspect_ratio': 8,
  'line.min_length_ratio': 0.4,
  'line.angle_tolerance_deg': 20,
  'no_display.mean_luma_threshold': 15,
  'no_display.partial_area_ratio': 0.6,
  'region.center_max_r': 0.35,
  'region.mid_max_r': 0.75,
  'pattern.min_confirmations': 2,
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
    key: 'pattern.min_confirmations',
    group: '검출 감도',
    label: '패턴 교차 확인 수',
    hint: '점·선 불량이 R/G/B/W 중 몇 개에서 보여야 인정할지. 1이면 교차 확인을 끕니다.',
    min: 1,
    max: 4,
    step: 1,
    precision: 0,
    unit: '개',
  },

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
];

export const SETTING_GROUPS: readonly string[] = [
  '검출 감도',
  '암점 등급',
  'Line 판정',
  '미점등',
  '위치 구분',
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

  if (out['dark_dot.medium_max_pct']! <= out['dark_dot.small_max_pct']!) {
    const fixed = Math.min(50, out['dark_dot.small_max_pct']! + 0.1);
    repaired.push(`암점 中 상한이 小 상한 이하 → ${fixed.toFixed(1)}%로 보정`);
    out['dark_dot.medium_max_pct'] = fixed;
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
