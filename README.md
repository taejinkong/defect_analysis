# Watch Display Defect Analysis

Watch Display의 R/G/B/W 점등 이미지를 불러와 학습된 불량 데이터와 매칭하고, 결과를 대시보드로 시각화하는
**오프라인 단일 HTML 앱**이다.

설치, 서버, 인터넷 연결이 필요 없다. 이미지는 브라우저 안에서만 처리되며 네트워크로 전송되지 않는다.

## 현재 상태

**기획 단계.** 아직 코드는 없고 설계 문서만 있다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 제품 요구사항, 범위, 기술 스택 |
| [docs/defect_taxonomy.md](docs/defect_taxonomy.md) | 불량 11종의 정의와 판정 기준 |
| [docs/matching_engine.md](docs/matching_engine.md) | Rule + kNN 하이브리드 검출·판정 알고리즘 |
| [docs/database_schema.md](docs/database_schema.md) | IndexedDB 데이터 모델, 파일명 규칙 |
| [docs/dashboard_spec.md](docs/dashboard_spec.md) | 대시보드 지표 정의와 시각화 규칙 |

## 개요

앱은 두 개의 독립된 기능 영역으로 구성된다.

- **학습**: 불량 Master 관리, 학습 이미지 등록, 위치 라벨링, 승인
- **분석**: 이미지 일괄 등록, 자동 불량 매칭, 검수, 대시보드

매칭 엔진은 결정론적 Rule 검출과 kNN 유사도 검색을 결합한다. 두 판정이 불일치하면 검수 큐로 올라가고,
사람의 수정이 곧 다음 학습 데이터가 된다. 딥러닝 프레임워크와 GPU를 쓰지 않는다.

## 계획된 스택

TypeScript · Vite (single-file build) · IndexedDB · Canvas 2D · ECharts

## 로드맵

1. 전처리 파이프라인 — 원 검출, FPCB 6시 회전 보정, 정규화 프레임
2. Rule 검출기 — 암점/명점/명선/암선/미점등
3. 라벨링 UI 및 학습 데이터 관리
4. kNN 유사도 검색 및 융합 판정
5. 대시보드 — 불량 비율, 위치 상관성, Lot/설비/공정 분석

전처리가 틀리면 이후 단계가 모두 무너지므로, 실제 점등 이미지로 원 검출과 회전 보정을 먼저 검증한다.
