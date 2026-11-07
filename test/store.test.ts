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

  it("takes a live page by link and refuses other schemes", async () => {
    await v.newSubject({ slug: "bg", name: "Background", kind: "page", by: "me" });
    const b = await v.addBatch("bg", {
      why: "particles vs a flow field",
      samples: [{ media: "https://a1b2c3.example.pages.dev/", poster: "s3://bucket/media/a.jpg" }],
    });
    const [open] = await v.queue("bg");
    expect(open?.samples[0]?.media).toBe("https://a1b2c3.example.pages.dev/");
    await v.closeBatch(b.batch, null, "me");
    for (const media of ["http://plain.example/", "javascript:alert(1)", "data:text/html,x"])
      await expect(v.addBatch("bg", { why: "bad scheme", samples: [{ media }] })).rejects.toThrow(
        "s3:// or https://",
      );
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

  it("numbers batches per subject and closes by <subject>:<n>", async () => {
    await v.newSubject({ slug: "count", name: "Count", kind: "text", by: "me" });
    const one = await v.addBatch("count", { why: "first", samples: [{ body: "a" }] });
    const two = await v.addBatch("count", { why: "second", samples: [{ body: "b" }] });
    expect([one.n, two.n]).toEqual([1, 2]);
    expect(two.batch).toBeGreaterThan(2); // other subjects took lower ids
    const closed = await v.closeBatch("count:2", "ok", "me");
    expect(closed).toMatchObject({ id: two.batch, n: 2 });
    await expect(v.closeBatch("count:9", null, "me")).rejects.toMatchObject({ status: 404 });
    await expect(v.closeBatch("count", null, "me")).rejects.toThrow(/<subject>:<n>/);
    const f = await v.feedback("count");
    expect(f.batches.map((b) => b.n)).toEqual([1, 2]);
  });

  it("keeps lineage: names, crosses, what each parent gave", async () => {
    await v.newSubject({ slug: "cross", name: "Cross", kind: "text", by: "me" });
    const a = await v.addBatch("cross", {
      why: "two seeds",
      samples: [{ body: "warm", name: "Warm" }, { body: "grid" }],
    });
    const [warm, grid] = a.samples as [number, number];
    await v.closeBatch(a.batch, null, "me");
    const b = await v.addBatch("cross", {
      why: "cross them",
      samples: [
        {
          body: "warm grid",
          name: "Warm grid",
          parents: [{ id: warm, took: "the palette" }, grid],
        },
      ],
    });
    const f = await v.feedback("cross");
    const child = f.batches[1]?.samples[0];
    expect(child?.name).toBe("Warm grid");
    expect(child?.parents).toEqual([
      { id: warm, took: "the palette" },
      { id: grid, took: null },
    ]);
    expect(f.batches[0]?.samples.find((s) => s.id === warm)?.parents).toEqual([]);
    expect(b.samples).toHaveLength(1);

    const other = (await v.feedback("hero")).batches[0]?.samples[0]?.id as number;
    await expect(
      v.addBatch("cross", { why: "x", samples: [{ body: "x", parents: [other] }] }),
    ).rejects.toThrow(/not a sample of cross/);
    await expect(
      v.addBatch("cross", { why: "x", samples: [{ body: "x", parents: [warm, warm] }] }),
    ).rejects.toThrow(/twice/);
    await expect(
      v.addBatch("cross", { why: "x", samples: [{ body: "x", name: "n".repeat(61) }] }),
    ).rejects.toThrow(/60/);
  });
});
