import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { trConnections } from "@portfolio/db";
import { getDb } from "../db/client.js";
import { getMarketData, flushUsage } from "./market-data.js";
import { refreshHeldPrices } from "./refresh.js";
import { recordDailySnapshots } from "./snapshots.js";
import { refreshAntamBuyback, refreshNav } from "./scrapers/store.js";
import { syncTrConnection } from "./pytr/sync.js";

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
  boss.on("error", (err) => app.log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(QUEUE);

  await boss.work(QUEUE, async () => {
    try {
      const refreshed = await refreshHeldPrices(
        getDb(),
        await getMarketData(),
        new Date(),
      );
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

  // Hourly Trade Republic sync: stage each connected account's timeline as a draft
  // import the user later confirms. syncTrConnection itself is unit-tested apart from
  // pg-boss; here we just fan it across the connected rows.
  await boss.createQueue(TR_SYNC_QUEUE);
  await boss.work(TR_SYNC_QUEUE, async () => {
    try {
      const conns = await getDb()
        .select()
        .from(trConnections)
        .where(eq(trConnections.status, "connected"));
      for (const conn of conns) {
        const result = await syncTrConnection(
          getDb(),
          app.encryption,
          app.pytr,
          conn,
        );
        app.log.info({ connectionId: conn.id, result }, "tr sync complete");
      }
    } catch (err) {
      app.log.error({ err }, "tr sync failed");
    }
  });
  await boss.schedule(TR_SYNC_QUEUE, TR_SYNC_CRON);

  // Scrape the Antam gold buyback into scraped_quotes; served back to the AntamProvider
  // via /internal/gold/antam-buyback. The scraper self-handles failures (returns null).
  await boss.createQueue(ANTAM_QUEUE);
  await boss.work(ANTAM_QUEUE, async () => {
    try {
      const value = await refreshAntamBuyback(getDb());
      app.log.info({ value }, "antam buyback scrape complete");
    } catch (err) {
      app.log.error({ err }, "antam buyback scrape failed");
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

  app.log.info(
    {
      priceCron: SCHEDULE_CRON,
      snapshotCron: SNAPSHOT_CRON,
      trSyncCron: TR_SYNC_CRON,
      antamCron: ANTAM_CRON,
      navCron: NAV_CRON,
    },
    "Schedulers started",
  );

  app.addHook("onClose", async () => {
    await boss.stop();
  });
}
