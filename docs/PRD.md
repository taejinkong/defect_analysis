# Watch Display Defect Matching Web App PRD

## 1. Product Overview
Watch Display Defect Matching Web App은 Watch Display의 Red, Green, Blue, White 점등 이미지를 Panel 단위로 불러와, 학습된 불량 데이터와 비교하여 자동으로 불량명을 매칭하는 **오프라인 단일 HTML 앱**이다.
설치나 서버 없이 브라우저에서 바로 실행되며, 이미지는 사용자 PC를 벗어나지 않는다.
사용자는 학습용 이미지를 등록하고, 불량 위치와 불량명을 라벨링할 수 있다. 이후 분석용 이미지를 업로드하면 앱은 양품, 암점 小, 암점 中, 암점 大, 명점, 명선, 암선, 구동불량, 미점등, 복수불량으로 자동 분류하고 대시보드로 시각화한다.

앱은 두 개의 독립된 기능 영역으로 구성된다.

- **학습 영역**: 불량 Master 관리, 학습 이미지 업로드, 라벨링, 승인
- **분석 영역**: 분석 이미지 일괄 업로드, 자동 매칭, 검수, 대시보드 시각화

### 관련 문서
| 문서 | 내용 |
|---|---|
| `docs/defect_taxonomy.md` | 불량 정의와 판정 기준 |
| `docs/matching_engine.md` | 검출·판정 알고리즘 |
| `docs/database_schema.md` | 데이터 모델, 저장 구조, 파일명 규칙 |
| `docs/dashboard_spec.md` | 대시보드 지표 정의와 시각화 규칙 |

## 2. Background
Watch Display 점등 검사에서는 불량 유형이 다양하고, 불량 위치와 패턴별 발현 특성이 중요하다. 현재는 사람이 이미지를 확인하고 불량명을 판단해야 하므로 분석 시간이 오래 걸리고, 판단 기준이 작업자에 따라 달라질 수 있다.
따라서 불량 이미지를 체계적으로 학습 데이터로 축적하고, 신규 점등 이미지를 자동으로 불량 List와 매칭하는 시스템이 필요하다.

## 3. Objectives
- Panel 단위 R/G/B/W 점등 이미지 업로드 기능 제공
- 불량 Master List 관리 기능 제공
- 학습용 이미지 라벨링 및 검수 기능 제공
- 분석용 이미지 자동 불량 매칭 기능 제공
- AI 결과를 수정하고 승인할 수 있는 Review Workflow 제공
- 불량명별 수량 및 비율 시각화
- FPCB/Bending 6시 방향 기준 위치 Heatmap 제공
- 이미지 간 불량 위치 상관성 분석 제공
- Lot ID, 설비, 공정별 불량 현황 분석

## 4. User Model

MVP v1.0은 **로컬 PC에서 실행하는 단일 사용자 앱**이다. 로그인과 권한 체계를 두지 않는다.
`uploaded_by`, `reviewed_by` 필드는 단순 문자열로 기록만 하고 접근 제어에는 쓰지 않는다.

Admin / Reviewer / Viewer 3단계 권한 구조는 팀 공유 서버로 전환할 때 도입한다. 그때까지 데이터 모델은
권한 도입이 가능하도록 행위 주체 필드를 유지한다.

## 5. Core Features
### 5.1 Defect Master Management
- 불량명 등록, 수정, 비활성화
- 불량 Category 관리
- 불량 설명 및 판정 기준 관리

### 5.2 Training Upload
- Panel ID, Lot ID, Model, Process, Equipment ID 입력
- R/G/B/W 이미지 업로드
- Active 원형 영역 자동 검출 결과 확인 및 보정
- FPCB 6시 방향 회전 보정 확정
- 불량명 선택
- 불량 위치 라벨링
- 승인 상태 관리

### 5.3 Analysis Upload
- 여러 Panel의 R/G/B/W 이미지 일괄 업로드
- 파일명 기반 자동 그룹핑
- 필요 시 수동 그룹핑 보정
- FPCB 6시 방향 회전 보정 확정
- AI 분석 실행

### 5.4 Review
- AI 매칭 결과 확인
- 불량명 수정
- 복수불량 지정
- 위치 라벨 수정
- 승인/반려 처리

### 5.5 Dashboard
- Panel별 이미지-불량명 매칭 결과 표시
- 불량별 수량 및 비율 표시
- R/G/B/W 패턴별 불량 발현 표시
- FPCB 6시 방향 기준 위치 Heatmap 표시
- 이미지 간 불량 위치 상관성 (Hotspot Cluster, 방향 집중도) 표시
- Lot/설비/공정별 불량 현황 표시

상세 정의는 `docs/dashboard_spec.md`를 따른다.

## 6. User Flow
### 6.1 Training Flow
1. 사용자가 Training Upload 화면에 접속한다.
2. Lot ID, Panel ID, Model, Process, Equipment ID를 입력한다.
3. Panel별 R/G/B/W 이미지를 업로드한다.
4. 앱이 Active 원형 영역과 FPCB 방향을 자동 추정해 오버레이로 보여준다.
5. 사용자가 원 위치와 회전각을 확정한다. **회전각 확정은 필수 단계다.**
6. 불량명을 선택한다.
7. 이미지 위에 불량 위치를 Point, Line, Box, Mask 형태로 라벨링한다.
8. 사용자가 라벨을 승인한다.
9. 승인된 데이터는 학습 DB에 저장되고, 특징 벡터가 kNN 검색 대상에 추가된다.

### 6.2 Analysis Flow
1. 사용자가 Analysis Upload 화면에 접속한다.
2. 여러 Panel의 R/G/B/W 이미지를 업로드한다.
3. 앱은 파일명 규칙을 이용해 이미지를 Panel 단위로 그룹핑한다. 실패 시 수동 그룹핑 UI로 넘어간다.
4. 앱은 Active Display 영역을 추출하고, 사용자가 회전각을 확정한다.
5. 앱은 불량 후보 영역을 검출한다.
6. 앱은 Rule 판정과 kNN 판정을 융합해 불량명을 자동 추천한다.
7. 사용자가 결과를 검수하고 수정한다. 판정이 불일치한 패널이 상단에 먼저 올라온다.
8. 승인된 결과는 Dashboard에 반영된다.
9. 승인된 분석 패널은 학습 데이터로 승격할 수 있다.

## 7. Defect Classification Rules
상세 불량 정의와 판정 기준은 `docs/defect_taxonomy.md`를 따른다.
검출·판정 알고리즘은 `docs/matching_engine.md`를 따른다.

### 7.1 Defect Classes

라벨링 가능한 불량 (`is_labelable = Y`) 9종:
- 암점 小 / 암점 中 / 암점 大
- 명점
- 명선_가로줄 / 명선_세로줄
- 암선_가로줄 / 암선_세로줄
- 구동불량
- 미점등

최종 판정에서만 쓰이는 파생 클래스 (`is_labelable = N`) 2종:
- 양품
- 복수불량

`양품`과 `복수불량`은 사람이 이미지 위에 찍는 라벨이 아니라, 검출된 라벨 집합의 크기에서 파생되는
패널 단위 판정값이다. 따라서 라벨링 UI의 불량명 선택지에 노출하지 않는다.

### 7.2 Dark Dot Rule
암점 小/中/大는 Active Display 영역 대비 암점 Mask의 총 면적 비율로 분류한다.
- 암점 小: 0% 초과 ~ 5% 이하
- 암점 中: 5% 초과 ~ 15% 이하
- 암점 大: 15% 초과

경계는 하한 배타 / 상한 포함 `(lo, hi]` 로 통일한다.
면적 비율은 R/G/B/W 4개 패턴에서 각각 계산한 뒤 최댓값을 대표값으로 채택한다.

### 7.3 Location Rule
FPCB/Bending 방향은 사진 기준 6시 방향을 기준축으로 고정한다.
업로드 이미지의 방향은 보장되지 않으므로, 전처리 단계에서 회전 보정을 적용해 FPCB를 6시로 정렬한다.
모든 불량 위치는 원형 Display 기준으로 정규화하고, 정렬된 좌표계 위에서 Heatmap과 위치 상관 분석을 수행한다.

`angle_deg`는 6시 방향이 0°이며 시계 방향으로 증가한다.

### 7.4 Multi Defect Rule
하나의 Panel에서 서로 다른 불량 종류가 2개 이상 검출되면 최종 판정은 복수불량으로 표시한다.
단, 내부적으로는 개별 불량 Label을 모두 저장한다.

같은 불량이 여러 개 검출된 것(예: 명점 3개)은 복수불량이 아니다. **불량 종류가 2개 이상**일 때만 복수불량이다.

## 8. Data Requirements
앱은 다음 데이터를 저장해야 한다. 컬럼 타입과 제약은 `docs/database_schema.md`를 따른다.

### Panel Metadata
- Lot ID
- Panel ID
- Model
- Process Name
- Equipment ID
- Upload Date
- Uploaded By

### Image Metadata
- Pattern Type: R/G/B/W
- Original Image Path
- Thumbnail Path
- Active Area Mask Path

### Defect Annotation
- Defect Name
- Label Source: manual / ai / corrected
- x, y coordinate
- Bounding Box
- Mask Path
- Area Ratio
- Radius Ratio
- Angle Degree
- Region
- Confidence
- Review Status

### Analysis Result
- Primary Defect
- Detected Defect List
- Final Judgement
- Confidence
- Reviewed By
- Reviewed At

## 9. Dashboard Requirements

Dashboard는 다음 정보를 제공해야 한다.

### 9.1 Overview
- 전체 Panel 수
- 양품 수
- 불량 Panel 수
- 불량률
- 복수불량 수
- Top 불량
- 주요 집중 위치

### 9.2 Panel Matching Result
- Panel ID
- R/G/B/W 썸네일
- AI 매칭 불량명
- 최종 판정
- 신뢰도
- 위치
- 검수 상태

### 9.3 Defect Ratio
- 불량별 수량
- 불량별 비율
- Panel 기준 비율
- Label 기준 비율

### 9.4 Pattern Analysis
- R/G/B/W 패턴별 불량 Count
- 패턴별 주요 불량

### 9.5 Location Correlation
- 원형 Watch Heatmap
- 불량명 × 위치 Matrix
- FPCB 6시 방향 집중도
- Center/Mid/Edge 분포

### 9.6 Lot / Equipment / Process Analysis
- Lot별 불량률
- 설비별 불량률
- 공정별 불량 유형
- 날짜별 Trend

## 10. MVP Scope
MVP v1.0에서는 다음 기능을 구현한다.
- 불량 Master 관리
- Panel별 R/G/B/W 이미지 업로드
- 파일명 기반 Panel 자동 그룹핑
- 수동 그룹핑 보정 기능
- Active 원형 영역 자동 검출 + 수동 보정
- FPCB 6시 방향 회전 보정
- 학습 이미지 라벨링 기능
- Rule 기반 불량 검출
- kNN 유사도 검색 기반 불량명 보정
- Rule / kNN 융합 판정 및 불일치 검수 큐
- AI 분석 결과 Review 기능
- 분석 패널의 학습 데이터 승격
- Panel별 분석 결과 저장
- 불량별 수량/비율 Dashboard (Panel 기준 / Label 기준)
- FPCB 6시 방향 기준 위치 Heatmap
- Hotspot Cluster 및 방향 집중도 분석
- Lot/설비/공정별 기본 분석

## 11. Out of Scope
MVP v1.0에서는 다음 기능을 제외한다.
- 로그인 및 Admin / Reviewer / Viewer 권한 구조
- 딥러닝 분류/세그멘테이션 모델 및 재학습 Pipeline
- Rule 임계값 자동 튜닝 (Phase 2)
- 다중 사용자 동시 접속
- MES 또는 검사 설비 직접 연동
- 실시간 Camera Streaming 분석
- Cell 세부 정보 기반 구동불량 상세 분류
- Mobile App 지원
- SSO 연동

## 12. Technical Stack

### 12.1 배포 제약
사용 환경은 **보안이 통제된 사내 PC**다. 다음 제약이 스택을 결정한다.

- 점등 이미지는 어떤 경우에도 PC 밖으로 전송되어서는 안 된다.
- Python 등 런타임 설치, 패키지 설치, 로컬 서버 실행을 전제할 수 없다.
- 앱은 사내 메일로 전달되어 다운로드 후 실행된다.

### 12.2 결론: 단일 HTML 파일
앱 전체를 **자기완결형 `index.html` 한 개**로 빌드한다. 더블클릭하면 브라우저에서 바로 열린다.
설치, 서버, 인터넷 연결이 모두 필요 없다. 이미지는 브라우저 메모리와 IndexedDB 안에서만 처리되므로
**네트워크로 나가는 데이터가 원천적으로 없다.**

- Language: TypeScript
- Build: Vite + `vite-plugin-singlefile` → 모든 JS/CSS/에셋을 `index.html` 하나로 인라인
- Backend: 없음
- Database: **IndexedDB** (이미지 Blob, 라벨, 분석 결과, 설정)
- Image Processing: **순수 TypeScript + Canvas 2D API**
- AI/Inference: Rule 엔진 + brute-force 코사인 kNN (`Float32Array` 연산). GPU 및 딥러닝 프레임워크 미사용
- Dashboard Chart: ECharts (번들에 인라인)
- Deployment: 빌드 산출물 `index.html` 을 메일로 전달
- Auth: 없음

### 12.3 OpenCV.js를 쓰지 않는 이유
OpenCV.js WASM 번들은 약 10MB로, 단일 HTML에 인라인하면 메일 첨부 한도를 위협한다.
이 앱에 필요한 연산은 그레이스케일 변환, 상수시간 중앙값 필터, Otsu 이진화, 연결 성분 분석,
최소 외접 사각형, 원 피팅뿐이며 모두 수백 줄의 TypeScript로 구현 가능하다.
목표 번들 크기는 **5MB 이하**다.

### 12.4 데이터 반출입
서버가 없으므로 데이터는 IndexedDB에 갇힌다. 다음 기능으로 이동성을 확보한다.

- **내보내기**: 학습 라벨·분석 결과·설정을 JSON으로, 이미지를 포함한 전체 스냅샷을 ZIP으로 다운로드
- **가져오기**: 위 산출물을 다시 로드해 다른 PC에서 이어서 작업

브라우저 캐시 삭제 시 IndexedDB가 함께 지워진다. 앱은 이 사실을 UI에 명시하고 주기적 내보내기를 안내해야 한다.

### 12.5 향후 서버 전환
팀 공유 서버로 옮길 때를 대비해 저장소 접근을 `Repository` 인터페이스 뒤에 둔다.
IndexedDB 구현을 REST 클라이언트 구현으로 교체하면 나머지 코드는 그대로 재사용한다.
`docs/database_schema.md`의 테이블 정의는 IndexedDB object store와 향후 RDB 스키마 양쪽의 공통 규격이다.

## 13. Acceptance Criteria

### Upload
- 사용자는 Panel별 R/G/B/W 이미지를 업로드할 수 있어야 한다.
- 파일명 `{LOT_ID}_{PANEL_CODE}_{PATTERN}.{ext}` 규칙에 따라 이미지를 Panel 단위로 자동 그룹핑해야 한다.
- 자동 그룹핑 실패 시 사용자가 수동으로 보정할 수 있어야 한다.
- 패턴이 4개 미만인 부분 업로드도 허용하되, 경고를 표시해야 한다.

### Preprocessing
- 앱은 원형 Active Display 영역을 자동 검출해야 한다.
- 자동 검출 실패 시 사용자가 원의 중심과 반지름을 직접 지정할 수 있어야 한다.
- 사용자는 FPCB 방향을 6시로 정렬하는 회전각을 확정할 수 있어야 한다.
- 확정된 회전각은 같은 Panel의 4개 패턴에 일괄 적용되어야 한다.

### Defect Master
- 사용자는 불량명을 등록, 수정, 비활성화할 수 있어야 한다.
- 불량 Master에는 defect_id, defect_name, category, description, severity, is_labelable이 포함되어야 한다.
- `is_labelable = N` 인 불량은 라벨링 UI의 선택지에 노출되지 않아야 한다.

### Training
- 사용자는 학습 이미지에 불량명을 라벨링할 수 있어야 한다.
- 사용자는 불량 위치를 Point, Line, Box 형태로 지정할 수 있어야 한다.
- 승인된 라벨만 학습 DB에 반영되어야 한다.
- 승인 즉시 해당 Panel의 특징 벡터가 kNN 검색 대상에 포함되어야 한다.

### Analysis
- 앱은 분석 이미지에 대해 불량 후보를 자동 생성해야 한다.
- 앱은 Panel별 최종 판정과 신뢰도를 생성해야 한다.
- 서로 다른 불량 종류가 2개 이상 검출되면 복수불량으로 표시해야 한다.
- 학습 Panel이 `knn.min_train_panels` 미만이면 Rule 단독으로 판정하고 그 사실을 표시해야 한다.
- Rule과 kNN 판정이 불일치하면 `needs_review = 1`로 표시하고 검수 큐 상단에 올려야 한다.
- 사용자는 판정 근거(`decision_reason`)와 kNN 이웃 썸네일을 확인할 수 있어야 한다.

### Dashboard
- Dashboard는 전체 Panel 수, 양품 수, 불량 수, 불량률, 복수불량 수를 표시해야 한다.
- Dashboard는 불량별 수량과 비율을 Panel 기준과 Label 기준으로 각각 표시해야 한다.
- Dashboard는 R/G/B/W 패턴별 불량 발현 현황을 표시해야 한다.
- Dashboard는 FPCB 6시 방향 기준 위치 Heatmap을 면적 정규화하여 표시해야 한다.
- Dashboard는 여러 Panel에 반복되는 Hotspot Cluster를 Panel 수 기준으로 표시해야 한다.
- Dashboard는 표본이 부족한 통계 지표를 표시하지 않고 그 사유를 명시해야 한다.