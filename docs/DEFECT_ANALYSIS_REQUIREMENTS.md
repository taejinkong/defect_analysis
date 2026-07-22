# Defect Analysis Requirements

## 목적과 경계

이 앱은 Watch Display Engineer의 R/G/B/W 점등 검사 편차를 줄이고 판정 근거를 추적하기 위한
오프라인 보조 도구다. 자동 결과는 최종 품질 판정을 대체하지 않으며, 품질 범위 밖·판정 충돌·낮은
신뢰도·복수불량은 Engineer 검수 큐로 보낸다.

## 필수 동작

- 원본 이미지는 IndexedDB에 Blob으로 보존하며 외부로 전송하지 않는다.
- Active Area를 원으로 검출하고 FPCB를 6시로 정렬한 512×512 좌표계를 사용한다.
- R/G/B/W를 패널 단위로 묶고 위치·방향이 일치하는 후보를 상관 분석한다.
- 지원 판정은 양품, 암점 小/中/大, 명점, 명선 가로/세로, 암선 가로/세로, 구동불량 검토,
  미점등, 복수불량이다.
- 복수불량이어도 개별 detection evidence를 삭제하거나 합치지 않는다.
- 자동 판정, Engineer correction, threshold/detector version을 서로 분리해 저장한다.
- Capture/Golden profile version과 `OK/NG/HOLD`를 저장하고 누락·실패·미검증 상태는 HOLD로 제한한다.
- 실제 PLC/MES 물리 Sorting은 이 정적 앱의 범위가 아니다.

## 역할

- Admin: 임계값, 삭제, 학습 승인, 분석 및 대시보드 관리
- Reviewer: 분석, 상세 확인, 라벨 교정 및 판정 승인/반려
- Viewer: 저장된 결과와 대시보드 열람

인증 서버가 없는 MVP이므로 역할은 현재 브라우저 localStorage의 workflow 표시 모드다. 사용자 인증이나
보안 접근 통제로 간주하지 않는다.

## 검증 경고

자동 테스트는 합성 fixture 기준이다. 실물 정확도, 생산 수율 개선, 원인 인과관계는 검증된 것으로
표현하지 않는다. 실물 ground truth 없이는 precision/recall/F1을 제공하지 않는다.
