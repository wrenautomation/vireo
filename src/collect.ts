/**
 * Live numbers for shipped samples. A host registers one collector per channel; `collect` asks
 * each live ship's collector for totals to today per segment and writes them to `outcomes`.
 * Every ship writes `all` plus its breakdowns, so `all` sums across ships with no double count.
 */
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { atomic, type Db } from "./db.js";
import { outcomes, ships } from "./schema.js";

export type Ship = typeof ships.$inferSelect;

/** One rate: `wins` over `of`, both metric names the collector writes. */
export interface Rate {
  name: string;
  wins: string;
  of: string;
}

export interface OutcomeRow {
  segment: string;
  metric: string;
  value: number;
}

export interface Collector {
  /** The `ships.channel` it reads: `post`, `site`, `email`. */
  channel: string;
  /** What the target id looks like, for the CLI's help: "content draft id". */
  target: string;
  /** The rates pages and P(best) read; the first leads. */
  rates: readonly Rate[];
  /** Metrics averaged across ships (weighted by the `weight` count), not summed. */
  means?: { metrics: readonly string[]; weight: string };
  /** Totals to today per segment for one ship; [] when the target is unknown. */
  read(ship: Ship): Promise<OutcomeRow[]>;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Collect every live ship (or one), write today's totals. A ship ended over a day ago stays as it
 * last stood. A ship whose channel has no collector is listed, not read.
 */
export async function collect(db: Db, collectors: readonly Collector[], o: { ship?: number } = {}) {
  const day = today();
  const by = new Map(collectors.map((c) => [c.channel, c]));
  const live = await db
    .select()
    .from(ships)
    .where(
      and(
        o.ship != null ? eq(ships.id, o.ship) : undefined,
        or(isNull(ships.endedAt), gte(ships.endedAt, sql`now() - interval '1 day'`)),
      ),
    );
  const done: { ship: number; rows: number; unread?: string }[] = [];
  for (const s of live) {
    const c = by.get(s.channel);
    if (!c) {
      done.push({ ship: s.id, rows: 0, unread: `no collector for ${s.channel}` });
      continue;
    }
    const rows = await c.read(s);
    if (rows.length)
      await atomic(db, (tx) =>
        tx
          .insert(outcomes)
          .values(rows.map((r) => ({ shipId: s.id, day, ...r })))
          .onConflictDoUpdate({
            target: [outcomes.shipId, outcomes.segment, outcomes.day, outcomes.metric],
            set: { value: sql`excluded.value`, fetchedAt: sql`now()` },
          }),
      );
    done.push({ ship: s.id, rows: rows.length });
  }
  return { day, ships: done };
}
