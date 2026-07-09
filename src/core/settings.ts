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
