#!/usr/bin/env node
/**
 * `vireo` on its own: DATABASE_URL (postgres) or a local PGlite at VIREO_DIR (default `.vireo`).
 * Migrates on open. VIREO_BUCKET (+ VIREO_S3_ENDPOINT) for files; VIREO_BY names who acts.
 */
import { userInfo } from "node:os";
import { Command } from "commander";
import { registerCommands } from "./cli.js";
import type { Db } from "./db.js";
import { vireo } from "./index.js";
import { s3Bucket } from "./media.js";
import { MIGRATIONS } from "./migrations.js";

async function open(): Promise<{ db: Db; close(): Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const db = drizzle(sql);
    await migrate(db, MIGRATIONS);
    return { db, close: () => sql.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const pg = new PGlite(process.env.VIREO_DIR ?? ".vireo");
  const db = drizzle(pg);
  await migrate(db, MIGRATIONS);
  return { db, close: () => pg.close() };
}

const bucketName = process.env.VIREO_BUCKET;
const program = new Command("vireo")
  .description("The variant loop: batches an agent makes, a person's calls and notes, live numbers")
  .showHelpAfterError();
registerCommands(program, {
  by: process.env.VIREO_BY ?? userInfo().username,
  ...(bucketName
    ? {
        bucket: s3Bucket({
          bucket: bucketName,
          ...(process.env.VIREO_S3_ENDPOINT ? { endpoint: process.env.VIREO_S3_ENDPOINT } : {}),
        }),
      }
    : {}),
  async withVireo(fn) {
    const { db, close } = await open();
    try {
      return await fn(vireo({ db }), db);
    } finally {
      await close();
    }
  },
});
program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
