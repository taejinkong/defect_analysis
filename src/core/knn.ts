import type { DefectId, Settings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import { cosine } from './features';

export interface SearchEntry {
  readonly panelId: number;
  readonly vector: Float32Array;
  readonly labelDefectId: DefectId;
  readonly lotId?: string;
  readonly panelCode?: string;
  readonly equipmentId?: string;
}

export interface Neighbor {
  readonly panelId: number;
  readonly defectId: DefectId;
  readonly similarity: number;
}

export interface KnnResult {
  readonly verdictId: DefectId;
  /** Winning vote share, 0..1. */
  readonly confidence: number;
  readonly neighbors: Neighbor[];
}

export type KnnOutcome =
  | { readonly status: 'ok'; readonly result: KnnResult }
  | { readonly status: 'insufficient-data'; readonly candidateCount: number }
  | { readonly status: 'no-match'; readonly neighbors: Neighbor[] };

/**
 * Similarity-weighted k-NN over the approved training panels.
 *
 * Brute-force cosine against every candidate: with L2-normalized vectors a
 * similarity is one dot product, and even ten thousand candidates is a few
 * milliseconds. See docs/matching_engine.md section 5.2.
 *
 * Returns a structured outcome rather than null so the fusion step and the UI
 * can tell "not enough training data yet" apart from "searched, found nothing
 * close" — they mean different things to the reviewer.
 */
export function knnSearch(
  query: Float32Array,
  candidates: readonly SearchEntry[],
  settings: Settings = DEFAULT_SETTINGS,
): KnnOutcome {
  if (candidates.length < settings['knn.min_train_panels']) {
    return { status: 'insufficient-data', candidateCount: candidates.length };
  }

  const scored: Neighbor[] = candidates.map((c) => ({
    panelId: c.panelId,
    defectId: c.labelDefectId,
    similarity: cosine(query, c.vector),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);

  const k = settings['knn.k'];
  const minSimilarity = settings['knn.min_similarity'];
  const top = scored.slice(0, k).filter((n) => n.similarity >= minSimilarity);

  if (top.length === 0) {
    // Report the nearest few anyway, so the reviewer sees how far off they were.
    return { status: 'no-match', neighbors: scored.slice(0, k) };
  }

  const weightByDefect = new Map<DefectId, number>();
  let total = 0;
  for (const neighbor of top) {
    weightByDefect.set(neighbor.defectId, (weightByDefect.get(neighbor.defectId) ?? 0) + neighbor.similarity);
    total += neighbor.similarity;
  }

  let verdictId: DefectId = top[0]!.defectId;
  let best = -1;
  for (const [defectId, weight] of weightByDefect) {
    if (weight > best) {
      best = weight;
      verdictId = defectId;
    }
  }

  return {
    status: 'ok',
    result: { verdictId, confidence: total > 0 ? best / total : 0, neighbors: top },
  };
}
