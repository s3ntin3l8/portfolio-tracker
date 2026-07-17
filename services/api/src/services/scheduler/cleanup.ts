import { eq } from "drizzle-orm";
import { ibkrConnections, trConnections } from "@portfolio/db";
import type { DB } from "../../db/client.js";

/**
 * Clear any `syncing=true` flag left behind by a worker that never got to run its
 * terminal update — most commonly a process restart/crash mid-sync. Safe to call from
 * a fresh process: a brand-new process can't have an in-flight worker of its own, so
 * anything still marked `syncing` at boot is necessarily stale. A genuinely still-queued
 * pg-boss job (rare — the process only just started) re-runs and re-clears `syncing`
 * normally when it completes. Exported (and split out of `startScheduler`) so it's
 * unit-testable against PGlite without needing real Postgres/pg-boss.
 */
export async function resetStaleSyncFlags(
  db: DB,
): Promise<{ trConnections: number; ibkrConnections: number }> {
  const staleReset = { syncing: false, updatedAt: new Date() };
  const [staleTr, staleIbkr] = await Promise.all([
    db
      .update(trConnections)
      .set(staleReset)
      .where(eq(trConnections.syncing, true))
      .returning({ id: trConnections.id }),
    db
      .update(ibkrConnections)
      .set(staleReset)
      .where(eq(ibkrConnections.syncing, true))
      .returning({ id: ibkrConnections.id }),
  ]);
  return { trConnections: staleTr.length, ibkrConnections: staleIbkr.length };
}
