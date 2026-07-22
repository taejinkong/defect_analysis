# Validation Guide

## 자동 검증

`npm test`는 원 검출/실패, 회전 좌표, 파일명 grouping, 품질 status, Black/White 신호, 점·선·미점등,
패턴 상관, 암점 면적 경계, Rule+kNN fusion, review reason, threshold validation, DB migration과 대시보드를
합성 fixture로 검증한다. `npm run build`는 type check 후 외부 asset 없는 단일 HTML을 만든다.

## 실물 검증 데이터 분리

이미지는 `synthetic` flag를 가진다. 대시보드는 실물/합성 패널 수를 분리해 표시한다. 합성 결과를 실물
accuracy로 합산하지 않는다.

실물 ground truth는 무작위 이미지가 아니라 **Panel 단위**, 가능하면 Lot/설비/촬영 월 단위로 분리한다.
같은 Panel 또는 근접 중복 촬영을 학습과 시험, kNN query와 neighbor에 동시에 넣지 않는다. Engineer 승인
라벨만 사용하고 중요한 경계 표본은 2인 검토와 adjudication을 권장한다.

TP/FP/TN/FN, precision, recall, F1, FPR/FNR 외에 불량 유출(false accept), 양품 오검(false reject),
95% 신뢰구간과 클래스별 표본 수를 표시한다. threshold/detector/Capture/Golden version이 없는 수치는 배포
판단에 사용하지 않는다. 앱의 검증 화면은 실물과 합성을 별도 카드로 표시하며 둘을 합산하지 않는다.

## 필수 회귀 확인

- 기존 IndexedDB v2 데이터 보존
- file:// 오프라인 실행 및 GitHub Pages 정적 실행
- 네트워크 요청 없음
- FAIL 자동 판정 차단
- 복수불량의 component evidence 보존
- Engineer correction이 원 자동 판정을 덮어쓰지 않음
