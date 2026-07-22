# Threshold Configuration

활성 임계값은 `ThresholdConfig` JSON이며 `schemaVersion`, semantic `version`, `updatedAt`, `updatedBy`와
전처리·암점·명점·Line·미점등·구동 검토·review rule section으로 구성된다.

Line section에는 고해상도 분석 시작 지름, 최소 연속성, 최대 gap ratio가 포함된다. review rule에는
암점/명점/Line별 교차 확인 수, 면적 유사도와 bbox IoU가 포함된다. 기존 v1 JSON에 새 필드가 없으면
operator가 튜닝한 기존 값은 보존하고 새 필드만 안전 기본값으로 hydrate한다.

촬영/Golden/Sorting 설정은 threshold와 별도인 versioned `InspectionProfile` JSON으로 관리한다.

## 안전 규칙

- UI slider 정의는 `src/core/settings.ts` 한 곳에만 있다.
- import는 모든 필수 숫자, 허용 범위, 상호 경계를 검사한다.
- 잘못된 versioned JSON은 현재 active config를 절대 덮어쓰지 않는다.
- 이전 flat settings JSON은 유효할 때만 v1.0.0으로 migration한다.
- `버전 복제`는 patch version을 올린 별도 config를 만든다.
- 분석 시작 시 active threshold version을 preprocessing/detection/panel decision에 첨부한다.

기본값은 합성 이미지용 시작점이며 생산 기준이 아니다. 실물 튜닝 후 JSON을 별도 보관해야 한다.
