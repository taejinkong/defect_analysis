import type { Pattern } from './types';

export const INSPECTION_PROFILE_SCHEMA_VERSION = 1;

export interface PatternReferenceRange {
  readonly minMean: number;
  readonly maxMean: number;
  /** Background clipping limit. Defect candidates are excluded from this ratio. */
  readonly maxBackgroundSaturationRatio: number;
}

export interface CaptureProfile {
  readonly schemaVersion: number;
  readonly version: string;
  readonly cameraModel: string;
  readonly lensId: string;
  readonly distanceMm: number;
  readonly viewAngleDeg: number;
  readonly exposureMs: number;
  readonly gain: number;
  readonly gamma: number;
  readonly bitDepth: number;
  readonly fileFormat: 'PNG' | 'RAW' | 'JPEG' | 'OTHER';
  readonly environment: string;
  readonly calibrationVersion: string;
  readonly darkFrameVersion: string;
  readonly flatFieldVersion: string;
  readonly autoExposure: boolean;
  readonly autoWhiteBalance: boolean;
  readonly hdr: boolean;
  /** Set only after the engineer verifies the setup against a known-good panel. */
  readonly validated: boolean;
}

export interface GoldenReferenceProfile {
  readonly schemaVersion: number;
  readonly version: string;
  readonly model: string;
  readonly captureProfileVersion: string;
  readonly registrationRequired: boolean;
  readonly ranges: Readonly<Record<Pattern, PatternReferenceRange>>;
  /** Optional identifier/hash of the locally managed reference image set. */
  readonly referenceSetId: string;
  readonly validated: boolean;
}

export interface InspectionProfile {
  readonly capture: CaptureProfile;
  readonly golden: GoldenReferenceProfile;
  readonly mode: 'DECISION_SUPPORT' | 'SORTING_EXPORT';
  readonly failSafeDisposition: 'HOLD';
}

const RANGE: PatternReferenceRange = {
  minMean: 15,
  maxMean: 245,
  maxBackgroundSaturationRatio: 0.25,
};

export const DEFAULT_INSPECTION_PROFILE: InspectionProfile = {
  capture: {
    schemaVersion: INSPECTION_PROFILE_SCHEMA_VERSION,
    version: 'capture-1.0.0',
    cameraModel: '',
    lensId: '',
    distanceMm: 0,
    viewAngleDeg: 0,
    exposureMs: 0,
    gain: 0,
    gamma: 1,
    bitDepth: 8,
    fileFormat: 'PNG',
    environment: '암실/차광 확인 필요',
    calibrationVersion: '',
    darkFrameVersion: '',
    flatFieldVersion: '',
    autoExposure: false,
    autoWhiteBalance: false,
    hdr: false,
    validated: false,
  },
  golden: {
    schemaVersion: INSPECTION_PROFILE_SCHEMA_VERSION,
    version: 'golden-1.0.0',
    model: '',
    captureProfileVersion: 'capture-1.0.0',
    registrationRequired: true,
    ranges: { R: { ...RANGE }, G: { ...RANGE }, B: { ...RANGE }, W: { ...RANGE } },
    referenceSetId: '',
    validated: false,
  },
  mode: 'DECISION_SUPPORT',
  failSafeDisposition: 'HOLD',
};

export interface InspectionProfileValidation {
  readonly ok: boolean;
  readonly profile?: InspectionProfile;
  readonly errors: string[];
}

export function validateInspectionProfile(raw: unknown): InspectionProfileValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['검사 프로파일 객체가 아닙니다.'] };
  const profile = raw as InspectionProfile;
  if (profile.capture?.schemaVersion !== INSPECTION_PROFILE_SCHEMA_VERSION) errors.push('촬영 프로파일 schemaVersion 오류');
  if (profile.golden?.schemaVersion !== INSPECTION_PROFILE_SCHEMA_VERSION) errors.push('Golden 프로파일 schemaVersion 오류');
  if (!profile.capture?.version?.trim()) errors.push('촬영 프로파일 버전이 필요합니다.');
  if (!profile.golden?.version?.trim()) errors.push('Golden 프로파일 버전이 필요합니다.');
  if (profile.golden?.captureProfileVersion !== profile.capture?.version) {
    errors.push('Golden 기준의 captureProfileVersion이 현재 촬영 프로파일과 다릅니다.');
  }
  if (!['DECISION_SUPPORT', 'SORTING_EXPORT'].includes(profile.mode)) errors.push('지원하지 않는 운영 모드입니다.');
  if (profile.failSafeDisposition !== 'HOLD') errors.push('Fail-safe 판정은 HOLD만 허용합니다.');
  for (const [label, value, min, max] of [
    ['촬영 거리', profile.capture?.distanceMm, 0, 10000],
    ['촬영 각도', profile.capture?.viewAngleDeg, -90, 90],
    ['노출', profile.capture?.exposureMs, 0, 10000],
    ['Gain', profile.capture?.gain, 0, 100000],
    ['Gamma', profile.capture?.gamma, 0.1, 5],
    ['Bit depth', profile.capture?.bitDepth, 8, 32],
  ] as const) {
    if (!finiteRange(value, min, max)) errors.push(`${label} 값이 잘못되었습니다.`);
  }
  if (profile.capture?.validated) {
    if (profile.capture.autoExposure || profile.capture.autoWhiteBalance || profile.capture.hdr) {
      errors.push('검증 완료 촬영 프로파일은 자동 노출/AWB/HDR을 사용할 수 없습니다.');
    }
    if (!profile.capture.cameraModel.trim() || !profile.capture.lensId.trim()) {
      errors.push('검증 완료에는 카메라와 렌즈 식별자가 필요합니다.');
    }
    if (profile.capture.distanceMm <= 0 || profile.capture.exposureMs <= 0) {
      errors.push('검증 완료에는 고정 촬영 거리와 노출이 필요합니다.');
    }
  }
  if (profile.golden?.validated && !profile.golden.model.trim()) errors.push('검증 완료 Golden에는 Model이 필요합니다.');

  for (const pattern of ['R', 'G', 'B', 'W'] as const) {
    const range = profile.golden?.ranges?.[pattern];
    if (!range) {
      errors.push(`${pattern} Golden 휘도 범위가 없습니다.`);
      continue;
    }
    if (!finiteRange(range.minMean, 0, 255) || !finiteRange(range.maxMean, 0, 255) || range.minMean >= range.maxMean) {
      errors.push(`${pattern} Golden 평균 휘도 범위가 잘못되었습니다.`);
    }
    if (!finiteRange(range.maxBackgroundSaturationRatio, 0, 1)) {
      errors.push(`${pattern} 배경 포화 상한이 잘못되었습니다.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile, errors: [] };
}

export function profileReadyForAutomaticNoDisplay(profile: InspectionProfile, model: string): boolean {
  return profile.capture.validated &&
    profile.golden.validated &&
    profile.golden.captureProfileVersion === profile.capture.version &&
    profile.golden.model.trim().length > 0 &&
    profile.golden.model.trim() === model.trim();
}

export function profileWarnings(profile: InspectionProfile, model: string): string[] {
  const warnings: string[] = [];
  if (profile.capture.autoExposure) warnings.push('자동 노출이 켜져 있습니다.');
  if (profile.capture.autoWhiteBalance) warnings.push('자동 화이트밸런스가 켜져 있습니다.');
  if (profile.capture.hdr) warnings.push('HDR이 켜져 있습니다.');
  if (!profile.capture.validated) warnings.push('촬영 프로파일이 검증되지 않았습니다.');
  if (!profile.golden.validated) warnings.push('Golden 기준이 검증되지 않았습니다.');
  if (profile.golden.model.trim() !== model.trim()) warnings.push('패널 Model과 Golden Model이 다릅니다.');
  if (profile.golden.captureProfileVersion !== profile.capture.version) warnings.push('Golden/촬영 프로파일 버전이 맞지 않습니다.');
  return warnings;
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
