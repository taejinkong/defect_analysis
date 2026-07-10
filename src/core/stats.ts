/**
 * Statistics for the location-correlation dashboard, per docs/dashboard_spec.md
 * section 4. Everything here is a pure function so the definitions can be pinned
 * by test rather than eyeballed on a chart.
 */

export interface XY {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------- circular

export interface CircularStats {
  /** Mean direction in degrees, in the same convention as the input. */
  readonly meanDeg: number;
  /** Resultant length, 0 (uniform) to 1 (all one direction). */
  readonly resultant: number;
  /** Rayleigh test of uniformity. Small p means a real directional bias. */
  readonly rayleighP: number;
  readonly n: number;
}

/**
 * Circular mean and Rayleigh test for angles given in degrees.
 *
 * Angles are cyclic, so the arithmetic mean is meaningless (the mean of 350 and
 * 10 is 180, the opposite direction). This projects to the unit circle and
 * averages the vectors instead.
 */
export function circularStats(anglesDeg: readonly number[]): CircularStats {
  const n = anglesDeg.length;
  if (n === 0) return { meanDeg: 0, resultant: 0, rayleighP: 1, n: 0 };

  let sumCos = 0;
  let sumSin = 0;
  for (const deg of anglesDeg) {
    const rad = (deg * Math.PI) / 180;
    sumCos += Math.cos(rad);
    sumSin += Math.sin(rad);
  }
  const meanCos = sumCos / n;
  const meanSin = sumSin / n;
  const resultant = Math.hypot(meanCos, meanSin);

  let meanDeg = (Math.atan2(meanSin, meanCos) * 180) / Math.PI;
  if (meanDeg < 0) meanDeg += 360;

  // Rayleigh: Z = n*R^2. The exp(-Z) tail gets a first-order small-sample
  // correction (Zar), which matters for the modest n this dashboard sees.
  const z = n * resultant * resultant;
  const rayleighP = Math.exp(-z) * (1 + (2 * z - z * z) / (4 * n));

  return { meanDeg, resultant, rayleighP: Math.max(0, Math.min(1, rayleighP)), n };
}

// ---------------------------------------------------------------- DBSCAN

export interface Cluster {
  readonly indices: number[];
  readonly centroid: XY;
}

export interface DbscanResult {
  readonly clusters: Cluster[];
  readonly noise: number[];
}

/**
 * DBSCAN over 2-D points. `eps` is a distance in the same units as the points;
 * the dashboard feeds unit-circle coordinates, so eps is a fraction of the
 * active radius. A cluster needs at least `minSamples` points within eps.
 *
 * Density clustering, not k-means: the number of hotspots is discovered, not
 * chosen, and points belonging to no dense region are labelled noise rather
 * than forced into the nearest cluster.
 */
export function dbscan(points: readonly XY[], eps: number, minSamples: number): DbscanResult {
  const n = points.length;
  const UNVISITED = -2;
  const NOISE = -1;
  const labels = new Int32Array(n).fill(UNVISITED);
  const eps2 = eps * eps;

  const neighbors = (p: number): number[] => {
    const out: number[] = [];
    for (let q = 0; q < n; q++) {
      const dx = points[p]!.x - points[q]!.x;
      const dy = points[p]!.y - points[q]!.y;
      if (dx * dx + dy * dy <= eps2) out.push(q);
    }
    return out;
  };

  let clusterId = 0;
  const clusters: Cluster[] = [];

  for (let p = 0; p < n; p++) {
    if (labels[p] !== UNVISITED) continue;
    const seeds = neighbors(p);
    if (seeds.length < minSamples) {
      labels[p] = NOISE;
      continue;
    }

    labels[p] = clusterId;
    const members = [p];
    // seeds is grown in place; index-based loop so appended items are visited.
    for (let i = 0; i < seeds.length; i++) {
      const q = seeds[i]!;
      if (labels[q] === NOISE) {
        labels[q] = clusterId; // border point
        members.push(q);
      }
      if (labels[q] !== UNVISITED) continue;
      labels[q] = clusterId;
      members.push(q);
      const qn = neighbors(q);
      if (qn.length >= minSamples) for (const r of qn) seeds.push(r);
    }

    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += points[m]!.x;
      cy += points[m]!.y;
    }
    clusters.push({ indices: members, centroid: { x: cx / members.length, y: cy / members.length } });
    clusterId++;
  }

  const noise: number[] = [];
  for (let i = 0; i < n; i++) if (labels[i] === NOISE) noise.push(i);
  return { clusters, noise };
}

// ---------------------------------------------------------------- chi-square

export interface RegionChiSquare {
  readonly rows: { defectId: string; observed: [number, number, number]; residual: [number, number, number] }[];
  readonly chi2: number;
  readonly dof: number;
  readonly pValue: number;
  /** True when expected counts are too small for the test to mean anything. */
  readonly underpowered: boolean;
}

const REGION_ORDER = ['center', 'mid', 'edge'] as const;

/**
 * Test whether defects fall in center/mid/edge differently from what pure area
 * would predict. The null hypothesis is area-proportional, not uniform: the edge
 * ring is far larger than the center disc, so equal counts would already imply
 * center clustering. See docs/dashboard_spec.md section 4.3.
 */
export function regionChiSquare(
  byDefect: ReadonlyMap<string, { center: number; mid: number; edge: number }>,
  centerMaxR: number,
  midMaxR: number,
): RegionChiSquare {
  const areaFrac: [number, number, number] = [
    centerMaxR * centerMaxR,
    midMaxR * midMaxR - centerMaxR * centerMaxR,
    1 - midMaxR * midMaxR,
  ];

  const rows: RegionChiSquare['rows'] = [];
  let chi2 = 0;
  let smallCells = 0;
  let totalCells = 0;

  for (const [defectId, counts] of byDefect) {
    const observed: [number, number, number] = [counts.center, counts.mid, counts.edge];
    const rowTotal = observed[0] + observed[1] + observed[2];
    if (rowTotal === 0) continue;

    const residual: [number, number, number] = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      const expected = rowTotal * areaFrac[j]!;
      totalCells++;
      if (expected < 5) smallCells++;
      if (expected > 0) {
        const diff = observed[j]! - expected;
        residual[j] = diff / Math.sqrt(expected);
        chi2 += (diff * diff) / expected;
      }
    }
    rows.push({ defectId, observed, residual });
  }

  const dof = Math.max(1, rows.length * (REGION_ORDER.length - 1));
  const underpowered = totalCells > 0 && smallCells / totalCells > 0.2;
  return { rows, chi2, dof, pValue: chiSquareSurvival(chi2, dof), underpowered };
}

// ---------------------------------------------------------------- polar bins

export interface PolarBin {
  readonly sector: number;
  readonly ring: number;
  readonly count: number;
  /** Count divided by the cell's area share, so outer rings are not overweighted. */
  readonly density: number;
}

/**
 * Bin points (given as radius ratio and clock angle) into a sector-by-ring grid,
 * normalizing each cell by its area. Without the area normalization the outer
 * rings, which are physically larger, always look denser. See section 4.1.
 */
export function polarBins(
  points: readonly { rRatio: number; angleDeg: number }[],
  sectors: number,
  rings: number,
): PolarBin[] {
  const counts = new Int32Array(sectors * rings);
  for (const p of points) {
    const r = Math.min(rings - 1, Math.floor(Math.min(1, Math.max(0, p.rRatio)) * rings));
    let a = p.angleDeg % 360;
    if (a < 0) a += 360;
    const s = Math.min(sectors - 1, Math.floor((a / 360) * sectors));
    counts[s * rings + r]++;
  }

  const out: PolarBin[] = [];
  for (let s = 0; s < sectors; s++) {
    for (let r = 0; r < rings; r++) {
      const rIn = r / rings;
      const rOut = (r + 1) / rings;
      // Cell area as a fraction of the disc: annulus area over the sector count.
      const areaFrac = (rOut * rOut - rIn * rIn) / sectors;
      const count = counts[s * rings + r]!;
      out.push({ sector: s, ring: r, count, density: areaFrac > 0 ? count / areaFrac : 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- gamma

/** Upper regularized incomplete gamma Q(a, x) = 1 - P(a, x). */
function gammaSurvival(a: number, x: number): number {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  const gln = logGamma(a);
  if (x < a + 1) {
    // Series expansion for P(a, x), then complement.
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 200; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // Continued fraction for Q(a, x) directly.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Chi-square upper tail: P(X > chi2) for `dof` degrees of freedom. */
export function chiSquareSurvival(chi2: number, dof: number): number {
  if (chi2 <= 0) return 1;
  return gammaSurvival(dof / 2, chi2 / 2);
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coefficient of c) ser += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
