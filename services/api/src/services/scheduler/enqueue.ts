import type { PgBoss } from "pg-boss";
import {
  IBKR_SYNC_QUEUE,
  INSTRUMENT_META_QUEUE,
  INSTRUMENT_META_SINGLETON_SECONDS,
  RECOMPUTE_QUEUE,
  RECOMPUTE_SINGLETON_SECONDS,
  TR_SYNC_QUEUE,
} from "./config.js";

let activeBoss: PgBoss | null = null;

export function setActiveBoss(boss: PgBoss | null): void {
  activeBoss = boss;
}

export { activeBoss };

/** Return the active pg-boss instance, or null when the scheduler is not running. */
export function getActiveBoss(): PgBoss | null {
  return activeBoss;
}

function usesPglite(url: string): boolean {
  return !url || url.startsWith("pglite://");
}

export { usesPglite };

/**
 * Enqueue a manual run of a named job queue.
 * Returns `{ queued: true }` on success, `{ queued: false }` when pg-boss is unavailable.
 * An optional `payload` object is forwarded as the job data (e.g. `{ force: true }`).
 */
export async function triggerJob(
  name: string,
  payload: Record<string, unknown> = {},
): Promise<{ queued: boolean }> {
  if (!activeBoss) return { queued: false };
  await activeBoss.send(name, payload);
  return { queued: true };
}

/**
 * Enqueue a per-connection IBKR sync, deduplicated. Falls back to inline when pg-boss is
 * unavailable (PGlite / tests).
 */
export async function enqueueIbkrSync(connectionId: string): Promise<{ queued: boolean }> {
  if (!activeBoss) return { queued: false };
  await activeBoss.send(
    IBKR_SYNC_QUEUE,
    { connectionId },
    { singletonKey: `ibkr-sync:${connectionId}`, singletonSeconds: 30 },
  );
  return { queued: true };
}

/**
 * Enqueue a per-connection TR sync, deduplicated so double-clicking doesn't queue two
 * concurrent syncs for the same connection. Returns `{ queued: true }` when the job was
 * enqueued, `{ queued: false }` when pg-boss is unavailable (caller falls back to inline).
 */
export async function enqueueTrSync(connectionId: string): Promise<{ queued: boolean }> {
  if (!activeBoss) return { queued: false };
  await activeBoss.send(
    TR_SYNC_QUEUE,
    { connectionId },
    { singletonKey: `tr-sync:${connectionId}`, singletonSeconds: 30 },
  );
  return { queued: true };
}

/**
 * Enqueue a history recompute for a portfolio, collapsed (debounced) via singletonKey so
 * rapid bulk-edits (multi-file import, TR sync) collapse to one job. fromDate bounds the
 * recompute to transactions on or after that date (pass min(changed executedAt)).
 * No-op when pg-boss is unavailable (PGlite / tests).
 */
export async function enqueueRecompute(portfolioId: string, fromDate: string): Promise<void> {
  if (!activeBoss) return;
  try {
    await activeBoss.send(
      RECOMPUTE_QUEUE,
      { portfolioId, fromDate },
      { singletonKey: portfolioId, singletonSeconds: RECOMPUTE_SINGLETON_SECONDS },
    );
  } catch {
    // non-fatal
  }
}

/**
 * Enqueue a sector-enrichment sweep, debounced so repeated dashboard requests
 * within a 6-hour window collapse to a single job execution. Fire-and-forget —
 * call with `void enqueueInstrumentMetadata()`.
 *
 * No-op when pg-boss is unavailable (PGlite / tests).
 */
export async function enqueueInstrumentMetadata(): Promise<void> {
  if (!activeBoss) return;
  try {
    await activeBoss.send(
      INSTRUMENT_META_QUEUE,
      {},
      { singletonKey: "sector-self-heal", singletonSeconds: INSTRUMENT_META_SINGLETON_SECONDS },
    );
  } catch {
    // non-fatal
  }
}
