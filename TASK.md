# TASK.md
# Watch Display Defect Analysis Application Upgrade

## 0. Task Summary

Update the existing `Defect_analysis` project into an offline-first Watch Display defect analysis application that supports practical Display Engineer workflows.

The application must analyze Red, Green, Blue, and White lighting images for each panel and provide:

- image preprocessing;
- circular Active Area detection;
- FPCB direction normalization;
- defect candidate detection;
- defect classification;
- panel-level R/G/B/W correlation;
- engineer review and correction;
- defect position visualization;
- Lot / equipment / process analysis;
- threshold and label configuration management;
- offline operation without sending images to an external server.

The application is not intended to replace an engineer's final judgement.

The static/offline application is a decision-support and `OK/NG/HOLD` export tool. It must not be described as direct PLC/MES actuation. Any unresolved, missing, failed or unvalidated case must export `HOLD`, never `OK`.

Target workflow:

```text
Image Upload
→ Panel Grouping
→ Preprocessing Quality Check
→ Active Area Detection
→ FPCB 6 o'clock Alignment
→ Illumination Normalization
→ Rule-Based Defect Detection
→ kNN / Similarity Support
→ Panel-Level R/G/B/W Correlation
→ Review Queue
→ Engineer Approval
→ Dashboard / Export
```

---

# 1. General Instructions for Codex

Before changing any code:

1. Read this entire file.
2. Read `AGENTS.md` if it exists.
3. Inspect the complete repository structure.
4. Identify the framework, build tool, image-processing modules, data types, storage layer, IndexedDB schema, UI page structure, dashboard implementation, test framework and deployment workflow.
5. Run current baseline checks: dependency installation if needed, tests, lint, type check and production build.
6. Document baseline status before implementation.
7. Do not perform a broad rewrite unless the current architecture makes the requested changes impossible.
8. Preserve existing working features and static/offline deployment.

After implementation:

1. Run all available tests.
2. Run lint and type checking.
3. Run the production build.
4. Confirm GitHub Pages or static deployment compatibility.
5. Report changed files, implemented functions, unresolved assumptions, test results, migration risks and real-image validation items.

---

# 2. Product Objective

The purpose of this application is to reduce manual judgement variation and improve traceability when Display Engineers analyze Watch Display lighting defects.

Supported defect classes:

- 양품
- 암점 小
- 암점 中
- 암점 大
- 명점
- 명선(가로)
- 명선(세로)
- 암선
- 구동불량
- 미점등
- 복수불량

Important:

- `복수불량` is a final panel-level judgement.
- Individual defects must still be stored separately.
- Do not discard component-level defect records when a panel is classified as `복수불량`.

---

# 3. Non-Negotiable Constraints

## 3.1 Offline operation

The application must continue to work without an external API, external image server, cloud inference, remote image upload, user authentication server or external database.

Display images and metadata must not be transmitted outside the browser.

## 3.2 Static deployment

Preserve compatibility with static hosting such as GitHub Pages.

Do not introduce a backend dependency unless explicitly approved in a later task.

## 3.3 Explainable judgement

Every automatic judgement must retain the evidence used to reach it.

For each detected defect, save:

- detector name;
- detector version;
- threshold version;
- source pattern;
- location;
- area;
- contrast;
- confidence;
- rule result;
- similarity result;
- final suggested label;
- review status;
- review reason.

## 3.4 Engineer review

AI or similarity output must not silently override deterministic results.

When results disagree or preprocessing quality is insufficient, send the item to a review queue.

## 3.5 Existing data safety

If IndexedDB is already used:

- inspect the current schema;
- add a migration strategy;
- preserve existing records;
- avoid destructive schema resets;
- document version changes.

---

# 4. Input Data Model

Each panel should support four lighting images:

- Red
- Green
- Blue
- White

Recommended filename convention:

```text
LOTID_PANELID_PATTERN.png
```

Examples:

```text
LOT20260709A_P0001_R.png
LOT20260709A_P0001_G.png
LOT20260709A_P0001_B.png
LOT20260709A_P0001_W.png
```

The UI must also support manual mapping when filenames do not follow the convention.

Store at minimum:

- Lot ID
- Panel ID
- Model
- Pattern
- Process
- Equipment ID
- Reviewer
- Upload date
- Original filename
- Image width
- Image height
- Image source type
- Synthetic / Real flag
- Capture Profile version and immutable acquisition snapshot
- Golden Reference Profile version
- camera, lens, distance, angle, exposure, gain, gamma, bit depth and file format
- auto exposure, auto white balance and HDR state
- dark-frame, flat-field and calibration version

Auto exposure, auto white balance and HDR should be locked for production validation. JPEG, nonlinear camera processing and missing capture metadata must be treated as review risks. A capture profile becomes validated only after a known-good panel repeatability check.

Golden references must be managed per `Model × Pattern × Capture Profile`. Store expected mean-luminance ranges and the identifier/hash of any local reference-image set. Reference similarity is valid only after geometric registration and exposure compatibility have been confirmed.

---

# 5. Coordinate System

All position analysis must use a normalized circular coordinate system.

Reference:

- FPCB / Bending direction = 6 o'clock
- 6 o'clock = 0 degrees
- clockwise direction = positive
- Active Area center = coordinate origin

Store:

- x_ratio
- y_ratio
- radius_ratio
- angle_degree
- region
- bounding box
- centroid
- mask area
- defect area ratio

The same physical location should map to the same normalized coordinates even when source image size or orientation differs.

---

# 6. Common Image Preprocessing Pipeline

Create or refactor the preprocessing pipeline as an independent module.

The pipeline should include:

1. Load original image.
2. Preserve original image dimensions.
3. Convert to a working color space.
4. Detect circular Active Display Area.
5. Estimate Active Area center and radius.
6. Create an Active Area mask.
7. Detect or receive FPCB/Bending direction.
8. Rotate image so FPCB is at 6 o'clock.
9. Normalize Active Area to 512 × 512.
10. Estimate low-frequency illumination background.
11. Generate normalized luminance image.
12. Generate bright residual image.
13. Generate dark residual image.
14. Calculate preprocessing quality metrics.
15. Generate intermediate preview images for engineer inspection.

Store numeric evidence, masks/thumbnails and algorithm versions by default. Full residual frames may be regenerated on demand; do not retain unnecessary full-resolution duplicates in IndexedDB.

Do not permanently resize or overwrite the original image.

---

# 7. Preprocessing Quality Validation

Calculate and store:

- Active Area detection success;
- center coordinate;
- radius;
- center offset ratio;
- radius confidence;
- circularity;
- FPCB alignment confidence;
- rotation angle;
- clipping ratio;
- blur score;
- mean luminance;
- luminance standard deviation;
- raw saturation ratio;
- background saturation ratio after excluding detected bright-defect regions;
- local defect saturation ratio;
- active pixel coverage;
- pattern completeness.

Create `preprocessingStatus` values:

- PASS
- REVIEW
- FAIL

Send to review when Active Area is not detected, circle confidence is low, FPCB direction is missing or uncertain, image is heavily blurred, clipping is excessive, pattern mapping is incomplete, or source image is too dark or overexposed.

Do not generate an automatic final judgement for `FAIL`.

Do not treat a saturated true bright dot/line as global capture overexposure. Use background saturation for capture quality and preserve local defect saturation as evidence.

---

# 8. Defect Detection Architecture

Use a modular detector architecture.

Suggested interface:

```ts
interface DefectDetector {
  id: string;
  name: string;
  version: string;
  supportedPatterns: PatternType[];
  detect(input: DetectionInput, config: DetectorConfig): DetectionResult[];
}
```

Recommended detectors:

- DarkDotDetector
- BrightDotDetector
- DarkLineDetector
- BrightLineDetector
- NoDisplayDetector
- PartialNoDisplayDetector
- DrivingAbnormalityFeatureExtractor

Keep detector logic separate from UI components. Each detector must be independently testable.

---

# 9. Dark Dot Detection

Detect local regions darker than their surrounding emission area.

Suggested algorithm:

1. Use the dark residual image.
2. Apply local or adaptive threshold.
3. Apply morphology opening for noise removal and closing for fragmented components if needed.
4. Run connected-component analysis.
5. Remove components outside Active Area, edge artifacts, components below minimum area and components with insufficient contrast.
6. Merge nearby components according to configurable distance.
7. Calculate component area, total dark area, area ratio, local contrast, mean residual, circularity, bounding box, centroid and normalized polar location.

Dark grading:

```text
dark_area_ratio =
sum of approved dark component mask area
/
Active Display Area
```

- 암점 小: 0% < ratio ≤ 5%
- 암점 中: 5% < ratio ≤ 15%
- 암점 大: ratio > 15%

Store both total dark area ratio and individual component area ratios. Thresholds must be configurable and versioned.

Store `automaticDarkAreaRatio` and `reviewedDarkAreaRatio` separately. Use the union of valid masks so overlapping regions are never counted twice. Manual boxes are approximate; production area grading should support polygon/brush or segmentation-assisted mask correction.

---

# 10. Bright Dot Detection

Detect local regions brighter than the surrounding emission area.

Suggested algorithm:

1. Use bright residual image.
2. Apply local threshold.
3. Remove saturated reflection and camera artifacts where possible.
4. Run connected-component analysis.
5. Filter by minimum area, maximum area, local contrast, persistence across patterns and Active Area edge distance.
6. Save location, area, contrast, residual strength, source pattern and pattern occurrence count.

Cross-pattern interpretation should show only R, only G, only B, only W, and same-position occurrence in multiple patterns.

Do not automatically infer a physical root cause unless validated.

---

# 11. Dark Line and Bright Line Detection

Use both projection-profile and shape-based methods.

Use a dual-resolution strategy: the 512 × 512 frame for global search and coordinates, plus an original/high-resolution normalized ROI projection pass when the source Active diameter is large. Map high-resolution evidence back to the 512 coordinate system.

Horizontal line:

1. Calculate row mean or trimmed mean.
2. Remove low-frequency trend.
3. Detect significant negative or positive row residual.
4. Merge consecutive abnormal rows.
5. Measure line length and thickness.

Vertical line:

1. Calculate column mean or trimmed mean.
2. Remove low-frequency trend.
3. Detect significant negative or positive column residual.
4. Merge consecutive abnormal columns.
5. Measure line length and thickness.

Shape analysis should calculate width, height, aspect ratio, orientation, continuity, thickness, length, gap ratio and edge contact.

Use configurable minimum continuity, maximum gap ratio, thick-line aspect criteria and multi-scale/native-diameter activation. Separate thick Line from broad region-Mura/partial-no-display candidates.

Classification:

- negative horizontal → horizontal dark line
- negative vertical → vertical dark line
- positive horizontal → 명선(가로)
- positive vertical → 명선(세로)

The top-level taxonomy may store all dark lines as `암선`, but orientation must be kept as a secondary attribute.

---

# 12. No Display Detection

Full no display should use Active Area mean luminance, percentile luminance, illuminated area ratio, histogram distribution and expected pattern brightness range.

A single dark photograph is not sufficient to distinguish true no-display from underexposure. Automatic full-no-display requires a validated Capture Profile and matching Model/Pattern Golden range. Otherwise use `UNDEREXPOSED_REVIEW` and Sorting `HOLD`.

Partial no display:

1. Divide normalized Active Area into blocks or use region segmentation.
2. Estimate expected background.
3. Detect large contiguous regions with severe luminance loss.
4. Calculate non-emitting area ratio, region location, edge connectivity, shape and persistence across patterns.

Store subtype:

- FULL
- PARTIAL

Top-level label remains `미점등`.

---

# 13. Lighting Abnormality / Driving Defect Support

Do not classify a panel as `구동불량` merely because dot or line detectors found nothing.

Extract engineer-readable features:

- global mean luminance;
- standard deviation;
- histogram distribution;
- radial uniformity;
- sector uniformity;
- center-to-edge gradient;
- left/right asymmetry;
- upper/lower asymmetry;
- block deviation map;
- large abnormal region ratio;
- row periodicity;
- column periodicity;
- SSIM or reference similarity;
- R/G/B/W cross-pattern consistency.

Until sufficient real validation data exists, treat `구동불량` as a broad review category and require reviewer confirmation.

---

# 14. R/G/B/W Panel-Level Correlation

Group images by Panel ID.

Match defect candidates across patterns using:

- centroid distance;
- overlap ratio;
- area similarity;
- defect polarity;
- orientation;
- shape similarity.
- registered mask IoU;
- length, thickness, continuity and topology similarity.

Pattern confirmation counts must be configurable by defect family. Do not universally require two patterns: a valid pattern-specific subpixel defect may occur in only one pattern. A single-pattern accepted candidate must remain reviewable with `PATTERN_ONLY_DEFECT` evidence.

Display patterns where the defect appears, same-location match status, pattern-only defects, missing pattern and conflicting classification.

Panel-level interpretation should support, not replace, engineer judgement.

---

# 15. Hybrid Rule + Similarity Decision

Keep kNN similarity as a secondary decision source.

Save:

- rule result;
- rule confidence;
- kNN result;
- kNN similarity score;
- agreement status;
- final suggested label;
- reviewer final label.

Agreement status:

- MATCH
- PARTIAL_MATCH
- CONFLICT
- NOT_AVAILABLE

When conflict occurs, send to review queue.

---

# 16. Review Queue

Review reasons must include:

- PREPROCESSING_FAILED
- ACTIVE_AREA_LOW_CONFIDENCE
- FPCB_ALIGNMENT_LOW_CONFIDENCE
- PATTERN_MISSING
- RULE_KNN_CONFLICT
- LOW_CONFIDENCE
- MULTIPLE_DEFECTS
- EDGE_ADJACENT_DEFECT
- OUT_OF_VALIDATED_RANGE
- DRIVING_ABNORMALITY_REVIEW
- MANUAL_REQUEST

The reviewer screen should show original image, normalized image, residual images, mask overlay, detected regions, detector evidence, R/G/B/W comparison, automatic labels, threshold version and reviewer correction controls.

Save the original result and reviewer correction separately.

---

# 17. Threshold Management

Remove production thresholds from UI components.

Create a versioned threshold configuration:

```json
{
  "version": "1.0.0",
  "updatedAt": "",
  "updatedBy": "",
  "preprocessing": {},
  "darkDot": {},
  "brightDot": {},
  "darkLine": {},
  "brightLine": {},
  "noDisplay": {},
  "partialNoDisplay": {},
  "drivingAbnormality": {},
  "reviewRules": {}
}
```

Support export JSON, import JSON, validation, reset to default, duplicate version, display active version and attach threshold version to every analysis result.

Do not allow invalid threshold JSON to overwrite active configuration.

---

# 18. Label Data Management

Support export and import for reviewed label data.

Store Panel ID, image IDs, pattern, automatic result, reviewer result, defect list, location, reviewer, review date, notes, threshold version and detector version.

Approved labels may be used as kNN reference data.

Only Reviewer or Admin approval should mark data as training-ready.

---

# 19. Dashboard Requirements

KPI overview:

- total panels;
- total images;
- good panels;
- defective panels;
- review queue count;
- preprocessing failure count;
- automatic/reviewer agreement rate;
- synthetic image count;
- real image count.

Defect distribution:

- count and percentage by defect class;
- severity;
- multiple-defect frequency;
- reviewer correction rate.

Pattern analysis:

- R;
- G;
- B;
- W;
- cross-pattern occurrence.

Circular heatmap requirements:

- circle represents Active Area;
- 6 o'clock represents FPCB;
- clockwise positive angle;
- filter by defect type, Model, Lot, equipment, process and pattern;
- show sample count;
- avoid misleading heatmaps when sample count is too low.

Lot/equipment/process analysis:

- defect rate;
- defect composition;
- top defect type;
- repeat-location tendency;
- review correction rate;
- sample size.

Do not imply causation based only on correlation.

Validation dashboard must separate synthetic and real images and show TP, FP, TN, FN, precision, recall, F1-score, false-positive rate, false-negative rate, confusion matrix, preprocessing success rate and average processing time.

Do not claim production accuracy without real-image ground truth.

Split validation data by Panel and preferably by Lot/equipment/time, never by random images. Exclude the same Panel and near-duplicate capture from kNN neighbors. Ground truth should record reviewer identity, double-review/adjudication where available, and detector/threshold/capture/Golden versions. Report confidence intervals, per-class recall, false-accept (defect escape) and false-reject rates. Production acceptance limits must prioritize the agreed defect-escape risk, not F1 alone.

---

# 20. User Roles

Support logical roles:

- Admin
- Reviewer
- Viewer

Offline MVP may use a local role selector rather than authentication.

The local selector is a workflow display mode, not authentication or security access control. Any production protection of thresholds/approval requires an external account/OS control or signed configuration beyond this static app.

Admin can manage thresholds, labels, training approval, backup and all dashboards.
Reviewer can inspect, correct and approve results.
Viewer can view approved results and dashboards only.

---

# 21. Data Storage and Migration

Inspect the current IndexedDB implementation before changing schema.

Recommended entities:

- panels
- images
- preprocessingResults
- detectionResults
- panelDecisions
- reviews
- thresholdConfigs
- labelSets
- equipmentMetadata
- processMetadata
- appSettings

Every entity should have id, createdAt, updatedAt and schemaVersion.

Implement migration from the current schema without deleting current user data.

Add backup and restore support if feasible.

Manual remapping must guard cross-Lot/cross-Model merges, preserve the original mapping, append an audit history and support Undo.

## 21.1 Sorting Safety Boundary

Panel disposition values:

- `OK`: validated complete inputs and final good judgement;
- `NG`: validated complete inputs and confirmed defect judgement;
- `HOLD`: preprocessing failure/review, missing pattern, unvalidated or mismatched Capture/Golden profile, Rule/kNN conflict, low confidence or manual review pending.

If a later system performs physical sorting, define barcode traceability, PLC/MES handshake, timeout, retry/idempotency, duplicate prevention, operator override audit, configuration locking and rollback in a separate approved backend/integration task.

---

# 22. Performance Requirements

Target browser operation:

- no external server;
- no page freeze during batch processing;
- show progress;
- allow cancellation;
- process images in manageable batches;
- release large image buffers after use.

Use a Web Worker when image processing causes visible UI blocking.

Avoid retaining unnecessary full-resolution duplicates in memory.

---

# 23. Testing Requirements

Add tests for core logic.

Minimum tests:

## Preprocessing

- circular ROI detection;
- failed ROI detection;
- coordinate normalization;
- rotation mapping;
- pattern grouping;
- preprocessing status.
- Capture/Golden mismatch;
- global background versus local defect saturation.

## Dark dot

- one dark component;
- multiple dark components;
- threshold boundary;
- edge artifact exclusion;
- small noise exclusion;
- area-ratio grading.

## Bright dot

- one bright component;
- saturated artifact;
- edge exclusion;
- cross-pattern occurrence.

## Line defects

- horizontal dark line;
- vertical dark line;
- horizontal bright line;
- vertical bright line;
- short artifact rejection;
- broken-line merging.
- high-resolution projection evidence;
- continuity and gap-ratio boundary.

## No display

- full no display;
- partial no display;
- low exposure but valid display;
- missing pattern.
- unvalidated underexposure must HOLD rather than auto-call no-display.

## Review queue

- preprocessing fail;
- Rule/kNN conflict;
- low confidence;
- multiple defects;
- edge-adjacent case.

## Threshold config

- valid import;
- invalid import;
- default restore;
- version attachment;
- migration.

Use synthetic fixtures for automated tests, but clearly mark them as synthetic.

---

# 24. UI / UX Requirements

Use Display Engineer terminology and avoid generic AI marketing language.

Recommended pages or tabs:

1. Upload / Panel Mapping
2. Analysis
3. Review Queue
4. Training Data
5. Dashboard
6. Threshold Settings
7. Data Backup / Restore
8. Help / Algorithm Guide

For each automatic judgement, show what was detected, where it was detected, why it was detected, which threshold was exceeded, which pattern showed it, whether kNN agreed and whether engineer review is required.

---

# 25. Documentation to Add or Update

Create or update:

```text
docs/
├─ DEFECT_ANALYSIS_REQUIREMENTS.md
├─ IMAGE_PROCESSING_PIPELINE.md
├─ DEFECT_DETECTION_LOGIC.md
├─ DATA_MODEL.md
├─ THRESHOLD_CONFIG.md
├─ VALIDATION_GUIDE.md
└─ REAL_IMAGE_TUNING_GUIDE.md
```

Update `README.md` with project objective, offline security statement, supported defects, local execution, build, test, deployment, data backup warning and synthetic versus real validation warning.

---

# 26. Implementation Priority

## P0 — Required first

- repository and baseline analysis;
- capture profile and Golden reference model;
- fail-safe `OK/NG/HOLD` disposition;
- preprocessing quality metrics;
- threshold configuration model;
- modular detector interfaces;
- dark dot detector;
- bright dot detector;
- dark/bright line detectors;
- high-resolution projection Line detector;
- review reason model;
- IndexedDB migration;
- unit tests;
- build verification.

## P1 — Required next

- full and partial no-display;
- R/G/B/W panel correlation;
- review UI improvements;
- circular heatmap;
- dashboard filters;
- threshold import/export;
- label import/export.

## P2 — Follow-up

- driving abnormality feature extraction;
- validation dashboard;
- confusion matrix;
- real-image tuning workflow;
- Web Worker optimization;
- backup/restore refinement.

Do not begin P2 until P0 is stable.

---

# 27. Acceptance Criteria

The task is complete only when:

1. Existing app functions still work.
2. The project builds successfully.
3. Static deployment remains possible.
4. Images are not sent to external services.
5. Detection modules are separated from UI.
6. Thresholds are versioned and not hard-coded in UI.
7. Each detection result stores evidence.
8. Review queue reasons are explicit.
9. Dark dot, bright dot, line and no-display tests exist.
10. Existing IndexedDB data has a migration path.
11. Synthetic and real image validation are separated.
12. README and engineering documents are updated.
13. Unverified assumptions are clearly reported.

---

# 28. Prohibited Changes

Do not:

- upload images to an external API;
- add cloud inference;
- add analytics that transmit user data;
- delete existing IndexedDB records;
- silently change defect taxonomy;
- hard-code production thresholds in UI components;
- claim production accuracy from synthetic images;
- infer physical root cause as fact without validation;
- replace engineer approval with an automatic decision;
- perform unrelated redesign or broad refactoring;
- introduce a backend unless explicitly approved.

---

# 29. Expected Codex Work Sequence

## Phase 1 — Analyze only

Do not modify files yet.

Report repository structure, current architecture, current data model, current image pipeline, current detector logic, current dashboard, test/build status, gap analysis, implementation plan, migration risks and expected changed files.

## Phase 2 — Implement P0

Implement P0 only. Run tests, lint, type check and production build. Report results before proceeding.

## Phase 3 — Implement P1

Proceed only after P0 is stable. Run all checks again.

## Phase 4 — Final review

Inspect for regression, threshold hard-coding, storage incompatibility, external network calls, memory leaks, UI blocking, misleading metric labels and incorrect synthetic/real mixing.

---

# 30. Final Report Format

At the end, provide:

## Summary

Brief description of completed work.

## Changed Files

List each changed file and purpose.

## Implemented Features

Group by preprocessing, detection, review, dashboard, storage and documentation.

## Test Results

Show commands and results.

## Build Results

Show production build result.

## Migration Notes

Explain IndexedDB changes and data compatibility.

## Unverified Assumptions

List all items requiring real-image validation.

## Remaining Work

List P1/P2 items not completed.

## Recommended Real-Image Validation

Verify first:

1. Active Area detection;
2. FPCB 6 o'clock alignment;
3. exposure and blur;
4. dark-dot false positives;
5. bright-dot reflection artifacts;
6. line continuity;
7. partial no-display segmentation;
8. R/G/B/W coordinate matching;
9. threshold boundaries;
10. reviewer agreement.
