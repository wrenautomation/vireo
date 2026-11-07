/**
 * The vireo ledger: one method per thing a CLI, an agent or a page does, bound to the host's
 * ports (database, collectors, hooks). Ranking and rates are `stats.ts`.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type Collector, collect } from "./collect.js";
import { atomic, type Db, type Hooks, type Tx, VireoError } from "./db.js";
import { live } from "./live.js";
import {
  type Anchor,
  batches,
  type GuideState,
  guides,
  type Kind,
  lineage,
  notes,
  samples,
  ships,
  subjects,
  TAP,
  type Tone,
  VERDICTS,
  type Verdict,
  verdictOf,
} from "./schema.js";
import { fitPlackettLuce, rateSplit, type Strength, tiersToChoices } from "./stats.js";
import { isSource, type Source } from "./sync.js";

export interface Ports {
  db: Db;
  /** One per channel samples ship to; none means ships are kept but never read. */
  collectors?: readonly Collector[] | undefined;
  hooks?: Hooks | undefined;
}

/** `s3://` (the bucket signs it) or `https://` (served as is: a live page on its own origin). */
export const isMediaUri = (uri: string) => /^(s3|https):\/\/[^\s/]+/i.test(uri);

export interface NewSample {
  body?: string | null;
  /** `s3://` uri (the CLI uploads a local file first), or `https://` for a live page. */
  media?: string | null;
  poster?: string | null;
  /** Short name (60 chars at most), hidden while the person judges. */
  name?: string | null;
  /** Earlier samples of the same subject; the first is the main parent. Two or more = a cross. */
  parents?: readonly Parent[];
  guides?: number[];
  change?: string | null;
  /** A video's footage and kept spans, for synced play. */
  source?: Source | null;
}

/** A parent's id, or the id with what the child took from it. */
export type Parent = number | { id: number; took?: string | null };
const parentOf = (p: Parent) =>
  typeof p === "number" ? { id: p, took: null } : { id: p.id, took: p.took?.trim() || null };

export type SubjectRow = typeof subjects.$inferSelect;
export type BatchRow = typeof batches.$inferSelect;
export type SampleRow = typeof samples.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type GuideRow = typeof guides.$inferSelect;
export type ShipRow = typeof ships.$inferSelect;

const GOOD: readonly (string | null)[] = ["amazing", "good"];
/** Unmarked in a judged batch reads as an okay 5: no call is a middling one. */
const UNMARKED = 5;
/** Fisher-Yates with Math.random: positions only hide the agent's order. */
const shuffled = <T>(xs: readonly T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

/**
 * Strength per judged sample: each judged batch is a partial ranking by score, 10 down to 1, ties
 * unordered. Wins from 9 and up count double.
 */
export function strengths(
  rows: readonly Pick<SampleRow, "id" | "batchId" | "score">[],
): Strength[] {
  const byBatch = new Map<number, (typeof rows)[number][]>();
  for (const r of rows) byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r]);
  const judged = [...byBatch.values()].filter((b) => b.some((r) => r.score != null));
  const ids = judged.flat().map((r) => String(r.id));
  const scores = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const choices = judged.flatMap((b) =>
    tiersToChoices(
      scores.map((n) => b.filter((r) => (r.score ?? UNMARKED) === n).map((r) => String(r.id))),
      scores.map((n) => (n >= TAP.amazing ? 2 : 1)),
    ),
  );
  return fitPlackettLuce(ids, choices);
}

/** With-vs-without good rate per guide, over judged samples. */
export function guideStats(guideRows: readonly GuideRow[], judged: readonly SampleRow[]) {
  return guideRows.map((g) => ({
    ...g,
    effect: rateSplit(
      judged.map((s) => ({ has: s.guides.includes(g.id), good: GOOD.includes(s.verdict) })),
    ),
  }));
}

export class Vireo {
  readonly db: Db;
  readonly collectors: readonly Collector[];
  private readonly hooks: Hooks;

  constructor(p: Ports) {
    this.db = p.db;
    this.collectors = p.collectors ?? [];
    this.hooks = p.hooks ?? {};
  }

  private write<T>(by: string | null, fn: (tx: Tx) => Promise<T>) {
    return atomic(this.db, async (tx) => {
      if (by && this.hooks.onWrite) await this.hooks.onWrite(tx, by);
      return fn(tx);
    });
  }

  async subjectOf(ref: string | number, db: Db | Tx = this.db): Promise<SubjectRow> {
    const id = typeof ref === "number" || /^\d+$/.test(ref) ? Number(ref) : null;
    const [row] = await db
      .select()
      .from(subjects)
      .where(id ? eq(subjects.id, id) : eq(subjects.slug, String(ref)));
    if (!row) throw new VireoError(`no subject ${ref}`, 404);
    return row;
  }

  /** A batch by id, or `<subject>:<n>` (its number within the subject). */
  async batchOf(ref: string | number, db: Db | Tx = this.db): Promise<number> {
    if (typeof ref === "number" || /^\d+$/.test(ref)) return Number(ref);
    const m = /^(.+):(\d+)$/.exec(ref);
    if (!m) throw new VireoError(`a batch is an id or <subject>:<n>, not ${ref}`);
    const subject = await this.subjectOf(m[1] as string, db);
    const [row] = await db
      .select({ id: batches.id })
      .from(batches)
      .where(and(eq(batches.subjectId, subject.id), eq(batches.n, Number(m[2]))));
    if (!row) throw new VireoError(`no batch ${ref}`, 404);
    return row.id;
  }

  newSubject(s: {
    slug: string;
    name: string;
    kind: Kind;
    brief?: string | null;
    seeds?: string[];
    by?: string | null;
  }) {
    return this.write(s.by ?? null, async (tx) => {
      const [row] = await tx
        .insert(subjects)
        .values({
          slug: s.slug,
          name: s.name,
          kind: s.kind,
          brief: s.brief ?? null,
          seeds: s.seeds ?? [],
          by: s.by ?? null,
        })
        .returning();
      return row as SubjectRow;
    });
  }

  async listSubjects() {
    const rows = await this.db.select().from(subjects).orderBy(desc(subjects.createdAt));
    const counts = await this.db
      .select({
        subjectId: samples.subjectId,
        samples: sql<number>`count(*)::int`,
        kept: sql<number>`count(${samples.keptAt})::int`,
        open: sql<number>`count(*) filter (where ${batches.state} = 'open')::int`,
      })
      .from(samples)
      .innerJoin(batches, eq(batches.id, samples.batchId))
      .groupBy(samples.subjectId);
    const by = new Map(counts.map((c) => [c.subjectId, c]));
    return rows.map((s) => ({
      ...s,
      samples: by.get(s.id)?.samples ?? 0,
      kept: by.get(s.id)?.kept ?? 0,
      toPick: by.get(s.id)?.open ?? 0,
    }));
  }

  /** One batch for review: samples in a shuffled order. */
  async addBatch(
    ref: string | number,
    b: { why: string; agent?: string | null; samples: NewSample[] },
  ) {
    if (!b.why.trim()) throw new VireoError("say why: what changed and what it tests");
    if (!b.samples.length) throw new VireoError("a batch needs samples");
    for (const s of b.samples)
      if (!s.body?.trim() && !s.media) throw new VireoError("each sample needs a body or a file");
    for (const s of b.samples)
      for (const uri of [s.media, s.poster])
        if (uri && !isMediaUri(uri)) throw new VireoError("media and poster are s3:// or https://");
    for (const s of b.samples)
      if (s.source != null && !isSource(s.source))
        throw new VireoError("source needs a ref and spans of {s, e} seconds, e > s");
    for (const s of b.samples) {
      if (s.name != null && s.name.trim().length > 60)
        throw new VireoError("a name is 60 characters at most");
      const ids = (s.parents ?? []).map((p) => parentOf(p).id);
      if (ids.some((i) => !Number.isSafeInteger(i) || i <= 0))
        throw new VireoError("parents are sample ids");
      if (new Set(ids).size < ids.length) throw new VireoError("a parent is named twice");
    }
    return this.write(b.agent ?? null, async (tx) => {
      const subject = await this.subjectOf(ref, tx);
      // lock the subject: two adds at once must not take the same number
      await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(eq(subjects.id, subject.id))
        .for("update");
      const [top] = await tx
        .select({ n: sql<number>`coalesce(max(${batches.n}), 0)::int` })
        .from(batches)
        .where(eq(batches.subjectId, subject.id));
      const wanted = [
        ...new Set(b.samples.flatMap((s) => (s.parents ?? []).map((p) => parentOf(p).id))),
      ];
      if (wanted.length) {
        const found = await tx
          .select({ id: samples.id })
          .from(samples)
          .where(and(inArray(samples.id, wanted), eq(samples.subjectId, subject.id)));
        const have = new Set(found.map((r) => r.id));
        const gone = wanted.filter((i) => !have.has(i));
        if (gone.length)
          throw new VireoError(`not a sample of ${subject.slug}: ${gone.join(", ")}`);
      }
      const [batch] = await tx
        .insert(batches)
        .values({ subjectId: subject.id, n: (top?.n ?? 0) + 1, why: b.why, agent: b.agent ?? null })
        .returning();
      const order = shuffled(b.samples.map((_, i) => i));
      const rows = await tx
        .insert(samples)
        .values(
          b.samples.map((s, i) => ({
            batchId: batch?.id as number,
            subjectId: subject.id,
            position: order.indexOf(i),
            body: s.body ?? null,
            media: s.media ?? null,
            poster: s.poster ?? null,
            source: s.source ?? null,
            name: s.name?.trim() || null,
            guides: s.guides ?? [],
            change: s.change ?? null,
            agent: b.agent ?? null,
          })),
        )
        .returning({ id: samples.id });
      // returning keeps insert order: rows[i] is b.samples[i]
      const edges = b.samples.flatMap((s, i) =>
        (s.parents ?? []).map((p, position) => ({
          childId: rows[i]?.id as number,
          parentId: parentOf(p).id,
          position,
          took: parentOf(p).took,
        })),
      );
      if (edges.length) await tx.insert(lineage).values(edges);
      return {
        batch: batch?.id as number,
        n: batch?.n as number,
        subject: subject.slug,
        samples: rows.map((r) => r.id),
      };
    });
  }

  /** Open batches, oldest first, with their samples and notes: what the person has to pick. */
  async queue(ref?: string | number) {
    const subjectId = ref == null ? null : (await this.subjectOf(ref)).id;
    const open = await this.db
      .select({ batch: batches, subject: subjects })
      .from(batches)
      .innerJoin(subjects, eq(subjects.id, batches.subjectId))
      .where(
        and(eq(batches.state, "open"), subjectId ? eq(batches.subjectId, subjectId) : undefined),
      )
      .orderBy(asc(batches.createdAt));
    if (!open.length) return [];
    const rows = await this.db
      .select()
      .from(samples)
      .where(
        inArray(
          samples.batchId,
          open.map((o) => o.batch.id),
        ),
      )
      .orderBy(asc(samples.position));
    const ns = await this.notesOf(rows.map((r) => r.id));
    return open.map((o) => ({
      batch: o.batch,
      subject: o.subject,
      samples: rows
        .filter((r) => r.batchId === o.batch.id)
        .map((r) => ({ ...r, notes: ns.filter((n) => n.sampleId === r.id) })),
    }));
  }

  private async notesOf(sampleIds: number[]) {
    if (!sampleIds.length) return [];
    return this.db
      .select()
      .from(notes)
      .where(inArray(notes.sampleId, sampleIds))
      .orderBy(asc(notes.createdAt));
  }

  /** Parent edges of these children, main parent first. */
  private async lineageOf(childIds: number[]) {
    if (!childIds.length) return [];
    return this.db
      .select()
      .from(lineage)
      .where(inArray(lineage.childId, childIds))
      .orderBy(asc(lineage.childId), asc(lineage.position));
  }

  /** A call: a 1-10 score, a verdict (its tap score) or null to clear. The verdict follows. */
  async judge(sampleId: number, call: number | Verdict | null, by: string | null) {
    const score = typeof call === "string" ? TAP[call] : call;
    if (score != null && !(Number.isInteger(score) && score >= 1 && score <= 10))
      throw new VireoError(`score ${score}: 1-10, or ${VERDICTS.join("|")}`, 400);
    return this.write(by, async (tx) => {
      const [row] = await tx
        .update(samples)
        .set({ score, verdict: score == null ? null : verdictOf(score) })
        .where(eq(samples.id, sampleId))
        .returning({ id: samples.id, score: samples.score, verdict: samples.verdict });
      if (!row) throw new VireoError(`no sample ${sampleId}`, 404);
      return row;
    });
  }

  async addNote(
    sampleId: number,
    n: { anchor?: Anchor | null; tone?: Tone | null; text?: string | null },
    by: string | null,
  ) {
    if (!n.tone && !n.text?.trim()) throw new VireoError("a note needs a tone or words");
    return this.write(by, async (tx) => {
      const [row] = await tx
        .insert(notes)
        .values({
          sampleId,
          anchor: n.anchor ?? null,
          tone: n.tone ?? null,
          text: n.text?.trim() || null,
          by,
        })
        .returning();
      return row as NoteRow;
    });
  }

  dropNote(noteId: number, by: string | null) {
    return this.write(by, async (tx) => {
      const rows = await tx.delete(notes).where(eq(notes.id, noteId)).returning({ id: notes.id });
      return { done: rows.map((r) => r.id) };
    });
  }

  /** Close a batch: the person's note goes to the agent with the marks. */
  closeBatch(ref: number | string, note: string | null, by: string | null) {
    return this.write(by, async (tx) => {
      const batchId = await this.batchOf(ref, tx);
      const [row] = await tx
        .update(batches)
        .set({ state: "closed", note: note?.trim() || null, closedAt: new Date() })
        .where(eq(batches.id, batchId))
        .returning({ id: batches.id, n: batches.n, subjectId: batches.subjectId });
      if (!row) throw new VireoError(`no batch ${ref}`, 404);
      return row;
    });
  }

  keep(sampleId: number, on: boolean, by: string | null) {
    return this.write(by, async (tx) => {
      const [row] = await tx
        .update(samples)
        .set({ keptAt: on ? new Date() : null })
        .where(eq(samples.id, sampleId))
        .returning({ id: samples.id, keptAt: samples.keptAt });
      if (!row) throw new VireoError(`no sample ${sampleId}`, 404);
      return row;
    });
  }

  async addGuide(g: {
    text: string;
    source?: GuideRow["source"];
    ref?: string | null;
    subject?: string | number | null;
    kind?: Kind | null;
    by?: string | null;
  }) {
    if (!g.text.trim()) throw new VireoError("say the tip");
    return this.write(g.by ?? null, async (tx) => {
      const subjectId = g.subject == null ? null : (await this.subjectOf(g.subject, tx)).id;
      const [row] = await tx
        .insert(guides)
        .values({
          text: g.text.trim(),
          source: g.source ?? "person",
          ref: g.ref ?? null,
          subjectId,
          kind: g.kind ?? null,
          by: g.by ?? null,
        })
        .returning();
      return row as GuideRow;
    });
  }

  setGuide(id: number, state: GuideState, by: string | null) {
    return this.write(by, async (tx) => {
      const [row] = await tx
        .update(guides)
        .set({ state, decidedAt: state === "testing" ? null : new Date() })
        .where(eq(guides.id, id))
        .returning();
      if (!row) throw new VireoError(`no guide ${id}`, 404);
      return row;
    });
  }

  /** Guides that reach a subject: its own, its kind's, and everyone's. */
  private guidesFor(s: SubjectRow) {
    return this.db
      .select()
      .from(guides)
      .where(
        or(
          eq(guides.subjectId, s.id),
          and(isNull(guides.subjectId), eq(guides.kind, s.kind)),
          and(isNull(guides.subjectId), isNull(guides.kind)),
        ),
      )
      .orderBy(asc(guides.createdAt));
  }

  /** Everything about a subject: for the agent's next batch and a page's subject view. */
  async feedback(ref: string | number) {
    const s = await this.subjectOf(ref);
    const bs = await this.db
      .select()
      .from(batches)
      .where(eq(batches.subjectId, s.id))
      .orderBy(asc(batches.createdAt));
    const ss = await this.db
      .select()
      .from(samples)
      .where(eq(samples.subjectId, s.id))
      .orderBy(asc(samples.batchId), asc(samples.position));
    const ns = await this.notesOf(ss.map((r) => r.id));
    const es = await this.lineageOf(ss.map((r) => r.id));
    const judgedBatches = new Set(bs.filter((b) => b.state === "closed").map((b) => b.id));
    const judged = ss.filter((r) => judgedBatches.has(r.batchId));
    const strength = new Map(strengths(ss).map((x) => [Number(x.id), x]));
    const gs = guideStats(await this.guidesFor(s), judged);
    return {
      subject: s,
      guides: gs,
      batches: bs.map((b) => {
        const mine = ss.filter((r) => r.batchId === b.id);
        return {
          ...b,
          goodRate: mine.length
            ? mine.filter((r) => GOOD.includes(r.verdict)).length / mine.length
            : null,
          samples: mine.map((r) => ({
            ...r,
            strength: strength.get(r.id) ?? null,
            notes: ns.filter((n) => n.sampleId === r.id),
            parents: es
              .filter((e) => e.childId === r.id)
              .map((e) => ({ id: e.parentId, took: e.took })),
          })),
        };
      }),
      leaders: [...strength.values()]
        .slice(0, 5)
        .map((x) => ({ sample: Number(x.id), strength: x.strength, se: x.se })),
      live: await live(this.db, this.collectors, s.id),
    };
  }

  /** A sample goes live on a channel's target; `collect` reads its numbers from then on. */
  async ship(
    sampleId: number,
    o: { channel: string; target: string; why?: string | null },
    by: string | null,
  ) {
    if (!o.target.trim()) throw new VireoError("a ship needs the channel's target id");
    if (!this.collectors.some((c) => c.channel === o.channel))
      throw new VireoError(
        `no collector for ${o.channel}: one of ${this.collectors.map((c) => c.channel).join(", ") || "(none)"}`,
      );
    return this.write(by, async (tx) => {
      const [sample] = await tx
        .select({ id: samples.id })
        .from(samples)
        .where(eq(samples.id, sampleId));
      if (!sample) throw new VireoError(`no sample ${sampleId}`, 404);
      const [row] = await tx
        .insert(ships)
        .values({ sampleId, channel: o.channel, target: o.target.trim(), why: o.why ?? null, by })
        .onConflictDoUpdate({
          target: [ships.channel, ships.target, ships.sampleId],
          set: { endedAt: null },
        })
        .returning();
      if (!row) throw new Error("ship not written");
      return row;
    });
  }

  /** Ends a ship: its numbers stay, frozen at the next collect. */
  unship(shipId: number, by: string | null) {
    return this.write(by, async (tx) => {
      const [row] = await tx
        .update(ships)
        .set({ endedAt: sql`now()` })
        .where(and(eq(ships.id, shipId), isNull(ships.endedAt)))
        .returning();
      if (!row) throw new VireoError(`no live ship ${shipId}`, 404);
      return row;
    });
  }

  /** A subject's ships, newest first. */
  async shipsOf(ref: string | number) {
    const s = await this.subjectOf(ref);
    const rows = await this.db
      .select({ ship: ships })
      .from(ships)
      .innerJoin(samples, eq(samples.id, ships.sampleId))
      .where(eq(samples.subjectId, s.id))
      .orderBy(desc(ships.startedAt));
    return rows.map((x) => x.ship);
  }

  /** Read every live ship's numbers now (or one ship's). */
  collect(o: { ship?: number } = {}) {
    return collect(this.db, this.collectors, o);
  }

  /** Kept samples, newest first, with their subject. */
  async catalog(opts: { kind?: Kind; subject?: string | number } = {}) {
    const subjectId = opts.subject == null ? null : (await this.subjectOf(opts.subject)).id;
    return this.db
      .select({
        sample: samples,
        subject: { slug: subjects.slug, name: subjects.name, kind: subjects.kind },
      })
      .from(samples)
      .innerJoin(subjects, eq(subjects.id, samples.subjectId))
      .where(
        and(
          isNotNull(samples.keptAt),
          opts.kind ? eq(subjects.kind, opts.kind) : undefined,
          subjectId ? eq(samples.subjectId, subjectId) : undefined,
        ),
      )
      .orderBy(desc(samples.keptAt));
  }
}

/** Read models a host's page renders: no hand-copied types. */
export type Queue = Awaited<ReturnType<Vireo["queue"]>>;
export type Feedback = Awaited<ReturnType<Vireo["feedback"]>>;
export type SubjectList = Awaited<ReturnType<Vireo["listSubjects"]>>;
export type Catalog = Awaited<ReturnType<Vireo["catalog"]>>;
