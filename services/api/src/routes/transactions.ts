import type { FastifyInstance } from "fastify";
import { getFxRatesForDates } from "../services/fx.js";
import { registerListRoutes } from "./transactions/list.js";
import { registerCrudRoutes } from "./transactions/crud.js";
import { registerHoldingsRoutes } from "./transactions/holdings.js";
import { registerTradesRoutes } from "./transactions/trades.js";
import { registerIncomeRoutes } from "./transactions/income.js";
import { registerTaxRoutes } from "./transactions/tax.js";
import { registerContributionsRoutes } from "./transactions/contributions.js";
import { registerSparplanRoutes } from "./transactions/sparplan.js";
import { registerHistoryRoutes } from "./transactions/history.js";
import { registerNetworthRoutes } from "./transactions/networth.js";
import { registerInsightsRoutes } from "./transactions/insights.js";

export async function transactionsRoute(app: FastifyInstance) {
  registerListRoutes(app);
  registerCrudRoutes(app);
  registerHoldingsRoutes(app);
  registerTradesRoutes(app);
  registerIncomeRoutes(app);
  registerTaxRoutes(app);
  registerContributionsRoutes(app);
  registerSparplanRoutes(app);
  registerHistoryRoutes(app);
  registerNetworthRoutes(app);
  registerInsightsRoutes(app);

  // GET /fx-rate — lightweight FX lookup for the transaction detail sheet.
  app.get<{ Querystring: { from: string; to: string; date: string } }>(
    "/fx-rate",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { from, to, date } = request.query;
      if (!from || !to || !date) {
        return reply.code(400).send({ error: "from, to, and date are required" });
      }
      const rates = await getFxRatesForDates(app.db, [from], to, [date]);
      const rate = rates.get(date)?.[from] ?? null;
      return { rate };
    },
  );
}
