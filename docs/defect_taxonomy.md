# Defect Taxonomy

## 1. Defect Master List

`is_labelable = Y` 인 항목만 사람이 이미지 위에 직접 라벨링할 수 있다.
`양품(D000)`과 `복수불량(D011)`은 라벨이 아니라 **패널 단위 최종 판정에서 파생되는 값**이므로 라벨링 대상이 아니다.

| defect_id | defect_name | category | description | classification_type | is_labelable | severity |
|---|---|---|---|---|---|---|
| D000 | 양품 | Normal | 검출된 불량 없음 | Derived | N | 0 |
| D001 | 암점 小 | Dark Dot | Active 영역 대비 암점 면적 0% 초과 ~ 5% 이하 | Area Detection | Y | 1 |
| D002 | 암점 中 | Dark Dot | Active 영역 대비 암점 면적 5% 초과 ~ 15% 이하 | Area Detection | Y | 2 |
| D003 | 암점 大 | Dark Dot | Active 영역 대비 암점 면적 15% 초과 | Area Detection | Y | 3 |
| D004 | 명점 | Bright Dot | 주변 대비 밝은 점 불량 | Blob Detection | Y | 2 |
| D005 | 명선_가로줄 | Bright Line | 가로 방향 밝은 Line 불량 | Line Detection | Y | 3 |
| D006 | 명선_세로줄 | Bright Line | 세로 방향 밝은 Line 불량 | Line Detection | Y | 3 |
| D007 | 암선_가로줄 | Dark Line | 가로 방향 어두운 Line 불량 | Line Detection | Y | 3 |
| D008 | 암선_세로줄 | Dark Line | 세로 방향 어두운 Line 불량 | Line Detection | Y | 3 |
| D009 | 구동불량 | Driving Defect | 전기적 신호 이상에 의한 비정상 구동 | Classification | Y | 4 |
| D010 | 미점등 | No Display | 전체 또는 부분 미점등 | Area/Classification | Y | 4 |
| D011 | 복수불량 | Multi Defect | 2개 이상 불량 동시 발생 | Derived | N | 4 |

`severity`가 높을수록 중대한 불량이며, 패널의 **Primary Defect**를 고를 때 tie-breaker로 사용한다.

## 2. Dark Dot Classification Rule

암점은 개수 기준이 아니라 Active Display 영역 대비 암점 Mask의 **총 면적 비율**로 판정한다.

```text
dark_area_ratio = dark_defect_mask_area_px / active_display_area_px * 100
```

| 조건 | 판정 |
|---|---|
| `dark_area_ratio == 0` | 암점 없음 |
| `0 < dark_area_ratio <= 5` | 암점 小 (D001) |
| `5 < dark_area_ratio <= 15` | 암점 中 (D002) |
| `dark_area_ratio > 15` | 암점 大 (D003) |

경계값은 하한 배타 / 상한 포함(`(lo, hi]`)으로 통일한다. 임계값 5와 15는 `app_setting` 테이블에서 조정 가능하다.

`dark_defect_mask_area_px`는 R/G/B/W 4개 패턴에서 각각 계산한 뒤 **최댓값**을 채택한다.
암점은 4개 패턴 모두에서 나타나야 정상이나, 패턴별 노출 차이로 검출 면적이 달라지므로 가장 크게 검출된 값을 대표값으로 본다.

## 3. Line Rule

Line 불량은 잔차(residual) 이미지에서 방향성 형태학 연산으로 검출한다.

- 부호가 양수(주변보다 밝음)이면 명선, 음수이면 암선
- 성분의 주축 각도가 수평 ±20° 이내이면 가로줄, 수직 ±20° 이내이면 세로줄
- 성분의 bbox 종횡비 `>= 8` 이고 길이가 Active 영역 지름의 `40%` 이상일 때만 Line으로 인정한다
- 위 조건을 만족하지 못하면 Dot(명점/암점) 계열로 재분류한다

임계값 `8`, `40%`, `±20°`는 `app_setting`에서 조정 가능하다.

## 4. No Display Rule

- **전체 미점등**: Active 영역 내 평균 휘도가 `T_off` 미만
- **부분 미점등**: 단일 연결 암부 영역이 Active 영역의 `60%` 이상

부분 미점등과 `암점 大`는 면적 기준이 겹칠 수 있다. 60% 이상이면 미점등(D010)이 우선한다.

## 5. Location Rule

FPCB / Bending 방향은 **사진 기준 6시 방향**을 기준축으로 고정한다.
업로드 이미지의 방향은 보장되지 않으므로, 전처리 단계에서 회전 보정을 적용해 FPCB를 6시로 정렬한 뒤 좌표를 계산한다.

Active 영역의 중심을 `(cx, cy)`, 반지름을 `R`, 불량의 대표점을 `(x, y)`라 할 때:

```text
dx = x - cx
dy = y - cy                      # 화면 좌표계, y는 아래로 증가
r_ratio   = sqrt(dx^2 + dy^2) / R          # 0.0 (중심) ~ 1.0 (외곽)
angle_deg = degrees(atan2(-dx, dy)) mod 360
```

`angle_deg`는 **6시 방향이 0°이며 시계 방향으로 증가**한다.
시계 방향 시각으로 환산하면 `hour = (6 + angle_deg / 30) mod 12` 이다.

| angle_deg | 시계 방향 |
|---|---|
| 0° | 6시 (FPCB) |
| 90° | 9시 |
| 180° | 12시 |
| 270° | 3시 |

Region은 `r_ratio`로 구분한다.

| r_ratio | region |
|---|---|
| `0.00 ~ 0.35` | center |
| `0.35 ~ 0.75` | mid |
| `0.75 ~ 1.00` | edge |

## 6. Multi Defect Rule

하나의 Panel에서 서로 다른 `defect_id` 가 2개 이상 검출되면 `final_judgement`는 `복수불량(D011)`로 표시한다.
단, 개별 불량 Label은 `annotation` 테이블에 모두 그대로 저장한다.

- 같은 `defect_id`가 여러 개(예: 명점 3개) 검출된 것은 복수불량이 아니다. **불량 종류가 2개 이상**일 때만 복수불량이다.
- 암점 小/中/大는 서로 배타적이다. 면적 합산으로 하나의 등급만 부여되므로 동시에 나올 수 없다.
- `Primary Defect`는 검출된 불량 중 `severity`가 가장 높은 것으로 하고, 동률이면 면적이 큰 것을 택한다.

## 7. Judgement Decision Order

패널 최종 판정은 다음 순서로 결정한다. 앞 단계에서 확정되면 뒤 단계는 평가하지 않는다.

1. 전체 미점등 → `미점등`
2. 검출된 불량 종류 수 `>= 2` → `복수불량`
3. 검출된 불량 종류 수 `== 1` → 해당 불량명
4. 검출된 불량 없음 → `양품`
