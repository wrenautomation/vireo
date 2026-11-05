import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fitPlackettLuce, pBest, posteriors, rateSplit, tiersToChoices, wilson } from "./stats.js";

// test-only rng: sfc32 keyed by sha256 (from wren experiments)
type Rng = () => number;

function seeded(seed: string | number): Rng {
  const d = createHash("sha256").update(String(seed), "utf8").digest();
  let a = d.readUInt32LE(0);
  let b = d.readUInt32LE(4);
  let c = d.readUInt32LE(8);
  let n = d.readUInt32LE(12);
  return () => {
    const t = (((a + b) | 0) + n) | 0;
    n = (n + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia and Tsang. */
function gamma(rng: Rng, shape: number): number {
  if (shape < 1) return gamma(rng, shape + 1) * (1 - rng()) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function betaDraw(rng: Rng, a: number, b: number): number {
  const x = gamma(rng, a);
  return x / (x + gamma(rng, b));
}

describe("tiersToChoices", () => {
  it("each item beats itself + every lower tier", () => {
    const c = tiersToChoices([["a"], ["b", "c"], [], ["d"]]);
    expect(c).toEqual([
      { set: ["a", "b", "c", "d"], winner: "a", weight: 1 },
      { set: ["b", "d"], winner: "b", weight: 1 },
      { set: ["c", "d"], winner: "c", weight: 1 },
    ]);
  });
});

describe("fitPlackettLuce", () => {
  it("recovers the order of true strengths from best-of-4 picks", () => {
    const truth: Record<string, number> = { a: 8, b: 4, c: 2, d: 1, e: 0.5, f: 0.25 };
    const ids = Object.keys(truth);
    const rng = seeded(7);
    const choices = [];
    for (let i = 0; i < 600; i++) {
      const set = [...ids].sort(() => rng() - 0.5).slice(0, 4);
      const total = set.reduce((t, s) => t + (truth[s] ?? 0), 0);
      let r = rng() * total;
      const winner =
        set.find((s) => {
          r -= truth[s] ?? 0;
          return r <= 0;
        }) ?? set[3];
      choices.push({ set, winner: winner as string });
    }
    const fit = fitPlackettLuce(ids, choices);
    expect(fit.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    const a = fit.find((s) => s.id === "a")?.strength ?? 0;
    const f = fit.find((s) => s.id === "f")?.strength ?? 1;
    expect(Math.log(a / f)).toBeGreaterThan(Math.log(32) * 0.7);
  });

  it("keeps unseen items finite at 1 and wide", () => {
    const fit = fitPlackettLuce(["x", "y", "z"], [{ set: ["x", "y"], winner: "x" }]);
    const z = fit.find((s) => s.id === "z");
    expect(z?.seen).toBe(0);
    expect(Number.isFinite(z?.strength)).toBe(true);
    expect(z?.se).toBeGreaterThan(fit.find((s) => s.id === "x")?.se ?? 0);
  });
});

describe("rateSplit", () => {
  it("says early under the minimum", () => {
    const r = rateSplit([
      { has: true, good: true },
      { has: false, good: false },
    ]);
    expect(r.diff).toBe(1);
    expect(r.early).toBe(true);
  });
});

describe("pBest", () => {
  it("splits evenly between equal posteriors and favors the stronger one", () => {
    const even = pBest([
      { a: 5, b: 95 },
      { a: 5, b: 95 },
    ]);
    expect(even[0]).toBeCloseTo(0.5, 3);
    const p = pBest([
      { a: 2, b: 298 },
      { a: 12, b: 288 },
    ]);
    expect(p[1]).toBeGreaterThan(0.99);
    expect((p[0] ?? 0) + (p[1] ?? 0)).toBeCloseTo(1, 9);
  });

  it("matches Monte Carlo on three close arms", () => {
    const post = [
      { a: 6, b: 294 },
      { a: 9, b: 291 },
      { a: 8, b: 292 },
    ];
    const rng = seeded("mc");
    const wins = [0, 0, 0];
    for (let i = 0; i < 40_000; i++) {
      const d = post.map(({ a, b }) => betaDraw(rng, a, b));
      const at = d.indexOf(Math.max(...d));
      wins[at] = (wins[at] ?? 0) + 1;
    }
    for (const [i, p] of pBest(post).entries()) expect(p).toBeCloseTo((wins[i] ?? 0) / 40_000, 2);
  });
});

describe("posteriors", () => {
  it("pools the prior at the locus mean", () => {
    const [a] = posteriors(
      [
        { successes: 0, trials: 0 },
        { successes: 10, trials: 498 },
      ],
      50,
    );
    expect((a?.a ?? 0) / ((a?.a ?? 0) + (a?.b ?? 0))).toBeCloseTo(11 / 500, 6);
  });
});

describe("wilson", () => {
  it("brackets the rate and stays in 0..1", () => {
    const [lo, hi] = wilson(5, 100);
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(0.05);
    expect(wilson(0, 10)[0]).toBe(0);
    expect(wilson(10, 10)[1]).toBe(1);
  });

  it("is wide at small n, narrow at large n", () => {
    const w = ([lo, hi]: [number, number]) => hi - lo;
    expect(w(wilson(1, 10))).toBeGreaterThan(w(wilson(100, 1000)));
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
