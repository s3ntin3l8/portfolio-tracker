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
 * `scraped_quotes`, in the exact JSON shape external buyback / NAV providers consume.
 * A missing key returns 404, which providers treat as "no quote" so the chain falls
 * through to spot / fixture.
 */
export async function internalMarketDataRoute(app: FastifyInstance) {
  app.get(
    "/internal/gold/antam-buyback",
    { preHandler: app.authenticate },
    async (_request, reply) => {
      const buyback = await getScrapedQuote(app.db, ANTAM_BUYBACK_KEY);
      if (buyback === null) return reply.code(404).send({ error: "no_quote" });
      return { buyback };
    },
  );

  app.get(
    "/internal/gold/galeri24-buyback",
    { preHandler: app.authenticate },
    async (_request, reply) => {
      const buyback = await getScrapedQuote(app.db, GALERI24_BUYBACK_KEY);
      if (buyback === null) return reply.code(404).send({ error: "no_quote" });
      return { buyback };
    },
  );

  const navParams = z.object({ symbol: z.string().min(1) });
  app.get("/internal/nav/:symbol", { preHandler: app.authenticate }, async (request, reply) => {
    const { symbol } = navParams.parse(request.params);
    const nav = await getScrapedQuote(app.db, navKey(symbol));
    if (nav === null) return reply.code(404).send({ error: "no_quote" });
    return { nav };
  });
}
