/**
 * Vireo's tables (schema `vireo`): subjects to iterate on, batches the agent sends, samples, a
 * person's calls and anchored notes, guides under test, ships and their outcomes. No tenant
 * column: a host gives each tenant its own database, so isolation is the database's.
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import type { Source } from "./sync.js";

export const vireo = pgSchema("vireo");

/** CHECK col IN (values): an enum that a later migration can widen without a type change. */
function oneOf(name: string, col: { name: string }, values: readonly string[]) {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'::character varying`).join(", ");
  return check(name, sql.raw(`("${col.name}")::text = ANY ((ARRAY[${list}])::text[])`));
}

/** What a sample is: shown inline (text), as an image, a video with time marks, or a page in a frame. */
export const KINDS = ["text", "image", "video", "page"] as const;
export type Kind = (typeof KINDS)[number];
export const SUBJECT_STATES = ["open", "paused", "done"] as const;
export const BATCH_STATES = ["open", "closed"] as const;
/** The person's call on a whole sample, best first: a zone of the 1-10 score (D9). */
export const VERDICTS = ["amazing", "good", "okay", "bad"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Lowest score of each zone: 9-10 amazing, 7-8 good, 4-6 okay, 1-3 bad. */
export const ZONE_FLOOR = { amazing: 9, good: 7, okay: 4, bad: 1 } as const satisfies Record<
  Verdict,
  number
>;
/** The score a plain call (a tap, `judge 3 good`) sets. */
export const TAP = { amazing: 9, good: 7, okay: 5, bad: 2 } as const satisfies Record<
  Verdict,
  number
>;
export const verdictOf = (score: number): Verdict =>
  VERDICTS.find((v) => score >= ZONE_FLOOR[v]) ?? "bad";
export const TONES = ["good", "bad"] as const;
export type Tone = (typeof TONES)[number];
export const GUIDE_SOURCES = ["person", "study", "sop", "skill", "agent"] as const;
export const GUIDE_STATES = ["testing", "locked", "dropped"] as const;
export type GuideState = (typeof GUIDE_STATES)[number];

/**
 * Where a note points, after W3C Web Annotation selectors: a text quote, a box on an image or
 * frame (fractions 0-1), a time range on a video (seconds; optional box).
 */
export type Anchor =
  | { type: "quote"; exact: string; prefix?: string; suffix?: string }
  | { type: "box"; x: number; y: number; w: number; h: number }
  | {
      type: "time";
      start: number;
      end?: number;
      box?: { x: number; y: number; w: number; h: number };
    };

const at = (name: string) => timestamp(name, { withTimezone: true });

export const subjects = vireo.table(
  "subjects",
  {
    id: serial("id"),
    /** Short handle for the CLI: `opener-recruiters`. */
    slug: varchar("slug", { length: 60 }).notNull(),
    name: text("name").notNull(),
    kind: varchar("kind", { length: 8, enum: KINDS }).notNull(),
    /** The person's direction; null starts from scratch. */
    brief: text("brief"),
    /** Starting points: study slugs, SOP paths, sample ids, files. */
    seeds: jsonb("seeds").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    state: varchar("state", { length: 8, enum: SUBJECT_STATES }).notNull().default("open"),
    by: varchar("by", { length: 320 }),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_subjects" }),
    unique("uq_vireo_subjects_slug").on(t.slug),
    oneOf("ck_vireo_subjects_kind", t.kind, KINDS),
    oneOf("ck_vireo_subjects_state", t.state, SUBJECT_STATES),
  ],
);

export const batches = vireo.table(
  "batches",
  {
    id: serial("id"),
    subjectId: integer("subject_id").notNull(),
    /** Batch number within its subject, from 1; kept when another batch is deleted */
    n: integer("n").notNull(),
    /** The agent's why: what it changed from the last batch and what it tests. */
    why: text("why").notNull(),
    /** Agent id (session or run) that made it. */
    agent: varchar("agent", { length: 120 }),
    state: varchar("state", { length: 8, enum: BATCH_STATES }).notNull().default("open"),
    /** The person's note for the next batch. */
    note: text("note"),
    closedAt: at("closed_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_batches" }),
    foreignKey({
      columns: [t.subjectId],
      foreignColumns: [subjects.id],
      name: "fk_batches_subject_id_subjects",
    }).onDelete("cascade"),
    index("ix_vireo_batches_subject").on(t.subjectId, t.state),
    unique("uq_vireo_batches_subject_n").on(t.subjectId, t.n),
    oneOf("ck_vireo_batches_state", t.state, BATCH_STATES),
  ],
);

export const samples = vireo.table(
  "samples",
  {
    id: serial("id"),
    batchId: integer("batch_id").notNull(),
    subjectId: integer("subject_id").notNull(),
    /** Order shown; shuffled per batch so the agent's order tells nothing. */
    position: smallint("position").notNull().default(0),
    /** Inline text, or html for a page. */
    body: text("body"),
    /** s3:// uri of the image, video or page file. */
    media: text("media"),
    /** s3:// uri of a still for a video. */
    poster: text("poster"),
    /** A video's footage and kept spans: cuts of the same footage play in step (`sync.ts`). */
    source: jsonb("source").$type<Source>(),
    /** Short name the agent gives it ("Star system"); hidden while the person judges. */
    name: varchar("name", { length: 60 }),
    /** Guide ids this sample applied: a guide's with-vs-without rate reads these. */
    guides: integer("guides").array().notNull().default(sql`'{}'::integer[]`),
    /** What changed from the parent, in the agent's words; hidden while the person judges. */
    change: text("change"),
    agent: varchar("agent", { length: 120 }),
    /** The person's 1-10 score; `verdict` is its zone, kept in step by a check. */
    score: smallint("score"),
    verdict: varchar("verdict", { length: 8, enum: VERDICTS }),
    /** In the catalog. */
    keptAt: at("kept_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_samples" }),
    foreignKey({
      columns: [t.batchId],
      foreignColumns: [batches.id],
      name: "fk_samples_batch_id_batches",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.subjectId],
      foreignColumns: [subjects.id],
      name: "fk_samples_subject_id_subjects",
    }).onDelete("cascade"),
    index("ix_vireo_samples_batch").on(t.batchId),
    index("ix_vireo_samples_subject").on(t.subjectId),
    oneOf("ck_vireo_samples_verdict", t.verdict, VERDICTS),
    check("ck_vireo_samples_score", sql`${t.score} BETWEEN 1 AND 10`),
    check(
      "ck_vireo_samples_call",
      sql`${t.verdict} IS NOT DISTINCT FROM (CASE WHEN ${t.score} >= 9 THEN 'amazing' WHEN ${t.score} >= 7 THEN 'good' WHEN ${t.score} >= 4 THEN 'okay' WHEN ${t.score} >= 1 THEN 'bad' END)`,
    ),
  ],
);

/**
 * Where a sample came from: one row per parent, so a cross is two rows. `took` = what the child
 * kept from that parent, in the agent's words; hidden while the person judges, like `change`.
 */
export const lineage = vireo.table(
  "lineage",
  {
    childId: integer("child_id").notNull(),
    parentId: integer("parent_id").notNull(),
    /** 0 = main parent: the tree places the child under it. */
    position: smallint("position").notNull().default(0),
    took: text("took"),
  },
  (t) => [
    primaryKey({ columns: [t.childId, t.parentId], name: "pk_lineage" }),
    foreignKey({
      columns: [t.childId],
      foreignColumns: [samples.id],
      name: "fk_lineage_child_id_samples",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [samples.id],
      name: "fk_lineage_parent_id_samples",
    }).onDelete("cascade"),
    index("ix_vireo_lineage_parent").on(t.parentId),
    check("ck_vireo_lineage_not_self", sql.raw(`"child_id" <> "parent_id"`)),
  ],
);

/** A note on a sample: anchored (a line, a region, a moment) or on the whole. */
export const notes = vireo.table(
  "notes",
  {
    id: serial("id"),
    sampleId: integer("sample_id").notNull(),
    anchor: jsonb("anchor").$type<Anchor>(),
    tone: varchar("tone", { length: 4, enum: TONES }),
    text: text("text"),
    by: varchar("by", { length: 320 }),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_notes" }),
    foreignKey({
      columns: [t.sampleId],
      foreignColumns: [samples.id],
      name: "fk_notes_sample_id_samples",
    }).onDelete("cascade"),
    index("ix_vireo_notes_sample").on(t.sampleId),
    oneOf("ck_vireo_notes_tone", t.tone, TONES),
  ],
);

/** A tip or rule the agent writes from. Scope: one subject, one kind, or (both null) all. */
export const guides = vireo.table(
  "guides",
  {
    id: serial("id"),
    text: text("text").notNull(),
    source: varchar("source", { length: 8, enum: GUIDE_SOURCES }).notNull().default("person"),
    /** Where it came from: a study slug, an SOP path, a skill name. */
    ref: text("ref"),
    subjectId: integer("subject_id"),
    kind: varchar("kind", { length: 8, enum: KINDS }),
    state: varchar("state", { length: 8, enum: GUIDE_STATES }).notNull().default("testing"),
    by: varchar("by", { length: 320 }),
    decidedAt: at("decided_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_guides" }),
    foreignKey({
      columns: [t.subjectId],
      foreignColumns: [subjects.id],
      name: "fk_guides_subject_id_subjects",
    }).onDelete("cascade"),
    index("ix_vireo_guides_subject").on(t.subjectId),
    oneOf("ck_vireo_guides_source", t.source, GUIDE_SOURCES),
    oneOf("ck_vireo_guides_kind", t.kind, KINDS),
    oneOf("ck_vireo_guides_state", t.state, GUIDE_STATES),
  ],
);

/**
 * A sample out in the world. `channel` names a host collector (`post`, `site`, `email`);
 * `target` is that channel's own id. The collector reads its outcomes (`collect.ts`).
 */
export const ships = vireo.table(
  "ships",
  {
    id: serial("id"),
    sampleId: integer("sample_id").notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    target: varchar("target", { length: 200 }).notNull(),
    why: text("why"),
    by: varchar("by", { length: 320 }),
    startedAt: at("started_at").notNull().defaultNow(),
    endedAt: at("ended_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id], name: "pk_ships" }),
    foreignKey({
      columns: [t.sampleId],
      foreignColumns: [samples.id],
      name: "fk_ships_sample_id_samples",
    }).onDelete("cascade"),
    index("ix_vireo_ships_sample").on(t.sampleId),
    unique("uq_vireo_ships_target").on(t.channel, t.target, t.sampleId),
  ],
);

/**
 * A ship's numbers, long: totals to `day` per segment (`all`, `platform:linkedin`,
 * `niche:recruiting`, `source:google`). A later collect the same day replaces that day's row.
 */
export const outcomes = vireo.table(
  "outcomes",
  {
    shipId: integer("ship_id").notNull(),
    segment: varchar("segment", { length: 160 }).notNull(),
    day: date("day", { mode: "string" }).notNull(),
    metric: varchar("metric", { length: 32 }).notNull(),
    value: doublePrecision("value").notNull(),
    fetchedAt: at("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.shipId, t.segment, t.day, t.metric],
      name: "pk_outcomes",
    }),
    foreignKey({
      columns: [t.shipId],
      foreignColumns: [ships.id],
      name: "fk_outcomes_ship_id_ships",
    }).onDelete("cascade"),
  ],
);
