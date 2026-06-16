import { ensureDb, closeDb } from "./client.js";
import { refreshAntamBuyback, refreshNav } from "../services/scrapers/store.js";

/**
 * One-off CLI to run the market-data scrapers and populate the `scraped_quotes` cache
 * on demand — e.g. right after a deploy, instead of waiting for the scheduler's cron.
 * Reads DATABASE_URL from the environment (use `npm run scrape` locally, which loads
 * ../../.env; in a container run `node dist/db/scrape.js` with env already set).
 */
async function main() {
  const db = await ensureDb();
  const buyback = await refreshAntamBuyback(db);
  console.log(`Antam buyback: ${buyback ?? "unavailable"}`);
  const navFunds = await refreshNav(db);
  console.log(`Reksa-dana NAV funds cached: ${navFunds}`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
