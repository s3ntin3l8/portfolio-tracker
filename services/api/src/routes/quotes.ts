import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assetClassSchema, currencyCode } from "@portfolio/schema";
import { getMarketData } from "../services/market-data.js";

const quoteQuerySchema = z.object({
  symbol: z.string().min(1),
  market: z.string().min(1),
  assetClass: assetClassSchema,
  currency: currencyCode,
});

export async function quotesRoute(app: FastifyInstance) {
  // Live quote for a single instrument ref (drives the gold ticker + a future
  // quote picker). Priced through the same provider chain as portfolio valuation.
  app.get(
    "/quotes",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const q = quoteQuerySchema.parse(request.query);
      const md = await getMarketData();
      const quote = await md.getQuote({
        symbol: q.symbol,
        market: q.market,
        assetClass: q.assetClass,
        currency: q.currency,
      });
      if (!quote) {
        return reply.code(404).send({ error: "quote_unavailable" });
      }
      return {
        symbol: q.symbol,
        market: q.market,
        assetClass: q.assetClass,
        ...quote,
      };
    },
  );
}
