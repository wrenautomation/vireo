/**
 * A subject's live numbers per segment: each sample's rates with a 95% range and P(best) among
 * the samples shipped to the same channel. Rates come from `outcomes` (latest day per ship).
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { Collector, Rate } from "./collect.js";
import type { Db } from "./db.js";
import { outcomes, samples, ships } from "./schema.js";
import { pBest, posteriors, wilson } from "./stats.js";

export interface LiveRate {
  wins: number;
  of: number;
  rate: number | null;
  lo: number;
  hi: number;
  /** Among this channel's samples in this segment; null with one sample. */
  pBest: number | null;
}

export interface LiveRow {
  sample: number;
  channel: string;
  segment: string;
  ships: number;
  totals: Record<string, number>;
  /** The collector's means, weighted by its weight count. */
  means: Record<string, number>;
  rates: Record<string, LiveRate>;
}

export interface Live {
  segments: string[];
  rows: LiveRow[];
  /** Each channel's rates, the first leads. */
  rates: Record<string, readonly Rate[]>;
}

export async function live(
  db: Db,
  collectors: readonly Collector[],
  subjectId: number,
): Promise<Live> {
  const byChannel = new Map(collectors.map((c) => [c.channel, c]));
  const rates = Object.fromEntries(collectors.map((c) => [c.channel, c.rates]));
  const shipRows = await db
    .select({ id: ships.id, sample: ships.sampleId, channel: ships.channel })
    .from(ships)
    .innerJoin(samples, eq(samples.id, ships.sampleId))
    .where(eq(samples.subjectId, subjectId));
  if (!shipRows.length) return { segments: [], rows: [], rates };
  const byShip = new Map(shipRows.map((s) => [s.id, s]));
  // latest day per ship, segment, metric
  const got = await db
    .selectDistinctOn([outcomes.shipId, outcomes.segment, outcomes.metric], {
      ship: outcomes.shipId,
      segment: outcomes.segment,
      metric: outcomes.metric,
      value: outcomes.value,
    })
    .from(outcomes)
    .where(
      inArray(
        outcomes.shipId,
        shipRows.map((s) => s.id),
      ),
    )
    .orderBy(outcomes.shipId, outcomes.segment, outcomes.metric, sql`${outcomes.day} desc`);

  const meansOf = (channel: string) => byChannel.get(channel)?.means;
  // sample × channel × segment
  const acc = new Map<string, { row: LiveRow; shipIds: Set<number> }>();
  for (const o of got) {
    const s = byShip.get(o.ship);
    if (!s) continue;
    const key = `${s.sample}|${s.channel}|${o.segment}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        row: {
          sample: s.sample,
          channel: s.channel,
          segment: o.segment,
          ships: 0,
          totals: {},
          means: {},
          rates: {},
        },
        shipIds: new Set(),
      };
      acc.set(key, a);
    }
    a.shipIds.add(o.ship);
    if (!meansOf(s.channel)?.metrics.includes(o.metric))
      a.row.totals[o.metric] = (a.row.totals[o.metric] ?? 0) + o.value;
  }
  // means: each ship's value weighted by its weight count in that segment
  const valueAt = new Map(got.map((o) => [`${o.ship}|${o.segment}|${o.metric}`, o.value]));
  for (const a of acc.values()) {
    a.row.ships = a.shipIds.size;
    const m = meansOf(a.row.channel);
    if (!m) continue;
    for (const metric of m.metrics) {
      let w = 0;
      let v = 0;
      for (const ship of a.shipIds) {
        const x = valueAt.get(`${ship}|${a.row.segment}|${metric}`);
        if (x == null) continue;
        const wt = valueAt.get(`${ship}|${a.row.segment}|${m.weight}`) ?? 0;
        w += wt;
        v += wt * x;
      }
      if (w > 0) a.row.means[metric] = v / w;
    }
  }

  const rows = [...acc.values()].map((a) => a.row);
  // P(best) per channel × segment × rate
  const groups = new Map<string, LiveRow[]>();
  for (const r of rows) {
    const k = `${r.channel}|${r.segment}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const g of groups.values()) {
    for (const rate of rates[g[0]?.channel ?? ""] ?? []) {
      const arms = g.map((r) => {
        const of = r.totals[rate.of] ?? 0;
        return { successes: Math.min(r.totals[rate.wins] ?? 0, of), trials: of };
      });
      const p = g.length > 1 ? pBest(posteriors(arms, 2)) : null;
      g.forEach((r, i) => {
        const { successes: wins, trials: of } = arms[i] as { successes: number; trials: number };
        const [lo, hi] = wilson(wins, of);
        r.rates[rate.name] = {
          wins,
          of,
          rate: of > 0 ? wins / of : null,
          lo,
          hi,
          pBest: p ? (p[i] ?? null) : null,
        };
      });
    }
  }
  const segments = [...new Set(rows.map((r) => r.segment))].sort((a, b) =>
    a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b),
  );
  return { segments, rows, rates };
}
