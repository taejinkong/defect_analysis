# Data Model and Migration

## IndexedDB

DB 이름은 `defect_analysis`, 현재 DB version은 4다.

| Store | 용도 |
|---|---|
| `panels` | Lot/Panel/Model/공정/설비/용도/검수 상태 |
| `images` | 원본 Blob, 패턴, 원/FPCB geometry, 파일명, real/synthetic source |
| `annotations` | Engineer의 개별 수동 라벨과 정규화 위치 |
| `embeddings` | 승인 학습 패널의 versioned kNN vector |
| `preprocessingResults` | 이미지별 품질 수치와 PASS/REVIEW/FAIL |
| `detectionResults` | component별 자동 검출 근거 |
| `panelDecisions` | Rule/kNN/일치 상태/자동 제안/검수 사유 |
| `thresholdConfigs` | versioned 임계값 구성과 active 상태 |
| `reviews` | 원 자동 판정과 분리된 Engineer 최종 라벨·메모·일시 |

기존 store에는 비파괴 optional field로 Capture/Golden profile version, Sorting disposition, Line continuity/gap/analysis scale, 원본 매핑과 audit history가 추가된다. 이전 row는 그대로 읽히며 재분석·재매핑 시 새 evidence가 채워진다.

## 마이그레이션

- v1→v2: `embeddings` 추가
- v2→v3: 전처리·검출·패널 판정·임계값 store 추가
- v3→v4: `reviews` 추가

`onupgradeneeded`는 존재하지 않는 store만 생성한다. 기존 store를 삭제하거나 clear하지 않으며, 기존
패널은 재분석할 때 새 evidence가 채워진다. entity에는 `schemaVersion`, `createdAt`, `updatedAt`이 있다.

## 좌표

정규화 중심은 (256,256), 반지름은 250이다. 6시는 0°, 시계방향 양수다. evidence는 pixel 좌표와
`xRatio`, `yRatio`, `rRatio`, `angleDeg`, `region`, bbox, centroid, mask area를 함께 저장한다.

`panelDecisions.sortingDisposition`은 `OK | NG | HOLD`다. 검수·누락·실패·미검증 상태는 항상 HOLD다.
