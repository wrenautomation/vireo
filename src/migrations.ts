/**
 * Vireo's own migrations, for the host's drizzle migrator:
 * `migrate(db, MIGRATIONS)` from the host driver's `drizzle-orm/<driver>/migrator`.
 * Own journal table, so a host's drizzle history stays its own.
 */
import { fileURLToPath } from "node:url";

export const MIGRATIONS = {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  migrationsSchema: "drizzle",
  migrationsTable: "__vireo_migrations",
} as const;
