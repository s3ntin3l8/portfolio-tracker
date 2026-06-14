import { PgBoss } from "pg-boss";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/client.js";
import { getMarketData } from "./market-data.js";
import { refreshHeldPrices } from "./refresh.js";

const QUEUE = "refresh-prices";
const SCHEDULE_CRON = "*/5 * * * *"; // every 5 minutes; the job self-gates on market hours

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
      const refreshed = await refreshHeldPrices(getDb(), getMarketData(), new Date());
      app.log.info({ refreshed }, "price refresh complete");
    } catch (err) {
      app.log.error({ err }, "price refresh failed");
    }
  });
  await boss.schedule(QUEUE, SCHEDULE_CRON);
  app.log.info({ cron: SCHEDULE_CRON }, "Price-refresh scheduler started");

  app.addHook("onClose", async () => {
    await boss.stop();
  });
}
