import { sql, type Transaction } from "kysely";
import { withSpan } from "../telemetry/tracing.js";
import type { Db } from "./client.js";
import type { Database } from "./schema.js";

/**
 * Runs `fn` in a transaction holding a per-change advisory lock (released at commit/rollback).
 *
 * EVERY writer of the managed PR comment or of per-change GitHub output (check runs) must hold
 * this lock while it reads the current state, writes to GitHub and stores the resulting IDs.
 * That serialises concurrent jobs for one PR so older output cannot overwrite newer output.
 */
export async function withChangeLock<T>(
  db: Db,
  changeId: string,
  fn: (tx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  // The span covers the wait for the lock and the work done under it; the wait is an attribute.
  return withSpan("change.lock", {}, (span) =>
    db.transaction().execute(async (tx) => {
      const startedAt = performance.now();
      await sql`select pg_advisory_xact_lock(hashtextextended('graft:change:' || ${changeId}::text, 0))`.execute(
        tx,
      );
      span.setAttribute("graft.lock.wait_ms", Math.round(performance.now() - startedAt));
      return fn(tx);
    }),
  );
}
