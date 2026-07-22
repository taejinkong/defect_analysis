import {
  DEFAULT_INSPECTION_PROFILE,
  validateInspectionProfile,
  type InspectionProfile,
  type PatternReferenceRange,
} from '../core/inspectionProfile';
import type { Pattern } from '../core/types';

const STORAGE_KEY = 'defect-analysis.inspection-profile.v1';

export function loadInspectionProfile(): InspectionProfile {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const result = validateInspectionProfile(JSON.parse(stored));
      if (result.ok && result.profile) return result.profile;
    }
  } catch {
    // Use a safe, explicitly unvalidated profile.
  }
  return DEFAULT_INSPECTION_PROFILE;
}

export interface InspectionProfilePanel {
  readonly element: HTMLElement;
  get(): InspectionProfile;
}

export function createInspectionProfilePanel(
  initial: InspectionProfile,
  onChange: (profile: InspectionProfile) => void,
): InspectionProfilePanel {
  let profile = initial;
  const root = document.createElement('details');
  root.className = 'settings inspection-profile';

  const summary = document.createElement('summary');
  summary.textContent = '검사 프로파일 · 촬영/Golden/Sorting';
  root.append(summary);

  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent = '자동 노출·AWB·HDR을 잠그고 정상 패널로 검증한 버전만 자동 미점등 판정에 사용합니다. 오류·누락은 항상 HOLD로 처리합니다.';
  root.append(note);

  const body = document.createElement('div');
  body.className = 'settings-body profile-grid';

  const capture = fieldset('촬영 프로파일');
  const captureVersion = textField(capture, '버전', profile.capture.version);
  const cameraModel = textField(capture, '카메라', profile.capture.cameraModel);
  const lensId = textField(capture, '렌즈', profile.capture.lensId);
  const distanceMm = numberField(capture, '촬영 거리(mm)', profile.capture.distanceMm, 0, 10000, 1);
  const viewAngleDeg = numberField(capture, '촬영 각도(°)', profile.capture.viewAngleDeg, -90, 90, 0.1);
  const exposureMs = numberField(capture, '노출(ms)', profile.capture.exposureMs, 0, 10000, 0.01);
  const gain = numberField(capture, 'Gain/ISO', profile.capture.gain, 0, 100000, 0.1);
  const gamma = numberField(capture, 'Gamma', profile.capture.gamma, 0.1, 5, 0.01);
  const bitDepth = numberField(capture, 'Bit depth', profile.capture.bitDepth, 8, 32, 1);
  const fileFormat = document.createElement('select');
  for (const value of ['PNG', 'RAW', 'JPEG', 'OTHER'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    fileFormat.append(option);
  }
  fileFormat.value = profile.capture.fileFormat;
  const formatLabel = document.createElement('label');
  formatLabel.textContent = '파일 형식';
  formatLabel.append(fileFormat);
  capture.append(formatLabel);
  const environment = textField(capture, '환경/차광', profile.capture.environment);
  const calibrationVersion = textField(capture, '보정 버전', profile.capture.calibrationVersion);
  const darkFrameVersion = textField(capture, 'Dark-frame', profile.capture.darkFrameVersion);
  const flatFieldVersion = textField(capture, 'Flat-field', profile.capture.flatFieldVersion);
  const autoExposure = checkField(capture, '자동 노출 사용', profile.capture.autoExposure);
  const autoWhiteBalance = checkField(capture, '자동 화이트밸런스 사용', profile.capture.autoWhiteBalance);
  const hdr = checkField(capture, 'HDR 사용', profile.capture.hdr);
  const captureValidated = checkField(capture, '정상 패널 검증 완료', profile.capture.validated);
  body.append(capture);

  const golden = fieldset('Golden 기준');
  const goldenVersion = textField(golden, '버전', profile.golden.version);
  const goldenModel = textField(golden, '대상 Model', profile.golden.model);
  const referenceSetId = textField(golden, 'Reference Set ID/Hash', profile.golden.referenceSetId);
  const goldenValidated = checkField(golden, '정합·휘도 범위 검증 완료', profile.golden.validated);
  const rangeInputs = new Map<Pattern, { min: HTMLInputElement; max: HTMLInputElement; saturation: HTMLInputElement }>();
  for (const pattern of ['R', 'G', 'B', 'W'] as const) {
    const range = profile.golden.ranges[pattern];
    const row = document.createElement('div');
    row.className = 'profile-range';
    const label = document.createElement('strong');
    label.textContent = pattern;
    const min = numberInput(range.minMean, 0, 255, 1, '평균 하한');
    const max = numberInput(range.maxMean, 0, 255, 1, '평균 상한');
    const saturation = numberInput(range.maxBackgroundSaturationRatio, 0, 1, 0.01, '배경 포화 상한');
    row.append(label, min, max, saturation);
    golden.append(row);
    rangeInputs.set(pattern, { min, max, saturation });
  }
  body.append(golden);

  const operation = fieldset('운영 범위');
  const mode = document.createElement('select');
  for (const [value, label] of [
    ['DECISION_SUPPORT', '판정 지원(엔지니어 승인)'],
    ['SORTING_EXPORT', 'Sorting 결과 내보내기'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  mode.value = profile.mode;
  const modeLabel = document.createElement('label');
  modeLabel.textContent = '모드';
  modeLabel.append(mode);
  const hold = document.createElement('p');
  hold.className = 'settings-hint';
  hold.textContent = '전처리 실패, 패턴 누락, 미검증 프로파일, 판정 충돌은 OK가 아니라 HOLD로 내보냅니다.';
  operation.append(modeLabel, hold);
  body.append(operation);

  const status = document.createElement('p');
  status.className = 'settings-note';
  body.append(status);

  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  const applyButton = button('검사 프로파일 저장', () => applyFromForm());
  const resetButton = button('안전 기본값 복원', () => {
    profile = DEFAULT_INSPECTION_PROFILE;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    onChange(profile);
    location.reload();
  });
  const exportButton = button('JSON 내보내기', () => {
    applyFromForm();
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspection-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.hidden = true;
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    void file.text().then((value) => {
      try {
        const result = validateInspectionProfile(JSON.parse(value));
        if (!result.ok || !result.profile) throw new Error(result.errors.join('\n'));
        profile = result.profile;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
        onChange(profile);
        location.reload();
      } catch (error) {
        alert(`검사 프로파일을 적용하지 않았습니다.\n\n${String(error)}`);
      }
    });
  });
  const importButton = button('JSON 가져오기', () => importInput.click());
  actions.append(applyButton, resetButton, exportButton, importButton, importInput);
  body.append(actions);
  root.append(body);

  function applyFromForm(): void {
    const ranges = {} as Record<Pattern, PatternReferenceRange>;
    for (const pattern of ['R', 'G', 'B', 'W'] as const) {
      const inputs = rangeInputs.get(pattern)!;
      ranges[pattern] = {
        minMean: Number(inputs.min.value),
        maxMean: Number(inputs.max.value),
        maxBackgroundSaturationRatio: Number(inputs.saturation.value),
      };
    }
    const candidate: InspectionProfile = {
      ...profile,
      capture: {
        ...profile.capture,
        version: captureVersion.value.trim(),
        cameraModel: cameraModel.value.trim(),
        lensId: lensId.value.trim(),
        distanceMm: Number(distanceMm.value),
        viewAngleDeg: Number(viewAngleDeg.value),
        exposureMs: Number(exposureMs.value),
        gain: Number(gain.value),
        gamma: Number(gamma.value),
        bitDepth: Number(bitDepth.value),
        fileFormat: fileFormat.value as InspectionProfile['capture']['fileFormat'],
        environment: environment.value.trim(),
        calibrationVersion: calibrationVersion.value.trim(),
        darkFrameVersion: darkFrameVersion.value.trim(),
        flatFieldVersion: flatFieldVersion.value.trim(),
        autoExposure: autoExposure.checked,
        autoWhiteBalance: autoWhiteBalance.checked,
        hdr: hdr.checked,
        validated: captureValidated.checked,
      },
      golden: {
        ...profile.golden,
        version: goldenVersion.value.trim(),
        model: goldenModel.value.trim(),
        captureProfileVersion: captureVersion.value.trim(),
        referenceSetId: referenceSetId.value.trim(),
        validated: goldenValidated.checked,
        ranges,
      },
      mode: mode.value as InspectionProfile['mode'],
      failSafeDisposition: 'HOLD',
    };
    const result = validateInspectionProfile(candidate);
    if (!result.ok || !result.profile) {
      status.textContent = result.errors.join(' · ');
      status.classList.add('danger-text');
      return;
    }
    profile = result.profile;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    status.textContent = '저장되었습니다. 이후 업로드·분석 결과에 이 버전이 기록됩니다.';
    status.classList.remove('danger-text');
    onChange(profile);
  }

  return { element: root, get: () => profile };
}

function fieldset(title: string): HTMLFieldSetElement {
  const el = document.createElement('fieldset');
  el.className = 'settings-group';
  const legend = document.createElement('legend');
  legend.textContent = title;
  el.append(legend);
  return el;
}

function textField(parent: HTMLElement, labelText: string, value: string): HTMLInputElement {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  label.append(input);
  parent.append(label);
  return input;
}

function checkField(parent: HTMLElement, labelText: string, checked: boolean): HTMLInputElement {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.append(input, document.createTextNode(labelText));
  parent.append(label);
  return input;
}

function numberField(
  parent: HTMLElement,
  labelText: string,
  value: number,
  min: number,
  max: number,
  step: number,
): HTMLInputElement {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = numberInput(value, min, max, step, labelText);
  label.append(input);
  parent.append(label);
  return input;
}

function numberInput(value: number, min: number, max: number, step: number, title: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.title = title;
  input.setAttribute('aria-label', title);
  return input;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'ghost';
  el.textContent = text;
  el.addEventListener('click', onClick);
  return el;
}
