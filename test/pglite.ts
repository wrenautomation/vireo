/** A fresh migrated PGlite per test file. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS } from "../src/migrations.js";

export async function testDb() {
  const pg = new PGlite();
  const db = drizzle(pg);
  await migrate(db, MIGRATIONS);
  return { db, close: () => pg.close() };
}
