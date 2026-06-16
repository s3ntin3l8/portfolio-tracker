import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getScrapedQuote,
  ANTAM_BUYBACK_KEY,
  GALERI24_BUYBACK_KEY,
  navKey,
} from "../services/scrapers/store.js";

/**
 * Internal market-data endpoints that serve the values our scrapers cache in
 * `scraped_quotes`, in the exact JSON shape the `AntamProvider` / `NavProvider` consume.
 * The providers fetch these over HTTP (see the registry URL defaults in market-data.ts),
 * which keeps their URL contract intact and lets the URLs be repointed at an external
 * source later. Unauthenticated by design: they expose only public, already-published
 * prices and are the providers' own data source. A missing key returns 404, which the
 * providers treat as "no quote" so the chain falls through to spot / fixture.
 */
export async function internalMarketDataRoute(app: FastifyInstance) {
  app.get("/internal/gold/antam-buyback", async (_request, reply) => {
    const buyback = await getScrapedQuote(app.db, ANTAM_BUYBACK_KEY);
    if (buyback === null) return reply.code(404).send({ error: "no_quote" });
    return { buyback };
  });

  app.get("/internal/gold/galeri24-buyback", async (_request, reply) => {
    const buyback = await getScrapedQuote(app.db, GALERI24_BUYBACK_KEY);
    if (buyback === null) return reply.code(404).send({ error: "no_quote" });
    return { buyback };
  });

  const navParams = z.object({ symbol: z.string().min(1) });
  app.get("/internal/nav/:symbol", async (request, reply) => {
    const { symbol } = navParams.parse(request.params);
    const nav = await getScrapedQuote(app.db, navKey(symbol));
    if (nav === null) return reply.code(404).send({ error: "no_quote" });
    return { nav };
  });
}
