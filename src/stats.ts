/**
 * Vireo's numbers, pure: Plackett-Luce over taste tiers, Beta posteriors and P(best) over live
 * counts, Wilson ranges. No I/O; ids are opaque.
 */

/** Plackett-Luce from human picks: each choice = one winner out of a shown set.
 * P(i wins set S) = w_i / Σ_S w. Fit by MM (Hunter 2004). */
export interface Choice {
  readonly set: readonly string[];
  readonly winner: string;
  /** Default 1. A strong mark counts more. */
  readonly weight?: number;
}

export interface Strength {
  readonly id: string;
  /** Geometric mean of all fitted items = 1. */
  readonly strength: number;
  /** Chance to beat an average item head to head. */
  readonly pBeatsAverage: number;
  /** Std error of log strength (Fisher information, prior included). */
  readonly se: number;
  /** Choices the item was shown in. */
  readonly seen: number;
}

/**
 * Tiers best first (e.g. amazing, good, unmarked, bad) → choices.
 * Each item of a tier wins against itself + every lower tier; no order inside a tier.
 */
export function tiersToChoices(
  tiers: readonly (readonly string[])[],
  weights?: readonly number[],
): Choice[] {
  const out: Choice[] = [];
  for (let t = 0; t < tiers.length - 1; t++) {
    const lower = tiers.slice(t + 1).flat();
    if (!lower.length) continue;
    for (const id of tiers[t] ?? [])
      out.push({ set: [id, ...lower], winner: id, weight: weights?.[t] ?? 1 });
  }
  return out;
}

/**
 * MM fit. Prior: one win and one loss against a fixed reference of strength 1, so
 * unseen or always-winning items stay finite.
 */
export function fitPlackettLuce(
  ids: readonly string[],
  choices: readonly Choice[],
  opts: { prior?: number; iterations?: number; tolerance?: number } = {},
): Strength[] {
  const prior = opts.prior ?? 1;
  const iterations = opts.iterations ?? 500;
  const tolerance = opts.tolerance ?? 1e-9;
  const known = new Set(ids);
  const cs = choices.filter(
    (c) => known.has(c.winner) && c.set.every((s) => known.has(s)) && c.set.length > 1,
  );
  const w = new Map(ids.map((id) => [id, 1]));
  const wins = new Map(ids.map((id) => [id, prior]));
  for (const c of cs) wins.set(c.winner, (wins.get(c.winner) ?? 0) + (c.weight ?? 1));
  const member = new Map<string, Choice[]>(ids.map((id) => [id, []]));
  for (const c of cs) for (const s of c.set) member.get(s)?.push(c);

  for (let it = 0; it < iterations; it++) {
    const sums = cs.map((c) => c.set.reduce((t, s) => t + (w.get(s) ?? 1), 0));
    const sumOf = new Map(cs.map((c, i) => [c, sums[i] ?? 1]));
    let diff = 0;
    const next = new Map<string, number>();
    for (const id of ids) {
      const wi = w.get(id) ?? 1;
      let den = (2 * prior) / (wi + 1);
      for (const c of member.get(id) ?? []) den += (c.weight ?? 1) / (sumOf.get(c) ?? 1);
      next.set(id, (wins.get(id) ?? prior) / den);
    }
    for (const id of ids) {
      const v = next.get(id) ?? 1;
      diff = Math.max(diff, Math.abs(Math.log(v) - Math.log(w.get(id) ?? 1)));
      w.set(id, v);
    }
    if (diff < tolerance) break;
  }

  // centre: geometric mean 1
  const logMean = ids.reduce((t, id) => t + Math.log(w.get(id) ?? 1), 0) / Math.max(ids.length, 1);
  const g = Math.exp(logMean);
  return ids
    .map((id) => {
      const raw = w.get(id) ?? 1;
      let info = 2 * prior * (raw / (raw + 1)) * (1 / (raw + 1));
      for (const c of member.get(id) ?? []) {
        const p = raw / c.set.reduce((t, s) => t + (w.get(s) ?? 1), 0);
        info += (c.weight ?? 1) * p * (1 - p);
      }
      const strength = raw / g;
      return {
        id,
        strength,
        pBeatsAverage: strength / (strength + 1),
        se: 1 / Math.sqrt(info),
        seen: member.get(id)?.length ?? 0,
      };
    })
    .sort((a, b) => b.strength - a.strength);
}

/** Good rate with vs without a trait (a guide), with "too early" under `minN` total. */
export function rateSplit(
  rows: readonly { has: boolean; good: boolean }[],
  minN = 30,
): {
  with: { good: number; n: number };
  without: { good: number; n: number };
  diff: number | null;
  early: boolean;
} {
  const w = { good: 0, n: 0 };
  const wo = { good: 0, n: 0 };
  for (const r of rows) {
    const a = r.has ? w : wo;
    a.n++;
    if (r.good) a.good++;
  }
  const diff = w.n && wo.n ? w.good / w.n - wo.good / wo.n : null;
  return { with: w, without: wo, diff, early: w.n + wo.n < minN || !w.n || !wo.n };
}

/** Counts for one arm: wins out of shown. */
export interface Arm {
  readonly successes: number;
  readonly trials: number;
}

export interface Beta {
  readonly a: number;
  readonly b: number;
}

/** Each arm starts at the pooled mean rate, weighted as `prior` trials. */
export function posteriors(arms: readonly Arm[], prior: number): Beta[] {
  const s = arms.reduce((t, x) => t + x.successes, 0);
  const n = arms.reduce((t, x) => t + x.trials, 0);
  const mean = (s + 1) / (n + 2);
  return arms.map((x) => ({
    a: prior * mean + x.successes,
    b: prior * (1 - mean) + x.trials - x.successes,
  }));
}

const GRID = 512;

/**
 * P(each arm has the highest rate), by integrating the posteriors on a grid
 * over their joint range: P_i = sum f_i(x) * prod_j F_j(x). Deterministic, so the
 * same stats always give the same shares.
 */
export function pBest(post: readonly Beta[]): number[] {
  const n = post.length;
  if (n <= 1) return post.map(() => 1);
  let lo = 1;
  let hi = 0;
  for (const { a, b } of post) {
    const m = a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    lo = Math.min(lo, m - 8 * sd);
    hi = Math.max(hi, m + 8 * sd);
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, 1);
  const step = (hi - lo) / GRID;
  const lx = new Float64Array(GRID);
  const l1x = new Float64Array(GRID);
  for (let k = 0; k < GRID; k++) {
    const x = lo + (k + 0.5) * step;
    lx[k] = Math.log(x);
    l1x[k] = Math.log1p(-x);
  }
  // Row i: arm i's probability in each cell, and its CDF to the cell's middle.
  const mass = post.map(({ a, b }) => {
    const row = new Float64Array(GRID);
    let top = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < GRID; k++) {
      row[k] = (a - 1) * (lx[k] as number) + (b - 1) * (l1x[k] as number);
      top = Math.max(top, row[k] as number);
    }
    let sum = 0;
    for (let k = 0; k < GRID; k++) {
      const d = (row[k] as number) - top;
      row[k] = d < -40 ? 0 : Math.exp(d);
      sum += row[k] as number;
    }
    for (let k = 0; k < GRID; k++) row[k] = (row[k] as number) / sum;
    return row;
  });
  const cdf = mass.map((row) => {
    const out = new Float64Array(GRID);
    let run = 0;
    for (let k = 0; k < GRID; k++) {
      out[k] = run + (row[k] as number) / 2;
      run += row[k] as number;
    }
    return out;
  });
  const p = mass.map((row, i) => {
    let total = 0;
    for (let k = 0; k < GRID; k++) {
      let below = row[k] as number;
      if (below === 0) continue;
      for (let j = 0; j < n; j++) if (j !== i) below *= (cdf[j] as Float64Array)[k] as number;
      total += below;
    }
    return total;
  });
  const total = p.reduce((t, v) => t + v, 0) || 1;
  return p.map((v) => v / total);
}

/** Wilson 95% range: honest at small n, never past 0 or 1. */
export function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}
