/** The host's database: any drizzle pg driver (postgres-js, node-postgres, PGlite). */
import { type PgDatabase, PgTransaction } from "drizzle-orm/pg-core";

// biome-ignore lint/suspicious/noExplicitAny: any pg driver's result type and schema
export type Db = PgDatabase<any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: same, inside a transaction
export type Tx = PgTransaction<any, any, any>;
export type Queryable = Db | Tx;

export interface Hooks {
  /** First step of each write's transaction: the host's audit actor, session settings. */
  onWrite?: (tx: Tx, by: string) => Promise<void>;
}

/** A "no" to the caller, with the HTTP status a host should answer. */
export class VireoError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "VireoError";
  }
}

/** Read committed; nests as a savepoint inside a host's transaction. */
export function atomic<T>(db: Queryable, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (db instanceof PgTransaction) return db.transaction(fn);
  return db.transaction(fn, { isolationLevel: "read committed" });
}
