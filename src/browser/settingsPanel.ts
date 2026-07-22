import type { Settings, SettingKey } from '../core/settings';
import {
  DEFAULT_SETTINGS,
  SETTING_GROUPS,
  SETTING_SPECS,
  changedKeys,
  formatSetting,
  sanitizeSettings,
} from '../core/settings';
import {
  createThresholdConfig,
  duplicateThresholdConfig,
  thresholdConfigToSettings,
  validateThresholdConfig,
  type ThresholdConfig,
} from '../core/thresholdConfig';

const STORAGE_KEY = 'defect-analysis.threshold-config.v2';
const LEGACY_STORAGE_KEY = 'defect-analysis.settings.v1';

/**
 * Load tuned thresholds from this browser.
 *
 * IndexedDB and localStorage both vanish when the user clears site data, so the
 * JSON export is the only durable copy. The panel says so.
 */
export function loadThresholdConfig(): ThresholdConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const validated = validateThresholdConfig(JSON.parse(raw));
      if (validated.ok && validated.config) return validated.config;
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const validated = validateThresholdConfig(JSON.parse(legacy));
      if (validated.ok && validated.config) return validated.config;
    }
  } catch {
    // Fall through to the shipped versioned defaults.
  }
  return createThresholdConfig(DEFAULT_SETTINGS);
}

export function loadSettings(): Settings {
  return thresholdConfigToSettings(loadThresholdConfig());
}

function persist(config: ThresholdConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private browsing or a full quota. Tuning still works for this session.
  }
}

export interface SettingsPanelHandlers {
  /** Fires on every slider move. Keep it cheap; it drives the live preview. */
  readonly onChange: (settings: Settings) => void;
  /** Fires when a change settles, for work too heavy to run per-frame. */
  readonly onCommit: (settings: Settings) => void;
}

export interface SettingsPanel {
  readonly element: HTMLElement;
  get(): Settings;
  getConfig(): ThresholdConfig;
}

export function createSettingsPanel(
  initial: Settings,
  handlers: SettingsPanelHandlers,
  initialConfig: ThresholdConfig = createThresholdConfig(initial),
): SettingsPanel {
  let settings: Settings = initial;
  let config = initialConfig;
  const inputs = new Map<SettingKey, { range: HTMLInputElement; readout: HTMLElement }>();

  const root = document.createElement('details');
  root.className = 'settings';

  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = '임계값 조절';
  const changedBadge = document.createElement('span');
  changedBadge.className = 'settings-changed';
  const versionBadge = document.createElement('span');
  versionBadge.className = 'settings-changed';
  summary.append(title, versionBadge, changedBadge);
  root.append(summary);

  const note = document.createElement('p');
  note.className = 'settings-note';
  note.textContent =
    '기본값은 합성 이미지로 고른 추정치입니다. 실제 점등 이미지를 열고 검출 박스를 보며 맞춘 뒤, JSON으로 내보내 주세요. 이 브라우저의 저장소를 지우면 값이 사라집니다.';
  root.append(note);

  const body = document.createElement('div');
  body.className = 'settings-body';

  for (const groupName of SETTING_GROUPS) {
    const group = document.createElement('fieldset');
    group.className = 'settings-group';
    const legend = document.createElement('legend');
    legend.textContent = groupName;
    group.append(legend);

    for (const spec of SETTING_SPECS.filter((s) => s.group === groupName)) {
      const row = document.createElement('div');
      row.className = 'settings-row';

      const label = document.createElement('label');
      label.htmlFor = `set-${spec.key}`;
      label.textContent = spec.label;

      const readout = document.createElement('span');
      readout.className = 'settings-value';
      readout.textContent = formatSetting(spec.key, settings[spec.key]);

      const head = document.createElement('div');
      head.className = 'settings-head';
      head.append(label, readout);

      const range = document.createElement('input');
      range.type = 'range';
      range.id = `set-${spec.key}`;
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.value = String(settings[spec.key]);
      range.title = spec.hint;

      const hint = document.createElement('p');
      hint.className = 'settings-hint';
      hint.textContent = spec.hint;

      range.addEventListener('input', () => {
        apply({ ...settings, [spec.key]: Number(range.value) }, spec.key);
        handlers.onChange(settings);
      });
      range.addEventListener('change', () => handlers.onCommit(settings));

      row.append(head, range, hint);
      group.append(row);
      inputs.set(spec.key, { range, readout });
    }
    body.append(group);
  }

  const actions = document.createElement('div');
  actions.className = 'settings-actions';

  const resetBtn = button('기본값 복원', 'ghost', () => {
    apply(DEFAULT_SETTINGS);
    handlers.onChange(settings);
    handlers.onCommit(settings);
  });

  const exportBtn = button('JSON 내보내기', 'ghost', () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `defect-thresholds-${new Date().toISOString().slice(0, 10)}.json`;
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
    void file.text().then((text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        alert('JSON을 읽을 수 없습니다.');
        return;
      }
      const validated = validateThresholdConfig(parsed);
      if (!validated.ok || !validated.config) {
        alert(`임계값 파일을 적용하지 않았습니다:\n\n${validated.errors.join('\n')}`);
        return;
      }
      config = validated.config;
      const next = thresholdConfigToSettings(config);
      apply(next, undefined, true);
      handlers.onChange(settings);
      handlers.onCommit(settings);
      if (validated.migratedLegacy) alert('이전 형식 임계값을 버전 1.0.0 구성으로 변환했습니다.');
    });
  });

  const importBtn = button('JSON 가져오기', 'ghost', () => importInput.click());
  const duplicateBtn = button('버전 복제', 'ghost', () => {
    config = duplicateThresholdConfig(config);
    persist(config);
    versionBadge.textContent = `활성 v${config.version}`;
    handlers.onCommit(settings);
  });

  actions.append(resetBtn, duplicateBtn, exportBtn, importBtn, importInput);
  body.append(actions);
  root.append(body);

  /**
   * Write `next` into the widgets. `origin` is the slider the user is dragging;
   * skipping its own value keeps the thumb from jumping when a constraint
   * repair rewrites a *different* key.
   */
  function apply(next: Settings, origin?: SettingKey, preserveImportedConfig = false): void {
    const { settings: clean } = sanitizeSettings(next);
    settings = clean;
    if (!preserveImportedConfig) {
      config = createThresholdConfig(settings, config.version, config.updatedBy);
    }
    persist(config);

    for (const [key, { range, readout }] of inputs) {
      const value = settings[key];
      if (key !== origin) range.value = String(value);
      readout.textContent = formatSetting(key, value);
      readout.classList.toggle('is-changed', value !== DEFAULT_SETTINGS[key]);
    }

    const changed = changedKeys(settings).length;
    changedBadge.textContent = changed > 0 ? `${changed}개 변경됨` : '';
    changedBadge.hidden = changed === 0;
    versionBadge.textContent = `활성 v${config.version}`;
  }

  apply(settings);
  return { element: root, get: () => settings, getConfig: () => config };
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  el.addEventListener('click', onClick);
  return el;
}
