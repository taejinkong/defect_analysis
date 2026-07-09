# Database Schema

## 1. Design Decisions

- **저장소**: 브라우저 **IndexedDB** (DB명 `defect_analysis`). 서버와 파일시스템을 쓰지 않는다.
- **테이블 = object store**. 아래 표의 `column`은 object store에 저장되는 레코드의 필드다.
  `PK`는 `keyPath`, `INDEX`는 `createIndex`, `UNIQUE`는 `createIndex(..., {unique:true})`에 대응한다.
- **타입 표기**: 아래 표는 SQL 타입으로 적는다. 향후 서버 전환 시 그대로 RDB 스키마가 되도록 한 공통 규격이다.
  IndexedDB 구현 시의 실제 매핑은 `INTEGER`/`REAL` → `number`, `TEXT` → `string`,
  `TIMESTAMP` → ISO 8601 `string`, `BLOB` → `ArrayBuffer`, JSON 컬럼 → 네이티브 객체/배열이다.
- **`CHECK` 제약**: IndexedDB에는 제약이 없다. 리포지토리 계층에서 검증한다.
- **좌표계**: 모든 이미지는 전처리 단계에서 `512×512` 정규화 프레임으로 변환된다. `annotation`의 픽셀 좌표는 전부 이 정규화 프레임 기준이다. 원본 이미지 좌표는 저장하지 않는다.
- **이미지**: 파일 경로 대신 `Blob`을 object store에 직접 저장한다. 표시할 때 `URL.createObjectURL`로 변환하고 사용 후 해제한다.
- **임베딩 벡터**: 벡터 인덱스가 없으므로 `ArrayBuffer`(float32 raw)로 저장하고, 조회 시 전량 로드해 `Float32Array` 코사인 유사도로 brute-force 검색한다. 패널 수 1만 개까지 실용적이다.
- **삭제**: 물리 삭제 대신 `is_active` / `deleted_at`으로 소프트 삭제한다.
- **자동 증가 키**: `autoIncrement: true`.

## 2. Storage Layout

파일시스템 경로가 없으므로, 원래 경로 컬럼이던 항목은 모두 Blob 필드로 대체된다.

| 원래 경로 컬럼 | IndexedDB 필드 | 내용 |
|---|---|---|
| `original_path` | `original_blob` | 업로드 원본 |
| `normalized_path` | `normalized_blob` | 512×512 정규화 프레임 (PNG) |
| `thumb_path` | `thumb_blob` | 256×256 썸네일 (JPEG) |
| `active_mask_path` | `active_mask_blob` | Active 영역 마스크 (PNG, 1채널) |
| `mask_path` | `mask_blob` | 불량 마스크 (PNG, 1채널) |

용량 관리:

- 원본은 긴 변 2048px로 다운스케일해 저장한다. 그 이상은 검출 정확도에 기여하지 않는다.
- IndexedDB 사용량이 브라우저 할당량의 80%를 넘으면 경고하고 내보내기를 안내한다.
- `navigator.storage.persist()`를 요청해 브라우저의 자동 정리 대상에서 제외한다.

## 3. Object Stores

### 3.1 defect_master

불량 마스터. 초기값은 `docs/defect_taxonomy.md` 1절 표를 시딩한다.

| column | type | constraint | description |
|---|---|---|---|
| defect_id | TEXT | PK | `D000` ~ `D011` |
| defect_name | TEXT | NOT NULL, UNIQUE | 표시명 |
| category | TEXT | NOT NULL | Dark Dot / Bright Line / ... |
| description | TEXT | | 판정 기준 설명 |
| classification_type | TEXT | NOT NULL | Area Detection / Blob Detection / Line Detection / Classification / Derived |
| severity | INTEGER | NOT NULL, DEFAULT 0 | Primary Defect tie-breaker |
| is_labelable | INTEGER | NOT NULL, DEFAULT 1 | 0이면 사람이 라벨링 불가 (양품, 복수불량) |
| is_active | INTEGER | NOT NULL, DEFAULT 1 | 소프트 삭제 |
| sort_order | INTEGER | NOT NULL, DEFAULT 0 | UI 표시 순서 |

---

### 3.2 panel

패널 1개 = R/G/B/W 이미지 4장의 묶음.

| column | type | constraint | description |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| panel_code | TEXT | NOT NULL | 사용자가 부여한 Panel ID |
| lot_id | TEXT | NOT NULL | |
| model | TEXT | | |
| process_name | TEXT | | |
| equipment_id | TEXT | | |
| purpose | TEXT | NOT NULL, CHECK IN ('training','analysis') | 학습용 / 분석용 |
| batch_id | INTEGER | FK → upload_batch.id, NULL | |
| uploaded_at | TIMESTAMP | NOT NULL | |
| uploaded_by | TEXT | | 로컬 앱이므로 단순 문자열 |
| deleted_at | TIMESTAMP | NULL | |

- `UNIQUE (lot_id, panel_code, purpose)` — 같은 Lot 내 Panel ID 중복 방지
- `INDEX (lot_id)`, `INDEX (purpose)`, `INDEX (uploaded_at)`

---

### 3.3 image

패널에 속한 패턴별 이미지 1장.

| column | type | constraint | description |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| panel_id | INTEGER | FK → panel.id, NOT NULL | |
| pattern | TEXT | NOT NULL, CHECK IN ('R','G','B','W') | |
| original_blob | BLOB | NOT NULL | 업로드 원본 (긴 변 2048px 이하) |
| normalized_blob | BLOB | | 512×512 정규화 프레임 |
| thumb_blob | BLOB | | 256×256 썸네일 |
| active_mask_blob | BLOB | | Active 영역 마스크 |
| orig_width | INTEGER | | |
| orig_height | INTEGER | | |
| active_cx | REAL | | 원본 기준 원 중심 x |
| active_cy | REAL | | 원본 기준 원 중심 y |
| active_r | REAL | | 원본 기준 원 반지름 |
| active_area_px | INTEGER | | 정규화 프레임 기준 Active 픽셀 수 |
| rotation_deg | REAL | NOT NULL, DEFAULT 0 | FPCB를 6시로 맞추기 위해 적용한 회전량 |
| rotation_source | TEXT | CHECK IN ('auto','manual') | 회전각 결정 주체 |
| preprocess_status | TEXT | NOT NULL, DEFAULT 'pending' | pending / done / failed |
| preprocess_error | TEXT | | 실패 사유 |

- `UNIQUE (panel_id, pattern)`
- `INDEX (panel_id)`

> `active_cx/cy/r`은 원본 좌표계에 대한 검출 결과이며, 정규화 프레임에서는 항상 중심 `(256,256)`, 반지름 `250`이 되도록 crop·resize 한다.

---

### 3.4 annotation

개별 불량 라벨 1건. 학습용(manual)과 분석용(ai/corrected)이 같은 테이블을 쓴다.

| column | type | constraint | description |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| image_id | INTEGER | FK → image.id, NOT NULL | |
| defect_id | TEXT | FK → defect_master.defect_id, NOT NULL | `is_labelable=1`인 값만 허용 |
| label_source | TEXT | NOT NULL, CHECK IN ('manual','ai','corrected') | |
| geom_type | TEXT | NOT NULL, CHECK IN ('point','line','box','mask') | |
| x | REAL | | 대표점 x (정규화 프레임) |
| y | REAL | | 대표점 y |
| x2 | REAL | | line 끝점 / box 우하단 x |
| y2 | REAL | | line 끝점 / box 우하단 y |
| mask_blob | BLOB | | geom_type='mask'일 때 |
| area_px | INTEGER | | 불량 픽셀 수 |
| area_ratio | REAL | | `area_px / image.active_area_px * 100` |
| r_ratio | REAL | | 0.0 ~ 1.0 |
| angle_deg | REAL | | 6시=0°, 시계 방향 증가 |
| region | TEXT | CHECK IN ('center','mid','edge') | `r_ratio`에서 파생 |
| confidence | REAL | | AI 검출 신뢰도. manual이면 1.0 |
| review_status | TEXT | NOT NULL, DEFAULT 'pending', CHECK IN ('pending','approved','rejected') | |
| created_at | TIMESTAMP | NOT NULL | |

- `INDEX (image_id)`, `INDEX (defect_id)`, `INDEX (review_status)`
- `x, y`는 `geom_type`과 무관하게 항상 채운다. line은 중점, box·mask는 무게중심을 대표점으로 삼는다. Heatmap이 이 값을 쓴다.

---

### 3.5 panel_result

패널 단위 최종 분석 결과. 패널당 1행.

| column | type | constraint | description |
|---|---|---|---|
| panel_id | INTEGER | PK, FK → panel.id | |
| primary_defect_id | TEXT | FK → defect_master.defect_id | severity 최대 불량 |
| detected_defect_ids | JSON | NOT NULL, DEFAULT `[]` | 예: `["D001","D004"]` |
| final_judgement_id | TEXT | FK → defect_master.defect_id, NOT NULL | 양품/복수불량 포함 |
| dark_area_ratio | REAL | | 4패턴 최댓값 |
| rule_verdict_id | TEXT | | Rule 엔진 단독 판정 |
| knn_verdict_id | TEXT | | kNN 단독 판정 |
| knn_neighbors | JSON | | `[{panel_id, defect_id, similarity}, ...]` |
| confidence | REAL | | 최종 신뢰도 0.0~1.0 |
| decision_reason | TEXT | | 사람이 읽는 판정 근거 문자열 |
| needs_review | INTEGER | NOT NULL, DEFAULT 0 | rule/knn 불일치 시 1 |
| review_status | TEXT | NOT NULL, DEFAULT 'pending', CHECK IN ('pending','approved','rejected') | |
| reviewed_by | TEXT | | |
| reviewed_at | TIMESTAMP | | |
| analyzed_at | TIMESTAMP | NOT NULL | |
| engine_version | TEXT | NOT NULL | 재현성 확보 |

- `INDEX (final_judgement_id)`, `INDEX (review_status)`, `INDEX (needs_review)`

---

### 3.6 embedding

kNN 유사도 검색용 특징 벡터. **`review_status='approved'` 인 학습용 패널만** 검색 대상에 포함한다.

| column | type | constraint | description |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| panel_id | INTEGER | FK → panel.id, NOT NULL | |
| vector | BLOB | NOT NULL | float32 raw bytes (ArrayBuffer) |
| dim | INTEGER | NOT NULL | 예: 364 |
| label_defect_id | TEXT | FK → defect_master.defect_id | 이 패널의 대표 라벨 |
| is_searchable | INTEGER | NOT NULL, DEFAULT 0 | 승인된 학습 패널만 1 |
| feature_version | TEXT | NOT NULL | 특징 추출기 버전 |
| created_at | TIMESTAMP | NOT NULL | |

- `UNIQUE (panel_id, feature_version)`
- `INDEX (is_searchable, feature_version)`

> `feature_version`이 바뀌면 기존 벡터는 검색에서 제외된다. 전체 재계산 배치를 제공한다.

---

### 3.7 app_setting

Rule 엔진 임계값. 코드 수정 없이 튜닝하기 위한 key-value 저장소.

현재 구현은 이 값들을 `localStorage`(키 `defect-analysis.settings.v1`)에 저장하고,
UI에서 슬라이더로 조절하며 JSON으로 내보내고 가져올 수 있다. 잘못된 조합은 로드 시 자동 보정한다.
IndexedDB 도입 시 이 object store로 옮긴다.

| column | type | constraint |
|---|---|---|
| key | TEXT | PK |
| value | JSON | NOT NULL (스칼라) |
| value_type | TEXT | NOT NULL (`int`/`float`/`str`/`bool`) |
| description | TEXT | |
| updated_at | TIMESTAMP | NOT NULL |

초기 시딩 값:

| key | value | description |
|---|---|---|
| `pattern.min_confirmations` | 2 | 점·선 불량 인정에 필요한 패턴 수 |
| `dark_dot.small_max_pct` | 5.0 | 암점 小 상한 |
| `dark_dot.medium_max_pct` | 15.0 | 암점 中 상한 |
| `dark.residual_threshold` | 25 | 암부 잔차 임계 |
| `bright.residual_threshold` | 30 | 명부 잔차 임계 |
| `blob.min_area_px` | 6 | 최소 검출 면적 |
| `line.min_aspect_ratio` | 8.0 | Line 인정 종횡비 |
| `line.min_length_ratio` | 0.4 | Line 인정 길이 (지름 대비) |
| `line.angle_tolerance_deg` | 20.0 | 가로/세로 판정 허용각 |
| `no_display.mean_luma_threshold` | 15 | 전체 미점등 임계 |
| `no_display.partial_area_ratio` | 0.6 | 부분 미점등 임계 |
| `region.center_max_r` | 0.35 | center 상한 |
| `region.mid_max_r` | 0.75 | mid 상한 |
| `knn.k` | 5 | 이웃 수 |
| `knn.min_similarity` | 0.75 | 이웃 인정 최소 코사인 유사도 |
| `knn.min_train_panels` | 10 | 이 수 미만이면 kNN 비활성, Rule 단독 |

---

### 3.8 upload_batch

업로드 1회를 묶는 단위. 대시보드 필터의 기본 단위가 된다.

| column | type | constraint | description |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | |
| name | TEXT | | 사용자 지정 배치명 |
| purpose | TEXT | NOT NULL, CHECK IN ('training','analysis') | |
| created_at | TIMESTAMP | NOT NULL | |
| panel_count | INTEGER | NOT NULL, DEFAULT 0 | |

## 4. Relationships

```text
upload_batch 1 ──< panel 1 ──< image 1 ──< annotation >── 1 defect_master
                     │                                        │
                     ├── 1:1 panel_result ────────────────────┤
                     └── 1:1 embedding
```

## 5. Filename Convention

앱이 표준 파일명 규칙을 정의한다. 자동 그룹핑은 이 규칙에 의존한다.

```text
{LOT_ID}_{PANEL_CODE}_{PATTERN}.{ext}
```

- `PATTERN` ∈ `R | G | B | W` (대소문자 무시)
- `ext` ∈ `png | jpg | jpeg | bmp`
- 예시: `LOT2401_P001_R.png`, `LOT2401_P001_W.jpg`

파싱 규칙:

- 마지막 `_` 뒤 토큰을 `PATTERN`으로, 그 앞 토큰을 `PANEL_CODE`로, 나머지 앞부분 전체를 `LOT_ID`로 본다. 따라서 Lot ID 안에 `_`가 있어도 된다.
- 파싱에 실패하거나, 한 패널의 패턴이 4개가 아니거나, 같은 패턴이 중복되면 **수동 그룹핑 UI**로 넘긴다.
- 수동 그룹핑 UI에서는 업로드된 이미지를 드래그해 패널 단위로 묶고 각 이미지의 패턴을 지정한다.

부분 업로드(예: W만 있는 패널)도 허용한다. 단, `panel_result.confidence`에 패턴 결손 페널티를 적용하고 대시보드에 경고 배지를 표시한다.
