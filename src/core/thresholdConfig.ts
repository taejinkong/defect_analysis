import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './settings';

export const THRESHOLD_SCHEMA_VERSION = 1;
export const DEFAULT_THRESHOLD_VERSION = '1.0.0';

export interface ThresholdConfig {
  readonly schemaVersion: number;
  readonly version: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly preprocessing: {
    readonly minCircleConfidence: number;
    readonly minFpcbStrength: number;
    readonly maxClippingRatio: number;
    readonly minBlurScore: number;
    readonly minMeanLuminance: number;
    readonly maxMeanLuminance: number;
    readonly maxSaturationRatio: number;
  };
  readonly darkDot: {
    readonly smallMaxPct: number;
    readonly mediumMaxPct: number;
    readonly residualThreshold: number;
    readonly minAreaPx: number;
  };
  readonly brightDot: {
    readonly rgbResidualThreshold: number;
    readonly wResidualThreshold: number;
  };
  readonly darkLine: {
    readonly minAspectRatio: number;
    readonly thickMinAspectRatio: number;
    readonly minLengthRatio: number;
    readonly angleToleranceDeg: number;
    readonly minContinuityRatio: number;
    readonly maxGapRatio: number;
    readonly nativeMinDiameterPx: number;
  };
  readonly brightLine: {
    readonly sharedGeometryVersion: string;
  };
  readonly noDisplay: { readonly meanLuminanceThreshold: number };
  readonly partialNoDisplay: { readonly areaRatio: number };
  readonly drivingAbnormality: {
    readonly knnK: number;
    readonly minSimilarity: number;
    readonly minTrainingPanels: number;
  };
  readonly reviewRules: {
    readonly minPatternConfirmations: number;
    readonly positionToleranceR: number;
    readonly lineAngleToleranceDeg: number;
    readonly minAreaSimilarity: number;
    readonly minBboxIou: number;
    readonly darkDotMinConfirmations: number;
    readonly brightDotMinConfirmations: number;
    readonly lineMinConfirmations: number;
    readonly centerMaxR: number;
    readonly midMaxR: number;
  };
}

export interface ThresholdValidation {
  readonly ok: boolean;
  readonly config?: ThresholdConfig;
  readonly errors: string[];
  readonly migratedLegacy: boolean;
}

export function createThresholdConfig(
  settings: Settings = DEFAULT_SETTINGS,
  version = DEFAULT_THRESHOLD_VERSION,
  updatedBy = '',
  updatedAt = new Date().toISOString(),
): ThresholdConfig {
  return {
    schemaVersion: THRESHOLD_SCHEMA_VERSION,
    version,
    updatedAt,
    updatedBy,
    preprocessing: {
      minCircleConfidence: settings['preprocessing.min_circle_confidence'],
      minFpcbStrength: settings['preprocessing.min_fpcb_strength'],
      maxClippingRatio: settings['preprocessing.max_clipping_ratio'],
      minBlurScore: settings['preprocessing.min_blur_score'],
      minMeanLuminance: settings['preprocessing.min_mean_luminance'],
      maxMeanLuminance: settings['preprocessing.max_mean_luminance'],
      maxSaturationRatio: settings['preprocessing.max_saturation_ratio'],
    },
    darkDot: {
      smallMaxPct: settings['dark_dot.small_max_pct'],
      mediumMaxPct: settings['dark_dot.medium_max_pct'],
      residualThreshold: settings['dark.residual_threshold'],
      minAreaPx: settings['blob.min_area_px'],
    },
    brightDot: {
      rgbResidualThreshold: settings['bright.residual_threshold'],
      wResidualThreshold: settings['bright.w_residual_threshold'],
    },
    darkLine: {
      minAspectRatio: settings['line.min_aspect_ratio'],
      thickMinAspectRatio: settings['line.thick_min_aspect_ratio'],
      minLengthRatio: settings['line.min_length_ratio'],
      angleToleranceDeg: settings['line.angle_tolerance_deg'],
      minContinuityRatio: settings['line.min_continuity_ratio'],
      maxGapRatio: settings['line.max_gap_ratio'],
      nativeMinDiameterPx: settings['line.native_min_diameter_px'],
    },
    brightLine: { sharedGeometryVersion: 'darkLine' },
    noDisplay: { meanLuminanceThreshold: settings['no_display.mean_luma_threshold'] },
    partialNoDisplay: { areaRatio: settings['no_display.partial_area_ratio'] },
    drivingAbnormality: {
      knnK: settings['knn.k'],
      minSimilarity: settings['knn.min_similarity'],
      minTrainingPanels: settings['knn.min_train_panels'],
    },
    reviewRules: {
      minPatternConfirmations: settings['pattern.min_confirmations'],
      positionToleranceR: settings['pattern.position_tolerance_r'],
      lineAngleToleranceDeg: settings['pattern.line_angle_tolerance_deg'],
      minAreaSimilarity: settings['pattern.min_area_similarity'],
      minBboxIou: settings['pattern.min_bbox_iou'],
      darkDotMinConfirmations: settings['pattern.dark_dot_min_confirmations'],
      brightDotMinConfirmations: settings['pattern.bright_dot_min_confirmations'],
      lineMinConfirmations: settings['pattern.line_min_confirmations'],
      centerMaxR: settings['region.center_max_r'],
      midMaxR: settings['region.mid_max_r'],
    },
  };
}

export function thresholdConfigToSettings(config: ThresholdConfig): Settings {
  return {
    'preprocessing.min_circle_confidence': config.preprocessing.minCircleConfidence,
    'preprocessing.min_fpcb_strength': config.preprocessing.minFpcbStrength,
    'preprocessing.max_clipping_ratio': config.preprocessing.maxClippingRatio,
    'preprocessing.min_blur_score': config.preprocessing.minBlurScore,
    'preprocessing.min_mean_luminance': config.preprocessing.minMeanLuminance,
    'preprocessing.max_mean_luminance': config.preprocessing.maxMeanLuminance,
    'preprocessing.max_saturation_ratio': config.preprocessing.maxSaturationRatio,
    'dark_dot.small_max_pct': config.darkDot.smallMaxPct,
    'dark_dot.medium_max_pct': config.darkDot.mediumMaxPct,
    'dark.residual_threshold': config.darkDot.residualThreshold,
    'bright.residual_threshold': config.brightDot.rgbResidualThreshold,
    'bright.w_residual_threshold': config.brightDot.wResidualThreshold,
    'blob.min_area_px': config.darkDot.minAreaPx,
    'line.min_aspect_ratio': config.darkLine.minAspectRatio,
    'line.thick_min_aspect_ratio': config.darkLine.thickMinAspectRatio,
    'line.min_length_ratio': config.darkLine.minLengthRatio,
    'line.angle_tolerance_deg': config.darkLine.angleToleranceDeg,
    'line.min_continuity_ratio': config.darkLine.minContinuityRatio,
    'line.max_gap_ratio': config.darkLine.maxGapRatio,
    'line.native_min_diameter_px': config.darkLine.nativeMinDiameterPx,
    'no_display.mean_luma_threshold': config.noDisplay.meanLuminanceThreshold,
    'no_display.partial_area_ratio': config.partialNoDisplay.areaRatio,
    'region.center_max_r': config.reviewRules.centerMaxR,
    'region.mid_max_r': config.reviewRules.midMaxR,
    'pattern.min_confirmations': config.reviewRules.minPatternConfirmations,
    'pattern.position_tolerance_r': config.reviewRules.positionToleranceR,
    'pattern.line_angle_tolerance_deg': config.reviewRules.lineAngleToleranceDeg,
    'pattern.min_area_similarity': config.reviewRules.minAreaSimilarity,
    'pattern.min_bbox_iou': config.reviewRules.minBboxIou,
    'pattern.dark_dot_min_confirmations': config.reviewRules.darkDotMinConfirmations,
    'pattern.bright_dot_min_confirmations': config.reviewRules.brightDotMinConfirmations,
    'pattern.line_min_confirmations': config.reviewRules.lineMinConfirmations,
    'knn.k': config.drivingAbnormality.knnK,
    'knn.min_similarity': config.drivingAbnormality.minSimilarity,
    'knn.min_train_panels': config.drivingAbnormality.minTrainingPanels,
  };
}

export function validateThresholdConfig(raw: unknown): ThresholdValidation {
  if (isLegacySettings(raw)) {
    const sanitized = sanitizeSettings(raw);
    if (sanitized.repaired.length > 0) {
      return { ok: false, errors: sanitized.repaired, migratedLegacy: true };
    }
    return {
      ok: true,
      config: createThresholdConfig(sanitized.settings),
      errors: [],
      migratedLegacy: true,
    };
  }

  const candidate = raw as Partial<ThresholdConfig> | null;
  const errors: string[] = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['임계값 구성 객체가 아닙니다.'], migratedLegacy: false };
  }
  if (candidate.schemaVersion !== THRESHOLD_SCHEMA_VERSION) errors.push('지원하지 않는 schemaVersion입니다.');
  if (typeof candidate.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(candidate.version)) {
    errors.push('version은 x.y.z 형식이어야 합니다.');
  }
  if (typeof candidate.updatedAt !== 'string' || Number.isNaN(Date.parse(candidate.updatedAt))) {
    errors.push('updatedAt이 유효한 ISO 날짜가 아닙니다.');
  }

  const hydrated = hydrateThresholdConfig(candidate as ThresholdConfig);
  let settings: Settings | null = null;
  try {
    settings = thresholdConfigToSettings(hydrated);
  } catch {
    errors.push('필수 임계값 section 또는 값이 없습니다.');
  }
  if (settings) {
    const sanitized = sanitizeSettings(settings);
    if (sanitized.repaired.length > 0 || !sameSettings(settings, sanitized.settings)) {
      errors.push(...sanitized.repaired, '임계값이 허용 범위를 벗어나거나 누락되었습니다.');
    }
  }
  if (hydrated.brightLine?.sharedGeometryVersion !== 'darkLine') {
    errors.push('brightLine.sharedGeometryVersion은 darkLine이어야 합니다.');
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)], migratedLegacy: false };
  return { ok: true, config: hydrated, errors: [], migratedLegacy: false };
}

export function duplicateThresholdConfig(config: ThresholdConfig, updatedBy = ''): ThresholdConfig {
  const parts = config.version.split('.').map(Number);
  const version = `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
  return createThresholdConfig(thresholdConfigToSettings(config), version, updatedBy);
}

function isLegacySettings(raw: unknown): boolean {
  return Boolean(
    raw &&
    typeof raw === 'object' &&
    !('schemaVersion' in raw) &&
    Object.keys(DEFAULT_SETTINGS).some((key) => key in raw),
  );
}

function sameSettings(a: Settings, b: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every(
    (key) => typeof a[key] === 'number' && Number.isFinite(a[key]) && a[key] === b[key],
  );
}

/** Add fields introduced after v1 without discarding an operator's tuned values. */
function hydrateThresholdConfig(candidate: ThresholdConfig): ThresholdConfig {
  const defaults = createThresholdConfig(DEFAULT_SETTINGS, candidate.version, candidate.updatedBy, candidate.updatedAt);
  return {
    ...defaults,
    ...candidate,
    preprocessing: { ...defaults.preprocessing, ...candidate.preprocessing },
    darkDot: { ...defaults.darkDot, ...candidate.darkDot },
    brightDot: { ...defaults.brightDot, ...candidate.brightDot },
    darkLine: { ...defaults.darkLine, ...candidate.darkLine },
    brightLine: { ...defaults.brightLine, ...candidate.brightLine },
    noDisplay: { ...defaults.noDisplay, ...candidate.noDisplay },
    partialNoDisplay: { ...defaults.partialNoDisplay, ...candidate.partialNoDisplay },
    drivingAbnormality: { ...defaults.drivingAbnormality, ...candidate.drivingAbnormality },
    reviewRules: { ...defaults.reviewRules, ...candidate.reviewRules },
  };
}
