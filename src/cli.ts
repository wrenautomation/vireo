/**
 * The agent's hands: `registerCommands(cmd, host)` adds every vireo command to a commander
 * command (the host's `variants`, or `vireo` itself). JSON out.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { Collector } from "./collect.js";
import type { Db, Hooks } from "./db.js";
import { type Bucket, upload } from "./media.js";
import {
  type Anchor,
  GUIDE_SOURCES,
  type GuideState,
  KINDS,
  type Kind,
  TONES,
  VERDICTS,
  type Verdict,
} from "./schema.js";
import { type NewSample, Vireo } from "./store.js";

export interface CliHost {
  withDb<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Who acts: the audit actor and each row's `by`. */
  by: string;
  collectors?: readonly Collector[];
  hooks?: Hooks;
  /** Where `file`/`posterFile` go; none refuses them. */
  bucket?: Bucket;
  /** Fills a batch file's own fields (wren: `studio` → source); runs before upload. */
  resolve?(raw: Record<string, unknown>, db: Db): Promise<Partial<NewSample>>;
}

/** A batch file's sample: inline body, or a local file the CLI uploads. */
interface SampleIn extends NewSample {
  file?: string;
  posterFile?: string;
  [own: string]: unknown;
}
interface BatchIn {
  why: string;
  agent?: string;
  samples: SampleIn[];
}

const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const id = (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not an id: ${v}`);
  return n;
};
const oneOf = <T extends string>(v: string, all: readonly T[], what: string): T => {
  if (!(all as readonly string[]).includes(v)) throw new Error(`${what}: one of ${all.join(", ")}`);
  return v as T;
};
const many = (v: string, acc: string[]) => [...acc, v];

export function registerCommands(c: Command, host: CliHost): Command {
  const by = host.by;
  const run = <T>(fn: (v: Vireo, db: Db) => Promise<T>) =>
    host.withDb(async (db) =>
      json(await fn(new Vireo({ db, collectors: host.collectors, hooks: host.hooks }), db)),
    );
  const channels = (host.collectors ?? []).map((x) => `${x.channel} (${x.target})`);

  c.command("new <slug>")
    .description("A subject to iterate on; --brief is the person's direction (none: from scratch)")
    .requiredOption("--name <name>")
    .requiredOption("--kind <kind>", KINDS.join("|"))
    .option("--brief <text>")
    .option("--seed <ref>", "a study, doc path, sample id or file (repeat)", many, [])
    .action((slug: string, o: { name: string; kind: string; brief?: string; seed: string[] }) =>
      run((v) =>
        v.newSubject({
          slug,
          name: o.name,
          kind: oneOf(o.kind, KINDS, "kind"),
          brief: o.brief ?? null,
          seeds: o.seed,
          by,
        }),
      ),
    );

  c.command("list")
    .description("Subjects with sample, kept and to-pick counts")
    .action(() => run((v) => v.listSubjects()));

  c.command("show <subject>")
    .alias("feedback")
    .description(
      "Everything for the next batch: brief, guides with with-vs-without rates, each batch's why, note, calls, anchored notes, strengths, live numbers",
    )
    .action((s: string) => run((v) => v.feedback(s)));

  c.command("add <subject> [file]")
    .description(
      "One batch from JSON (file or stdin): {why, agent, samples:[{body | file | media, posterFile?, parent?, guides?, change?, source?}]}. Files go to the bucket",
    )
    .action((s: string, file: string | undefined) =>
      run(async (v, db) => {
        const b = JSON.parse(file ? await readFile(file, "utf8") : await stdin()) as BatchIn;
        const base = file ? resolve(file, "..") : process.cwd();
        if (b.samples?.some((x) => x.file || x.posterFile) && !host.bucket)
          throw new Error("no bucket: set one to upload files");
        const up = (p: unknown) =>
          typeof p === "string" ? upload(host.bucket as Bucket, resolve(base, p)) : null;
        await v.subjectOf(s);
        const samples: NewSample[] = [];
        for (const x of b.samples ?? []) {
          const own = host.resolve ? await host.resolve(x, db) : {};
          const y = { ...x, ...own };
          samples.push({
            body: y.body ?? null,
            media: y.media ?? (await up(y.file)),
            poster: y.poster ?? (await up(y.posterFile)),
            parent: y.parent ?? null,
            guides: y.guides ?? [],
            change: y.change ?? null,
            source: y.source ?? null,
          });
        }
        return v.addBatch(s, { why: b.why, agent: b.agent ?? by, samples });
      }),
    );

  c.command("queue [subject]")
    .description("Open batches waiting on the person, with their samples and notes")
    .action((s?: string) => run((v) => v.queue(s)));

  c.command("judge <sample> <verdict>")
    .description(`${VERDICTS.join("|")}|clear`)
    .action((s: string, verdict: string) =>
      run((v) =>
        v.judge(
          id(s),
          verdict === "clear" ? null : oneOf<Verdict>(verdict, VERDICTS, "verdict"),
          by,
        ),
      ),
    );

  c.command("note <sample> [text]")
    .description("A note on a sample; --quote, --at or --box anchors it")
    .option("--tone <tone>", TONES.join("|"))
    .option("--quote <words>", "the exact words it points at")
    .option("--at <range>", "seconds on a video: 12.5 or 12.5-15")
    .option("--box <x,y,w,h>", "fractions of the frame")
    .action(
      (
        s: string,
        text: string | undefined,
        o: { tone?: string; quote?: string; at?: string; box?: string },
      ) =>
        run((v) => {
          const box = o.box ? boxOf(o.box) : undefined;
          const [start, end] = (o.at ?? "").split("-").map(Number);
          const anchor: Anchor | null = o.quote
            ? { type: "quote", exact: o.quote }
            : o.at
              ? {
                  type: "time",
                  start: start ?? 0,
                  ...(end ? { end } : {}),
                  ...(box ? { box } : {}),
                }
              : box
                ? { type: "box", ...box }
                : null;
          const tone = o.tone ? oneOf(o.tone, TONES, "tone") : null;
          return v.addNote(id(s), { anchor, tone, text: text ?? null }, by);
        }),
    );

  c.command("close <batch>")
    .description("Close a batch; --note is the guide for the next one")
    .option("--note <text>")
    .action((b: string, o: { note?: string }) =>
      run((v) => v.closeBatch(id(b), o.note ?? null, by)),
    );

  c.command("keep <sample>")
    .description("Put a sample in the catalog (--off takes it out)")
    .option("--off")
    .action((s: string, o: { off?: boolean }) => run((v) => v.keep(id(s), !o.off, by)));

  c.command("catalog")
    .description("Kept samples, newest first")
    .option("--kind <kind>")
    .option("--subject <subject>")
    .action((o: { kind?: string; subject?: string }) =>
      run((v) =>
        v.catalog({
          ...(o.kind ? { kind: oneOf<Kind>(o.kind, KINDS, "kind") } : {}),
          ...(o.subject ? { subject: o.subject } : {}),
        }),
      ),
    );

  c.command("ship <sample> <channel> <target>")
    .description(
      `A sample goes live on a channel's target; its numbers come back per segment (\`live\`). Channels: ${channels.join(", ") || "none"}`,
    )
    .option("--why <text>")
    .action((s: string, channel: string, target: string, o: { why?: string }) =>
      run((v) => v.ship(id(s), { channel, target, why: o.why ?? null }, by)),
    );

  c.command("unship <ship>")
    .description("End a ship; its numbers stay")
    .action((x: string) => run((v) => v.unship(id(x), by)));

  c.command("live <subject>")
    .description(
      "Live numbers per segment: each shipped sample's rates, 95% range, P(best); and its ships",
    )
    .action((s: string) =>
      run(async (v) => ({ ...(await v.feedback(s)).live, ships: await v.shipsOf(s) })),
    );

  c.command("collect")
    .description("Read every live ship's numbers now (a host's loop runs this)")
    .option("--ship <ship>")
    .action((o: { ship?: string }) => run((v) => v.collect(o.ship ? { ship: id(o.ship) } : {})));

  const g = c
    .command("guide")
    .description("Tips the agent writes from: testing, locked (a rule), dropped");
  g.command("add <text>")
    .option("--subject <subject>", "only this subject")
    .option("--kind <kind>", "every subject of this kind")
    .option("--source <source>", GUIDE_SOURCES.join("|"), "person")
    .option("--ref <ref>", "study, doc path or skill name")
    .action((text: string, o: { subject?: string; kind?: string; source: string; ref?: string }) =>
      run((v) =>
        v.addGuide({
          text,
          subject: o.subject ?? null,
          kind: o.kind ? oneOf<Kind>(o.kind, KINDS, "kind") : null,
          source: oneOf(o.source, GUIDE_SOURCES, "source"),
          ref: o.ref ?? null,
          by,
        }),
      ),
    );
  for (const [verb, state] of [
    ["lock", "locked"],
    ["drop", "dropped"],
    ["test", "testing"],
  ] as const)
    g.command(`${verb} <guide>`).action((x: string) =>
      run((v) => v.setGuide(id(x), state as GuideState, by)),
    );
  return c;
}

function boxOf(s: string) {
  const [x, y, w, h] = s.split(",").map(Number);
  if ([x, y, w, h].some((n) => n == null || !Number.isFinite(n))) throw new Error("--box x,y,w,h");
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
