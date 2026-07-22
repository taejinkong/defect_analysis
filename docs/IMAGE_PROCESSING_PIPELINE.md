# Image Processing Pipeline

## 처리 순서

1. 원본 Blob을 RGBA로 decode하고 원래 폭·높이를 보존한다.
2. `max(R,G,B)` intensity를 blur한 뒤 Otsu와 최대 연결 성분으로 Active 후보를 찾는다.
3. 구멍을 채우고 강건 최소제곱 원 피팅, 방사 gradient 경계 보정을 적용한다.
4. 외곽 intensity profile로 FPCB 방향과 robust-sigma 신뢰도를 계산한다.
5. FPCB가 6시가 되도록 역방향 bilinear sampling해 512×512로 정규화한다.
6. Active 반지름 250px의 0.98배 mask를 만든다.
7. Black=`max(R,G,B)`, White=`min(R,G,B)` 신호에 별도 강건 2차 곡면을 피팅한다.
8. dark/bright residual과 후보 mask를 만든다.
9. 품질 수치와 PASS/REVIEW/FAIL을 계산하고 `preprocessingResults`에 저장한다.
10. 원본 Active 지름이 설정값 이상이면 최대 1024px 정규화 ROI에서 행/열 projection Line 보조 검출을 실행하고 결과를 512 좌표로 환산한다.

원본은 resize/overwrite하지 않는다. batch 분석에서는 residual 배열을 보관하지 않고, 상세 검수 화면을
열 때만 다시 계산해 암부/명부 residual canvas로 보여준다.

## 품질 수치

- Active 검출 성공, 중심/반지름, 중심 offset, radius confidence, circularity
- FPCB 신뢰도, 적용 회전각, 원 경계 clipping ratio
- Laplacian blur score, 평균/표준편차, 전체/배경/결함 내부 RGB 동시 포화 비율
- Active mask coverage, 패턴 완전도

Active geometry가 전혀 없으면 FAIL이며 최종 자동 판정을 만들지 않는다. 미점등 이미지가 정상 형제
패턴의 geometry를 빌린 경우에는 REVIEW로 남겨 Engineer가 확인할 수 있게 한다.

실제 미점등 자동 확정에는 업로드 당시와 일치하는 검증 완료 Capture Profile과 Model/Pattern Golden 범위가 필요하다. 조건이 없으면 `UNDEREXPOSED_REVIEW`와 Sorting `HOLD`로 남긴다.
