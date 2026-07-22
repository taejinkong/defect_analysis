# Defect Detection Logic

## Detector 계약

`src/core/detectors.ts`의 `DefectDetector`는 id, name, semantic version, 지원 패턴, `detect()`를 가진다.
현재 Dark Dot, Bright Dot, Dark Line, Bright Line detector가 이 계약으로 후보를 분배한다.

모든 결과에는 detector/threshold version, source pattern, bbox/centroid, 정규화 x/y/r/angle, 면적비,
평균·최대 contrast, confidence, Rule/kNN 결과, 자동 제안, 검수 상태와 사유가 붙는다.

## Black / White 물리 신호

- 암점·암선은 모든 채널이 내려간 Black이므로 `max(R,G,B)`의 음의 residual을 사용한다.
- 명점·명선은 모든 채널이 올라간 White이므로 `min(R,G,B)`의 양의 residual을 사용한다.
- W는 white-on-white 대비가 작아 별도 threshold를 사용한다.

## 형상과 등급

연결 성분의 최소 외접 사각형으로 길이·두께·종횡비·주축 방향을 계산한다. 충분히 긴 두꺼운 Line에는
완화된 종횡비 기준을 적용한다. 암점 등급은 개별 점 개수가 아니라 같은 위치에서 교차 확인된 Black
component의 패턴별 합산 면적 중 최댓값으로 小/中/大 하나를 정한다.

큰 원본은 최대 1024px ROI에서 residual 행/열 projection을 추가 계산한다. 최소 길이, 연속성, gap ratio,
두께, edge contact를 만족한 Line만 512 좌표로 환산하며 evidence에 `high-resolution-projection`을 기록한다.

## 패널 상관

중심 거리, bbox IoU, 면적 유사도와 Line 주축 차이를 함께 본다. 확인 수는 암점/명점/Line별 설정값이다.
단일 패턴 허용 후보는 판정에서 버리지 않되 `PATTERN_ONLY_DEFECT`로 검수한다.

## 미점등과 구동불량

전체 미점등은 Active 평균 신호, 부분 미점등은 큰 연속 Black 영역 비율을 사용한다. 구동불량은 행/열
주기성 등 Engineer-readable feature만 표시하며 충분한 실물 검증 전에는 검수 확인이 필수다.

전체 미점등 자동 확정에는 검증된 Capture/Golden profile과 일치하는 Model이 필요하다. 아니면
`UNDEREXPOSED_REVIEW`로 남기고 Sorting disposition은 HOLD다.
