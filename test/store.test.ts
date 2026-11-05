/** The whole loop on PGlite: subject, batch, calls, notes, guides, ship, collect, live. Synthetic. */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Collector, type Db, type Vireo, vireo } from "../src/index.js";
import { testDb } from "./pglite.js";

/** Fake channel: each target's numbers live in a map the test sets. */
const counts = new Map<string, { segment: string; views: number; forms: number }[]>();
const page: Collector = {
  channel: "page",
  target: "page id",
  rates: [{ name: "form", wins: "forms", of: "views" }],
  async read(s) {
    return (counts.get(s.target) ?? []).flatMap((c) => [
      { segment: c.segment, metric: "views", value: c.views },
      { segment: c.segment, metric: "forms", value: c.forms },
    ]);
  },
};

let t: Awaited<ReturnType<typeof testDb>>;
let v: Vireo;
const writes: string[] = [];
beforeAll(async () => {
  t = await testDb();
  v = vireo({
    db: t.db as unknown as Db,
    collectors: [page],
    hooks: {
      onWrite: async (tx, by) => {
        await tx.execute(sql`select set_config('vireo.actor', ${by}, true)`);
        writes.push(by);
      },
    },
  });
});
afterAll(() => t.close());

describe("vireo", () => {
  it("runs the taste loop", async () => {
    await v.newSubject({ slug: "hero", name: "Hero", kind: "text", by: "me" });
    await expect(v.addBatch("hero", { why: " ", samples: [{ body: "x" }] })).rejects.toThrow(/why/);
    await expect(v.subjectOf("nope")).rejects.toMatchObject({ status: 404 });
    const g = await v.addGuide({ text: "Lead with the number", subject: "hero", by: "me" });
    const b = await v.addBatch("hero", {
      why: "number first vs story first",
      agent: "agent-1",
      samples: [
        { body: "3x replies", guides: [g.id] },
        { body: "A story", guides: [] },
        { body: "Plain", guides: [] },
      ],
    });
    expect(b.samples).toHaveLength(3);
    const [q] = await v.queue("hero");
    expect(q?.samples.map((s) => s.position).sort()).toEqual([0, 1, 2]);

    const [num, story, plain] = b.samples as [number, number, number];
    await v.judge(num, "amazing", "me");
    await v.judge(story, "bad", "me");
    await v.addNote(num, { anchor: { type: "quote", exact: "3x" }, tone: "good" }, "me");
    await expect(v.addNote(plain, {}, "me")).rejects.toThrow(/tone or words/);
    await v.closeBatch(b.batch, "more numbers", "me");
    await v.keep(num, true, "me");
    expect(writes).toContain("me");
    expect(await v.queue("hero")).toEqual([]);

    const f = await v.feedback("hero");
    expect(f.leaders[0]?.sample).toBe(num);
    expect(f.batches[0]?.note).toBe("more numbers");
    expect(f.batches[0]?.goodRate).toBeCloseTo(1 / 3);
    expect(f.guides[0]?.effect).toBeDefined();
    expect((await v.catalog()).map((c) => c.sample.id)).toEqual([num]);
    const [list] = await v.listSubjects();
    expect(list).toMatchObject({ samples: 3, kept: 1, toPick: 0 });
  });

  it("ships, collects and ranks per segment", async () => {
    const [num, story] = (await v.feedback("hero")).batches[0]?.samples.map((s) => s.id) ?? [];
    await expect(v.ship(num as number, { channel: "mail", target: "x" }, "me")).rejects.toThrow(
      /no collector for mail/,
    );
    const a = await v.ship(num as number, { channel: "page", target: "A" }, "me");
    await v.ship(story as number, { channel: "page", target: "B" }, "me");
    counts.set("A", [
      { segment: "all", views: 1000, forms: 80 },
      { segment: "paid", views: 400, forms: 40 },
    ]);
    counts.set("B", [
      { segment: "all", views: 1000, forms: 30 },
      { segment: "paid", views: 400, forms: 10 },
    ]);
    const done = await v.collect();
    expect(done.ships).toHaveLength(2);
    const live = (await v.feedback("hero")).live;
    expect(live.segments).toEqual(["all", "paid"]);
    const row = live.rows.find((r) => r.sample === num && r.segment === "all");
    expect(row?.rates.form?.rate).toBeCloseTo(0.08);
    expect(row?.rates.form?.pBest).toBeGreaterThan(0.99);
    // a second collect the same day overwrites, no double count
    await v.collect();
    const again = (await v.feedback("hero")).live.rows.find(
      (r) => r.sample === num && r.segment === "all",
    );
    expect(again?.totals.views).toBe(1000);

    await v.unship(a.id, "me");
    await expect(v.unship(a.id, "me")).rejects.toMatchObject({ status: 404 });
    expect((await v.shipsOf("hero")).length).toBe(2);
  });
});
