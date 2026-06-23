import { PgBoss } from "pg-boss";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { trConnections } from "@portfolio/db";
import { getDb } from "../db/client.js";
import { getMarketData, flushUsage } from "./market-data.js";
import { refreshHeldPrices } from "./refresh.js";
import { refreshDividends } from "./dividends.js";
import { refreshInstrumentMetadata } from "./instrument-metadata.js";
import { recordDailySnapshots } from "./snapshots.js";
import { refreshAntamBuyback, refreshGaleri24Buyback, refreshNav } from "./scrapers/store.js";
import { syncTrConnection } from "./pytr/sync.js";
import { backfillPortfolioHistory, backfillStalePortfolios } from "./backfill.js";
import { gcStagedReceipts } from "../storage/receipts.js";

const QUEUE = "refresh-prices";
const SCHEDULE_CRON = "*/5 * * * *"; // every 5 minutes; the job self-gates on market hours

const SNAPSHOT_QUEUE = "daily-snapshot";
const SNAPSHOT_CRON = "0 16 * * *"; // daily 16:00 UTC (~23:00 WIB, after the IDX close)

const TR_SYNC_QUEUE = "tr-sync";
const TR_SYNC_CRON = "0 * * * *"; // hourly — TR data isn't intraday; be gentle on their API

const ANTAM_QUEUE = "scrape-antam";
const ANTAM_CRON = "0 */4 * * *"; // every 4h — the Antam buyback moves intraday but slowly

const NAV_QUEUE = "scrape-nav";
// Twice daily: 16:00 UTC (~23:00 WIB), after the evening NAB publish, plus 01:00 UTC
// (~08:00 WIB) to backfill funds whose NAB posted late overnight. NAB is once-per-day, so
// more frequent runs would only re-fetch the same value.
const NAV_CRON = "0 1,16 * * *";

const DIVIDEND_QUEUE = "refresh-dividends";
// Weekly on Monday morning UTC — dividend ex-dates change slowly; daily would burn
// API quota for no practical gain. Runs early before the IDX open.
const DIVIDEND_CRON = "0 6 * * 1";

const INSTRUMENT_META_QUEUE = "refresh-instrument-metadata";
// Weekly on Sunday 04:00 UTC — sector/industry data changes at most quarterly; daily
// would burn keyed API quota for no gain. Sunday avoids clashing with the Monday
// dividend refresh.
const INSTRUMENT_META_CRON = "0 4 * * 0";

const GC_RECEIPTS_QUEUE = "gc-staged-receipts";
// Daily at 03:00 UTC — clean up staged documents from abandoned draft imports (>7d).
const GC_RECEIPTS_CRON = "0 3 * * *";

const RECOMPUTE_QUEUE = "recompute-history";
const RECOMPUTE_SINGLETON_SECONDS = 30; // collapse rapid edits per portfolio

const BACKFILL_STALE_QUEUE = "backfill-stale-history";
// Daily at 05:00 UTC — runs after the previous-day NAV/buyback scrapes (01:00/04:00 UTC)
// so flat proxies (mutual funds, ANTAM) use the freshest available rate. Near-no-op once
// all portfolios are healed; continues to self-heal any portfolio imported but never mutated.
const BACKFILL_STALE_CRON = "0 5 * * *";

let activeBoss: PgBoss | null = null;

/**
 * The full descriptor for each scheduled queue, used by the admin jobs panel.
 * `cron: null` means the queue is triggered on-demand (no fixed schedule).
 *
 * #105 note: `triggerJob()` only affects the replica that receives the request.
 *  In a multi-replica setup the pg-boss job is still enqueued in Postgres so any
 *  idle worker replica can pick it up, but `invalidateMarketData()` /
 *  `invalidateScreenshotParser()` (in-process cache only) are NOT propagated.
 *  A LISTEN/NOTIFY fan-out is the proper fix; deferred until >1 replica is in use.
 */
export const JOB_DESCRIPTORS = [
  {
    name: QUEUE,
    label: "Price refresh",
    description: "Refresh last prices for all held instruments during market hours.",
    cron: SCHEDULE_CRON,
  },
  {
    name: SNAPSHOT_QUEUE,
    label: "Daily snapshot",
    description: "Record daily net-worth snapshots for the dashboard chart.",
    cron: SNAPSHOT_CRON,
  },
  {
    name: TR_SYNC_QUEUE,
    label: "Trade Republic sync",
    description: "Pull the latest Trade Republic timeline events and stage as draft imports.",
    cron: TR_SYNC_CRON,
  },
  {
    name: ANTAM_QUEUE,
    label: "Gold buyback scrape",
    description: "Scrape Antam and Galeri24 buyback rates into the scraped-quotes cache.",
    cron: ANTAM_CRON,
  },
  {
    name: NAV_QUEUE,
    label: "Reksa dana NAV scrape",
    description: "Scrape the Bibit NAV catalogue for all tracked mutual funds.",
    cron: NAV_CRON,
  },
  {
    name: DIVIDEND_QUEUE,
    label: "Dividend refresh",
    description: "Pull announced and historical dividend events from market-data providers.",
    cron: DIVIDEND_CRON,
  },
  {
    name: INSTRUMENT_META_QUEUE,
    label: "Instrument metadata refresh",
    description: "Fetch sector/industry/country from market-data providers for held instruments missing a sector.",
    cron: INSTRUMENT_META_CRON,
    supportsForce: true,
  },
  {
    name: GC_RECEIPTS_QUEUE,
    label: "Receipt GC",
    description: "Delete staged receipt documents from abandoned draft imports (older than 7 days).",
    cron: GC_RECEIPTS_CRON,
  },
  {
    name: BACKFILL_STALE_QUEUE,
    label: "Backfill stale history",
    description:
      "Find portfolios whose value-over-time history doesn't reach back to inception and backfill them. Idempotent — near-no-op once all portfolios are healed.",
    cron: BACKFILL_STALE_CRON,
    supportsForce: true,
  },
] as const;

/** Return the active pg-boss instance, or null when the scheduler is not running. */
export function getActiveBoss(): PgBoss | null {
  return activeBoss;
}

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

/** 6 hours — repeated dashboard loads within this window collapse to one sweep. */
const INSTRUMENT_META_SINGLETON_SECONDS = 6 * 60 * 60;

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

function usesPglite(url: string): boolean {
  return !url || url.startsWith("pglite://");
}

/**
 * Start the pg-boss scheduler that proactively warms the last-price cache on
 * market hours. No-op without an external Postgres (PGlite/tests), since pg-boss
 * needs real Postgres features. The refresh logic itself lives in refresh.ts and
 * is unit-tested independently.
 */
export async function startScheduler(app: FastifyInstance): Promise<void> {
  const url = app.config.DATABASE_URL;
  if (app.config.NODE_ENV === "test" || usesPglite(url)) {
    app.log.info("Price-refresh scheduler disabled (no external Postgres)");
    return;
  }

  const boss = new PgBoss(url);
  activeBoss = boss;
  boss.on("error", (err) => app.log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(QUEUE);

  await boss.work(QUEUE, async () => {
    try {
      const refreshed = await refreshHeldPrices(getDb(), await getMarketData(), new Date());
      // Persist the provider calls this refresh made, so usage survives without an admin visit.
      await flushUsage();
      app.log.info({ refreshed }, "price refresh complete");
    } catch (err) {
      app.log.error({ err }, "price refresh failed");
    }
  });
  await boss.schedule(QUEUE, SCHEDULE_CRON);

  // Daily net-worth snapshots feed the dashboard's value-over-time chart.
  await boss.createQueue(SNAPSHOT_QUEUE);
  await boss.work(SNAPSHOT_QUEUE, async () => {
    try {
      const count = await recordDailySnapshots(
        getDb(),
        await getMarketData(),
        app.config.MARKET_DATA_TTL_MS,
        new Date(),
      );
      app.log.info({ count }, "daily snapshot complete");
    } catch (err) {
      app.log.error({ err }, "daily snapshot failed");
    }
  });
  await boss.schedule(SNAPSHOT_QUEUE, SNAPSHOT_CRON);

  // Hourly Trade Republic sync + on-demand per-connection trigger.
  // When job data carries `connectionId`, only that connection is synced (the manual-sync
  // path triggered via POST /tr/connection/sync); otherwise all connected accounts are
  // synced (the cron path). `syncing` is cleared after each connection whether it
  // succeeded or failed, so the frontend poller always sees a terminal state.
  await boss.createQueue(TR_SYNC_QUEUE);
  await boss.work(TR_SYNC_QUEUE, async (jobs) => {
    const connectionId =
      Array.isArray(jobs) && jobs.length > 0
        ? (jobs[0]?.data as Record<string, unknown> | null)?.connectionId
        : undefined;
    const targetId = typeof connectionId === "string" ? connectionId : undefined;
    try {
      const conns = await getDb()
        .select()
        .from(trConnections)
        .where(
          targetId
            ? and(eq(trConnections.id, targetId), eq(trConnections.status, "connected"))
            : eq(trConnections.status, "connected"),
        );
      for (const conn of conns) {
        const result = await syncTrConnection(getDb(), app.encryption, app.pytr, conn, app.log, app.storage);
        if (result.status === "connected") {
          app.log.info({ connectionId: conn.id, result }, "tr sync complete");
        } else {
          app.log.warn({ connectionId: conn.id, result }, "tr sync non-connected");
        }
      }
    } catch (err) {
      // On unexpected failure, clear the syncing flag for the targeted connection so the
      // frontend doesn't spin forever. All-connections errors log but don't flip syncing.
      if (targetId) {
        try {
          await getDb()
            .update(trConnections)
            .set({ syncing: false, updatedAt: new Date() })
            .where(eq(trConnections.id, targetId));
        } catch {
          // best-effort
        }
      }
      app.log.error({ err }, "tr sync failed");
    }
  });
  await boss.schedule(TR_SYNC_QUEUE, TR_SYNC_CRON);

  // Scrape the gold buyback rates (Antam + Galeri24) into scraped_quotes; served back to the
  // BuybackProviders via /internal/gold/<brand>-buyback. Each scraper self-handles failures
  // (returns null), so one dead source doesn't block the other.
  await boss.createQueue(ANTAM_QUEUE);
  await boss.work(ANTAM_QUEUE, async () => {
    try {
      const antam = await refreshAntamBuyback(getDb());
      const galeri24 = await refreshGaleri24Buyback(getDb());
      app.log.info({ antam, galeri24 }, "gold buyback scrape complete");
    } catch (err) {
      app.log.error({ err }, "gold buyback scrape failed");
    }
  });
  await boss.schedule(ANTAM_QUEUE, ANTAM_CRON);

  // Scrape the reksa-dana NAV catalogue (Bibit) into scraped_quotes; served back to the
  // NavProvider via /internal/nav/:symbol.
  await boss.createQueue(NAV_QUEUE);
  await boss.work(NAV_QUEUE, async () => {
    try {
      const count = await refreshNav(getDb());
      app.log.info({ count }, "reksa-dana nav scrape complete");
    } catch (err) {
      app.log.error({ err }, "reksa-dana nav scrape failed");
    }
  });
  await boss.schedule(NAV_QUEUE, NAV_CRON);

  // Weekly dividend refresh: pull announced/historical dividend events from providers
  // and upsert into dividend_events, ready for the income page blend.
  await boss.createQueue(DIVIDEND_QUEUE);
  await boss.work(DIVIDEND_QUEUE, async () => {
    try {
      const count = await refreshDividends(getDb(), await getMarketData(), new Date());
      await flushUsage();
      app.log.info({ count }, "dividend refresh complete");
    } catch (err) {
      app.log.error({ err }, "dividend refresh failed");
    }
  });
  await boss.schedule(DIVIDEND_QUEUE, DIVIDEND_CRON);

  // Weekly instrument-metadata refresh: fetch sector/industry/country for held
  // instruments still missing a sector and write it onto the instrument row.
  // Accepts { force: true } payload (from admin panel "Force re-run") to re-enrich
  // all held instruments regardless of sectorCheckedAt.
  await boss.createQueue(INSTRUMENT_META_QUEUE);
  await boss.work(INSTRUMENT_META_QUEUE, async (jobs) => {
    const force =
      Array.isArray(jobs) && jobs.length > 0
        ? Boolean((jobs[0]?.data as Record<string, unknown> | null)?.force)
        : false;
    try {
      const count = await refreshInstrumentMetadata(getDb(), await getMarketData(), { force });
      await flushUsage();
      app.log.info({ count, force }, "instrument metadata refresh complete");
    } catch (err) {
      app.log.error({ err }, "instrument metadata refresh failed");
    }
  });
  await boss.schedule(INSTRUMENT_META_QUEUE, INSTRUMENT_META_CRON);

  // GC sweep: delete staged receipt documents from abandoned draft imports (#231).
  await boss.createQueue(GC_RECEIPTS_QUEUE);
  await boss.work(GC_RECEIPTS_QUEUE, async () => {
    try {
      const deleted = await gcStagedReceipts(app);
      app.log.info({ deleted }, "gc-staged-receipts complete");
    } catch (err) {
      app.log.error({ err }, "gc-staged-receipts failed");
    }
  });
  await boss.schedule(GC_RECEIPTS_QUEUE, GC_RECEIPTS_CRON);

  // Self-healing sweep: find portfolios whose snapshot history doesn't reach back to
  // inception (pre-existing portfolios that pre-date the backfill engine) and run a
  // full inception backfill. Near-no-op once every portfolio is healed; continues to
  // catch any portfolio that is imported but never mutated.
  await boss.createQueue(BACKFILL_STALE_QUEUE);
  await boss.work(BACKFILL_STALE_QUEUE, async (jobs) => {
    // jobs[0].data may carry { force: true } when triggered from the admin panel
    // to rebuild all portfolios from inception (one-shot heal after a bug fix).
    const force = Array.isArray(jobs) && jobs.length > 0
      ? Boolean((jobs[0]?.data as Record<string, unknown> | null)?.force)
      : false;
    try {
      const result = await backfillStalePortfolios(
        getDb(),
        await getMarketData(),
        app.config.MARKET_DATA_TTL_MS,
        { force },
      );
      await flushUsage();
      app.log.info(
        { scanned: result.scanned, healed: result.healed, force },
        "backfill-stale-history complete",
      );
    } catch (err) {
      app.log.error({ err }, "backfill-stale-history failed");
    }
  });
  await boss.schedule(BACKFILL_STALE_QUEUE, BACKFILL_STALE_CRON);

  // On-demand recompute after transaction mutations. Debounced per portfolio so bulk
  // imports collapse to one job; fromDate bounds the work to the affected window.
  await boss.createQueue(RECOMPUTE_QUEUE);
  await boss.work(
    RECOMPUTE_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        try {
          const { portfolioId, fromDate } = job.data as { portfolioId: string; fromDate: string };
          const result = await backfillPortfolioHistory(
            getDb(),
            await getMarketData(),
            app.config.MARKET_DATA_TTL_MS,
            portfolioId,
            { fromDate },
          );
          app.log.info({ portfolioId, fromDate, ...result }, "history recompute complete");
        } catch (err) {
          app.log.error({ err }, "history recompute failed");
        }
      }
    },
  );

  app.log.info(
    {
      priceCron: SCHEDULE_CRON,
      snapshotCron: SNAPSHOT_CRON,
      trSyncCron: TR_SYNC_CRON,
      antamCron: ANTAM_CRON,
      navCron: NAV_CRON,
      dividendCron: DIVIDEND_CRON,
      recomputeQueue: RECOMPUTE_QUEUE,
      gcReceiptsCron: GC_RECEIPTS_CRON,
      backfillStaleCron: BACKFILL_STALE_CRON,
    },
    "Schedulers started",
  );

  app.addHook("onClose", async () => {
    await boss.stop();
    activeBoss = null;
  });
}
