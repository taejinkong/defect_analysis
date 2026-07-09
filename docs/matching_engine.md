# Matching Engine Specification

Rule 기반 검출과 kNN 유사도 검색을 결합한 하이브리드 엔진이다.
**브라우저에서 순수 TypeScript로 실행된다.** GPU, 딥러닝 프레임워크, OpenCV.js, 외부 라이브러리를 쓰지 않는다.
픽셀 접근은 Canvas 2D `ImageData`, 수치 연산은 `Float32Array` / `Uint8ClampedArray`로 한다.

전체 검출 파이프라인은 패널 1개(이미지 4장) 기준 **200ms 이내**를 목표로 한다.
다수 패널 일괄 분석은 Web Worker 풀에서 병렬 처리한다.

"학습"은 다음 두 가지를 의미한다.

1. 승인된 학습 패널의 특징 벡터가 kNN 검색 대상에 추가되어 즉시 판정에 반영된다.
2. 승인된 라벨을 정답으로 `app_setting`의 Rule 임계값을 자동 튜닝할 수 있다.

---

## 1. Pipeline Overview

```text
업로드
  └─> [P] 전처리      : 원 검출 → 회전 보정 → 정규화 프레임(512×512)
        └─> [D] 검출  : 잔차 계산 → 암/명 blob + line 검출 → annotation 후보
              ├─> [R] Rule 판정   : 면적·형상 규칙 → rule_verdict
              ├─> [K] kNN 판정    : 특징 벡터 → 코사인 유사도 → knn_verdict
              └─> [F] 융합        : rule + knn → final_judgement + confidence + needs_review
                    └─> [V] 검수  : 사람이 수정/승인 → 학습 DB 반영
```

---

## 2. [P] Preprocessing

입력 이미지는 원형 디스플레이 + 배경이 포함되어 있고, FPCB 방향은 보장되지 않는다.

### 2.1 Active 영역 검출

Hough 변환은 쓰지 않는다. 점등된 원형 디스플레이는 어두운 배경 위의 밝고 볼록한 단일 영역이므로,
훨씬 단순하고 빠른 방법으로 충분하다.

1. 그레이스케일 변환 후 3×3 박스 블러 2회 (가우시안 근사)
2. **Otsu 이진화**로 전경/배경 분리
3. **최대 연결 성분** 추출 (4-이웃 union-find). 면적이 전체의 5% 미만이면 실패로 간주
4. 성분의 외곽 픽셀에 **최소제곱 원 피팅**(Kåsa 법)으로 `(cx, cy, r)` 산출
5. 잔차 RMS가 `0.05 × r` 을 넘으면 원형이 아니라고 보고 실패 처리
6. 실패 시 `preprocess_status='failed'` 로 표시하고 **수동 원 지정 UI**로 넘긴다

Kåsa 원 피팅은 `x² + y² = 2ax + 2by + c` 형태의 3×3 정규방정식 하나로 풀린다. 반복 없이 닫힌 해가 나온다.

검출 결과 `(cx, cy, r)`을 `image` 테이블에 원본 좌표로 저장한다.

Active 마스크는 반지름 `0.98 × r` 의 채워진 원으로 만든다. 베젤 경계의 링 아티팩트가 불량으로 오검출되는 것을 막기 위해 2%를 침식한다.

### 2.2 회전 보정

FPCB / Bending 탭은 원형 Active 영역 **바깥**에 붙은 돌출부다.

- **자동 추정**: 원 외곽 `1.0r ~ 1.3r` 링 영역에서 배경 대비 밝기가 다른 각도 구간을 찾는다. 가장 강한 구간의 중심 각도를 FPCB 방향으로 추정하고, 이를 6시로 보내는 `rotation_deg`를 제안한다.
- **수동 확정**: 업로드 직후 검출된 원과 추정 방향을 오버레이해 보여주고, 사용자가 회전 다이얼로 조정한다. 확정값은 `rotation_source='manual'`로 저장한다.
- 같은 패널의 R/G/B/W는 동일 촬영본이므로 **한 번 지정하면 4장에 일괄 적용**한다. 개별 조정도 허용한다.

자동 추정은 어디까지나 제안이다. **정확도가 위치 상관 분석 전체의 신뢰도를 좌우하므로, 최초 릴리스에서는 수동 확정을 필수 단계로 둔다.**

### 2.3 정규화 프레임

`rotation_deg` 만큼 `(cx, cy)` 중심 회전 → 원의 bounding box로 crop → `512×512` 리사이즈.
결과적으로 원의 중심은 항상 `(256, 256)`, 반지름은 `250`이 된다.

이후 모든 좌표·면적은 이 프레임 기준이다.

---

## 3. [D] Detection

패턴 이미지 1장마다 독립적으로 수행한다.

### 3.1 잔차 계산

```text
gray     = 해당 패턴 채널 추출 (R패턴→R채널, W패턴→휘도)
bg       = fitBackgroundSurface(gray, activeMask)   # 전역 강건 2차 곡면
residual = int16(gray) - int16(bg)
```

**국소 중앙값 필터를 쓰지 않는다.** 커널보다 큰 암점 위에서는 커널이 통째로 암점 내부에 들어가
배경 추정치가 암점 자신의 밝기와 같아지고, 잔차가 0으로 무너진다. 면적 25%인 암점이 0%로 측정되어
`암점 中`과 `암점 大`가 원리적으로 검출 불가능해진다.

대신 Active 영역 전체에 **하나의 2차 곡면**을 맞춘다.

```text
bg(x, y) = c0 + c1·u + c2·v + c3·u² + c4·v² + c5·uv
```

6개 항으로 방사형 비네팅(r²에 선형이므로 정확히 표현됨)과 방향성 조명 기울기를 모두 흡수한다.
모델이 전역이므로 **불량이 아무리 커도 배경 추정에서 숨을 수 없다.**

강건성은 2단계로 확보한다.

1. **Otsu 분할**로 암부 픽셀을 사전 배제한다. 단 히스토그램이 실제로 이봉(bimodal)일 때만 적용한다.
   판정 기준은 "암부 픽셀 비율"이 아니라 **두 클래스 평균의 분리도**(pooled within-class σ 단위)다.
   비율 기준을 쓰면 `암점 大` 구간 한복판에 불연속이 생긴다.
2. **Tukey biweight IRLS**로 남은 이상치(주로 명점·명선)를 억제한다.

명선 위에서 배경이 최대 3 gray level 들뜨지만, 검출 임계값 25/30보다 한 자릿수 작아 무해하다.

### 3.2 암부 / 명부 후보

```text
dark_mask   = residual < -dark.residual_threshold
bright_mask = residual > +bright.residual_threshold
```

**형태학적 열림(open)을 적용하지 않는다.** 3px 두께의 Line은 회전 보정과 이중선형 리샘플링을 거치면
경계가 부드러워져 임계값 통과 폭이 약 2px로 줄어드는데, 3×3 침식은 이를 완전히 지워버린다.
촬영본은 결코 완벽히 정렬되어 있지 않으므로 모든 Line 불량을 잃게 된다.

8-이웃 연결 성분 분석 후 `blob.min_area_px` 미만의 성분만 버린다. 면적 필터는 고립 노이즈를
제거하면서 가는 구조를 얇게 만들지 않는다.

### 3.3 Line vs Dot 분리

각 연결 성분의 외곽점에 **회전 캘리퍼스**를 적용해 최소 외접 사각형을 구한다.
볼록 껍질(Andrew monotone chain) → 각 변을 축으로 삼아 폭·높이 최소화. 성분당 O(h log h)다.

```text
long, short = sorted(rect.size, reverse=True)
aspect = long / max(short, 1)
length_ratio = long / 500          # 정규화 프레임의 Active 지름 = 500px
```

`aspect >= line.min_aspect_ratio` 이고 `length_ratio >= line.min_length_ratio` 이면 **Line**으로 인정한다.

주축 각도 `θ`(수평 기준)에 따라:

| 조건 | 판정 |
|---|---|
| `\|θ\| <= line.angle_tolerance_deg` | 가로줄 |
| `\|θ - 90\| <= line.angle_tolerance_deg` | 세로줄 |
| 그 외 | Line 인정하지 않고 Dot으로 재분류 |

부호에 따라 명선(D005/D006) 또는 암선(D007/D008)을 부여한다.

Line으로 인정되지 않은 성분은:

- `bright_mask` 유래 → 명점 (D004)
- `dark_mask` 유래 → 암점 후보. **개별 성분에는 등급을 매기지 않는다.** 등급은 4절에서 패널 단위 총 면적으로 결정한다.

### 3.4 미점등 검사

```text
mean_luma = gray[active_mask].mean()
if mean_luma < no_display.mean_luma_threshold:      → 전체 미점등
largest_dark_cc_area / active_area_px >= no_display.partial_area_ratio  → 부분 미점등
```

둘 중 하나라도 참이면 해당 패턴은 미점등(D010)이며, 그 패턴의 다른 검출 결과는 모두 버린다.

### 3.5 구동불량

Rule로 신뢰성 있게 잡기 어려운 클래스다. Rule 엔진은 **약한 플래그만** 만들고, 최종 판정은 kNN에 맡긴다.

플래그 신호:

- Active 영역 내 행/열 방향 휘도 프로파일의 주기적 진동 (FFT 주파수 피크)
- 패턴 색과 실제 채널 응답의 불일치 (예: R 패턴인데 G/B 채널 에너지가 유의하게 큼)
- 대면적 저주파 휘도 기울기

세 신호 중 2개 이상이 임계 초과 시 `driving_flag = True`. 이 플래그만으로는 D009를 확정하지 않는다.

### 3.6 좌표 계산

각 성분의 대표점 `(x, y)`은 point/box/mask는 무게중심, line은 중점이다.
`docs/defect_taxonomy.md` 5절 공식으로 `r_ratio`, `angle_deg`, `region`을 계산해 `annotation`에 저장한다.

---

## 4. [R] Rule Verdict

패널 단위로 4개 패턴의 검출 결과를 통합한다.

```text
1. 어느 한 패턴이라도 전체 미점등 → rule_verdict = 미점등(D010), 종료
2. dark_area_ratio = max(패턴별 dark_mask 면적 / active_area_px * 100)
   0 < ratio <= 5   → 암점 小
   5 < ratio <= 15  → 암점 中
   ratio > 15       → 암점 大
3. 명점/명선/암선은 4패턴 중 2개 이상에서 검출될 때만 인정한다
   (단일 패턴 검출은 촬영 노이즈로 간주)
4. detected = 위에서 인정된 defect_id 의 집합
5. len(detected) >= 2 → rule_verdict = 복수불량(D011)
   len(detected) == 1 → rule_verdict = 그 불량
   len(detected) == 0 → rule_verdict = 양품(D000)
```

3번의 "2개 이상 패턴" 규칙은 오검출을 크게 줄인다. 실제 화소 불량은 R/G/B/W 모두에서 보이기 때문이다.
다만 **특정 색에서만 나타나는 서브픽셀 불량**은 이 규칙에 걸려 누락될 수 있다. 검수 화면에서 "1개 패턴에서만 검출됨" 후보를 별도 섹션으로 보여줘 사람이 확인하게 한다.

---

## 5. [K] kNN Verdict

### 5.1 특징 벡터

패턴 이미지 1장당 **91차원** 디스크립터를 만든다.

| 블록 | 차원 | 내용 |
|---|---|---|
| 방사 히스토그램 | 32 | 중심→외곽 16개 링. 각 링의 `dark_frac`, `bright_frac` |
| 각도 히스토그램 | 48 | 6시 기준 24개 섹터. 각 섹터의 `dark_frac`, `bright_frac` |
| 전역 통계 | 11 | `mean`, `std`, `p1`, `p99`, `dark_ratio`, `bright_ratio`, `n_dark_cc`, `n_bright_cc`, `max_cc_area_ratio`, `line_score_h`, `line_score_v` |

R/G/B/W 4장을 `R,G,B,W` 순으로 concat → **364차원 패널 디스크립터**.
패턴이 결손된 경우 해당 블록은 0으로 채우고, `confidence`에 페널티를 준다.

마지막에 L2 정규화한다. 이때 방사·각도 히스토그램이 이미 6시 정렬 프레임에서 계산되므로, **벡터 자체가 회전 정렬된 위치 정보를 담는다.** 같은 위치에 같은 불량이 있는 패널끼리 유사도가 높아진다.

`feature_version = "v1"` 로 태깅한다.

### 5.2 검색

```text
후보 = embedding WHERE is_searchable = 1 AND feature_version = 'v1'
if len(후보) < knn.min_train_panels:
    knn_verdict = None      # kNN 비활성, Rule 단독 판정
else:
    sims = 코사인유사도(query_vec, 후보_행렬)         # Float32Array 순회 내적
    top  = sims 상위 knn.k 개 중 sim >= knn.min_similarity 인 것만
    if top 이 비었으면 knn_verdict = None
    else: 유사도 가중 다수결 → knn_verdict, knn_confidence = 승자표수합 / 전체표수합
```

`knn_neighbors`에 상위 이웃의 `panel_id`, `defect_id`, `similarity`를 저장한다. 검수 화면에서 "이 패널과 가장 비슷한 학습 패널"로 썸네일과 함께 보여준다. **판정 근거를 사람이 눈으로 확인할 수 있다는 점이 이 방식의 핵심 이점이다.**

---

## 6. [F] Fusion

| rule_verdict | knn_verdict | final_judgement | confidence | needs_review |
|---|---|---|---|---|
| A | A | A | `0.9 + 0.1 × knn_conf` | 0 |
| A | None | A | `0.6` | 0 |
| A | B (≠A) | **A** (Rule 우선) | `0.45` | **1** |
| 양품 | B | **B** | `0.5` | **1** |

핵심 원칙:

- **Rule이 명시적 불량을 판정하면 Rule을 따른다.** 암점 등급은 면적이라는 결정론적 정의를 갖고 있어 kNN이 뒤집을 근거가 없다.
- **Rule이 양품인데 kNN이 불량을 지목하면 kNN을 따르고 검수 대상으로 올린다.** 구동불량처럼 Rule이 놓치는 클래스를 잡기 위한 경로다.
- 불일치는 항상 `needs_review = 1`이다. 사람의 수정이 곧 다음 학습 데이터가 된다.

패턴 결손 페널티: 결손 패턴 1장당 `confidence × 0.85`.

`decision_reason`에 사람이 읽을 문자열을 남긴다.

```text
"Rule: dark_area_ratio=7.2% → 암점 中 / kNN: 암점 中 (5/5, sim 0.91) → 일치"
"Rule: 양품 / kNN: 구동불량 (4/5, sim 0.83) → kNN 채택, 검수 필요"
```

---

## 7. [V] Review & Learning Loop

1. 검수 화면에서 사용자가 `final_judgement`, 개별 `annotation`을 수정한다.
2. 수정된 annotation의 `label_source`는 `ai` → `corrected` 로 바뀐다.
3. 승인 시 `panel_result.review_status = 'approved'`.
4. 승인된 **분석 패널**은 학습 데이터로 승격할 수 있다 (`purpose`를 `training`으로 전환).
5. 승격 시 `embedding.is_searchable = 1`로 바뀌어 **다음 분석부터 즉시 kNN에 반영된다.**

### 7.1 임계값 자동 튜닝 (Phase 2)

승인된 학습 패널을 정답으로 삼아 Rule 임계값을 grid search 한다.

- 대상: `dark.residual_threshold`, `bright.residual_threshold`, `line.min_aspect_ratio`, `blob.min_area_px`
- 목적함수: 패널 단위 `final_judgement` macro-F1
- 학습 패널 30개 이상일 때만 활성화하고, 5-fold CV로 과적합을 막는다
- 결과는 `app_setting`에 반영하되 **적용 전 diff를 사용자에게 보여주고 승인받는다**

---

## 8. Versioning

`engine_version`은 `{preprocess}.{detect}.{fusion}` 형식으로 관리한다 (예: `1.0.0`).
`panel_result`에 기록해 과거 분석 결과의 재현성을 확보한다.

엔진이나 `feature_version`이 바뀌면 전체 재분석 배치를 제공하되, 기존 결과를 덮어쓰지 않고 새 행으로 남길지 여부는 Phase 2에서 결정한다. MVP는 덮어쓴다.

---

## 9. Known Limitations

정직하게 기록한다. 아래는 MVP에서 해결되지 않는다.

- **구동불량은 Rule로 잡히지 않는다.** kNN에 학습 데이터가 충분히 쌓이기 전까지는 사실상 미검출된다.
- **회전 보정이 부정확하면 위치 상관 분석 전체가 무의미해진다.** 자동 추정을 신뢰하지 말 것.
- **패턴 결손 패널**은 특징 벡터의 1/4이 0이므로 kNN 유사도가 구조적으로 낮게 나온다.
- **암점 大와 부분 미점등의 경계**는 60% 임계값 하나로 갈린다. 실제로는 연속적인 현상이라 경계 근처에서 판정이 흔들린다.
- 손수 만든 364차원 디스크립터는 **미세한 형상 차이**(예: 명점 vs 짧은 명선)를 잘 구분하지 못한다. 이 경우 Rule의 `aspect` 판정에 의존한다.
- 배경 모델이 2차 곡면이므로 **비네팅과 단순 기울기만 표현**한다. 얼룩(Mura)처럼 국소적이고 저주파인 밝기 불균일은 배경으로 흡수되지 않고 잔차에 남는다. 현재 불량 List에 Mura가 없어 문제되지 않지만, 추가 시 배경 모델을 다시 설계해야 한다.
- 전체 미점등 이미지는 **원 검출이 불가능**하다. 같은 패널의 다른 패턴에서 기하를 빌려오며, 4장 모두 미점등이면 사용자가 원을 수동 지정해야 한다.
- 암점 면적비는 `0.98r` Active 마스크를 분모로 쓰므로 실제 원 면적 대비 약 4% 과대 측정된다. 등급 경계 근처에서 이 편향을 감안해야 한다.
- 패널 1개(이미지 4장) 분석에 약 270ms가 걸린다. 목표치 200ms를 넘는다. 배경 곡면 피팅과 연결 성분 분석이 지배적이며, Web Worker 병렬화로 처리량은 확보 가능하다.
- **브라우저 데이터가 지워지면 학습 데이터도 사라진다.** IndexedDB는 캐시 삭제, 시크릿 모드 종료, 브라우저 재설치로 소실된다. 주기적 내보내기가 유일한 백업이다.
- OpenCV를 쓰지 않으므로 검출 연산자는 직접 구현한 것이다. 서브픽셀 정밀도, 적응형 이진화, 고급 형태학 연산은 제공되지 않는다. 정확도 상한이 OpenCV 구현보다 낮을 수 있다.
