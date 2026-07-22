# Real Image Tuning Guide

1. 설정의 **검사 프로파일**에서 카메라·렌즈·고정 노출·보정 버전을 기록하고 자동 노출/AWB/HDR을 끈다.
2. Model × R/G/B/W × Capture Profile별 정상 패널 평균 휘도 범위를 Golden으로 등록한다. 반복 촬영 재현성을 확인한 뒤에만 두 프로파일을 `검증 완료`로 표시한다.
3. 양품과 각 불량의 실물 이미지를 Panel·Lot·설비·노출 조건별로 분리한다.
4. Active 원 경계와 FPCB 6시 정렬부터 확인하고 틀린 이미지는 threshold tuning에서 제외한다.
5. 전처리 품질에서 clipping, blur, 평균 휘도, 포화 비율의 양품 분포를 먼저 기록한다.
6. 양품 false positive가 사라지는 residual threshold와 실제 불량이 남는 가장 높은 threshold 사이를 찾는다.
7. W 명부는 RGB와 별도로 조정한다. **배경 포화**가 높으면 노출을 낮추고, 결함 내부의 국부 포화는 명점·명선 증거로 유지한다.
8. Line 누락은 길이·일반/두꺼운 종횡비·연속성·gap ratio·각도 순서로 조정한다. 큰 원본은 고해상도 projection 근거가 생성되는지도 확인한다.
9. R/G/B/W 동일 위치 허용거리는 실제 정렬 오차 분포보다 조금 크게, 서로 다른 먼지가 합쳐지지 않게 잡는다.
10. 암점 박스를 모두 표시하고 합집합 면적비의 현장 小/中/大 경계를 확정한다.
11. config를 새 version으로 복제한 뒤 Panel/Lot/설비/시간이 분리된 validation set에 재실행한다.
12. 진단 JSON, threshold JSON, Engineer review 결과를 함께 보관한다.

우선 확인 순서는 Active Area, FPCB, 노출/blur, 암점 FP, 명점 반사, Line continuity, 부분 미점등,
패턴 좌표 matching, 등급 경계, reviewer agreement다. 실물 표본이 충분하기 전에는 생산 정확도를 주장하지 않는다.

미검증 프로파일, 패턴 결손, 전처리 실패, 저휘도 촬영과 미점등이 구분되지 않는 경우의 Sorting 결과는 항상 `HOLD`다.
