# vireo

The variant loop. An agent makes a batch of samples (copy, cuts, images, pages). A person marks
each one Amazing, Good or Bad, with notes pinned to words, a box or a time. The agent reads the
calls and makes the next batch. Ship a sample and its real numbers come back per segment, beside
the taste rank.

Vireo is the backend: tables, the store, stats, collectors, a CLI. The host renders it.

## Use it alone

```sh
npx @wrenautomation/vireo new hero --name "Hero line" --kind text
echo '{"why":"number first vs story first","samples":[{"body":"3x replies"},{"body":"A story"}]}' \
  | npx @wrenautomation/vireo add hero
npx @wrenautomation/vireo judge 1 amazing
npx @wrenautomation/vireo note 1 --quote "3x" --tone good
npx @wrenautomation/vireo close 1 --note "more numbers"
npx @wrenautomation/vireo show hero      # what the agent reads for the next batch
```

Data goes to a PGlite folder `.vireo/`, or to Postgres when `DATABASE_URL` is set. Migrations run
on open. Files (`{"file": "cut.mp4"}`) go to `VIREO_BUCKET` (any S3: set `VIREO_S3_ENDPOINT` for
R2 or MinIO). `VIREO_BY` names who acts.

A page that runs code (WebGL, scroll scenes) is a link: deploy it, then add
`{"media": "https://…", "posterFile": "still.jpg"}`. The host frames the link; vireo never serves
it. Use a URL that does not change (a preview deploy), so a call stays tied to what was seen.

## Slot it into a system

```ts
import { vireo, type Collector } from "@wrenautomation/vireo";
import { MIGRATIONS } from "@wrenautomation/vireo/migrations";
import { migrate } from "drizzle-orm/postgres-js/migrator";

await migrate(db, MIGRATIONS); // schema "vireo", journal drizzle.__vireo_migrations

const page: Collector = {
  channel: "page",
  target: "page id",
  rates: [{ name: "form", wins: "forms", of: "views" }],
  read: async (ship) => [{ segment: "all", metric: "views", value: 1000 } /* ... */],
};

const v = vireo({ db, collectors: [page], hooks: { onWrite: (tx, by) => setActor(tx, by) } });
await v.ship(sampleId, { channel: "page", target: "landing-b" }, "me");
await v.collect(); // run from your scheduler; Restate in wren
const { live } = await v.feedback("hero"); // rates, 95% range, P(best) per segment
```

| Port | You give |
|---|---|
| `db` | any drizzle pg database (postgres-js, node-postgres, PGlite) |
| `collectors` | one per channel: its rates, `read(ship)` → totals per segment |
| `hooks.onWrite` | first step of each write: audit actor, session settings |
| bucket | `s3Bucket({bucket, endpoint?})` for the CLI's uploads |

Add the commands to your own CLI: `registerCommands(program.command("variants"), {by, withVireo})` from
`@wrenautomation/vireo/cli`. Render the read models (`queue`, `feedback`, `catalog`); their types
are exported. Errors are `VireoError` with an HTTP status.

| Export | Is |
|---|---|
| `.` | `vireo()`, `Vireo`, types, `VireoError` |
| `/schema` | drizzle tables |
| `/migrations` | `MIGRATIONS` for your driver's migrator |
| `/stats` | Plackett-Luce, Beta posteriors, P(best), Wilson |
| `/sync` | cut spans ↔ footage time (browser safe) |
| `/media` | S3 bucket: put by content hash, signed GET |
| `/cli` | `registerCommands` |

## How it ranks

Each judged batch is a partial ranking: Amazing > Good > unmarked > Bad. Plackett-Luce fits a
strength per sample across batches. Guides (tips under test) get a with-vs-without good rate.
Live numbers get a Wilson 95% range and P(best) from Beta posteriors.

## License

PolyForm Strict 1.0.0. See `LICENSE.md`.
