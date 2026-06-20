import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { corporateActions, instruments, portfolios, transactions } from "@portfolio/db";
import { mergerInputSchema } from "@portfolio/schema";
import { computeHoldings, type CoreTransaction, type CorporateAction } from "@portfolio/core";
import { requireUser } from "../plugins/auth.js";
import { enqueueRecompute } from "../services/scheduler.js";

export async function mergersRoute(app: FastifyInstance) {
  // Record a fund merger (Fondsverschmelzung / ISIN change) as a paired sell+buy, both
  // tagged `kind:"merger"`. The sell closes the old position; the buy opens the new one,
  // carrying cost basis (tax-neutral) or stepping up to market and realizing the gain
  // (taxable). Written as one two-row insert, so the pair lands atomically. Everything
  // downstream (holdings, TWR, trade log) treats them as ordinary trades; only
  // `contributions.ts` special-cases `kind:"merger"` to stay contribution-neutral.
  app.post<{ Params: { portfolioId: string } }>(
    "/portfolios/:portfolioId/mergers",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id: userId } = requireUser(request);
      const { portfolioId } = request.params;

      const [owned] = await app.db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .limit(1);
      if (!owned) return reply.code(404).send({ error: "portfolio_not_found" });

      const input = mergerInputSchema.parse({
        ...(request.body as Record<string, unknown>),
        portfolioId,
      });

      // Both instruments must exist and share a currency (cost basis is currency-blind,
      // and the legs must net to zero cash, so a cross-currency merger isn't supported).
      const instRows = await app.db
        .select()
        .from(instruments)
        .where(inArray(instruments.id, [input.fromInstrumentId, input.toInstrumentId]));
      const from = instRows.find((i) => i.id === input.fromInstrumentId);
      const to = instRows.find((i) => i.id === input.toInstrumentId);
      if (!from || !to) return reply.code(404).send({ error: "instrument_not_found" });
      if (from.currency !== to.currency) {
        return reply.code(400).send({ error: "currency_mismatch" });
      }
      const currency = from.currency;

      const outQty = new Decimal(input.outQty);
      const inQty = new Decimal(input.inQty);
      if (outQty.lte(0) || inQty.lte(0)) {
        return reply.code(400).send({ error: "quantities_must_be_positive" });
      }

      // Current holding of the old instrument → average cost / basis for the carry.
      const rows = await app.db
        .select()
        .from(transactions)
        .where(eq(transactions.portfolioId, portfolioId));
      const coreTxns: CoreTransaction[] = rows.map((r) => ({
        instrumentId: r.instrumentId,
        type: r.type,
        quantity: r.quantity,
        price: r.price,
        fees: r.fees,
        currency: r.currency,
        executedAt: r.executedAt,
        loanId: r.loanId,
        kind: r.kind,
        tax: r.tax,
      }));
      const caRows = await app.db
        .select()
        .from(corporateActions)
        .where(
          inArray(corporateActions.instrumentId, [input.fromInstrumentId, input.toInstrumentId]),
        );
      const cas: CorporateAction[] = caRows.map((r) => ({
        instrumentId: r.instrumentId,
        type: r.type,
        ratio: r.ratio,
        exDate: new Date(r.exDate),
      }));
      const holding = computeHoldings(coreTxns, cas).find(
        (h) => h.instrumentId === input.fromInstrumentId,
      );
      if (!holding || new Decimal(holding.quantity).lte(0)) {
        return reply.code(400).send({ error: "no_position_to_merge" });
      }
      const avgCost = new Decimal(holding.avgCost);

      // Sell leg price and buy leg total. Taxable → at market (realize the gain, new
      // basis steps up to market value); neutral → carry the basis of the merged-out
      // shares (avgCost × outQty — equals the full position basis for a 100% merger),
      // so the sell realizes nothing and the basis lands intact on the new instrument.
      const sellPrice = input.taxable ? new Decimal(input.marketValue!).div(outQty) : avgCost;
      const buyTotal = input.taxable ? new Decimal(input.marketValue!) : avgCost.mul(outQty);
      const buyPrice = buyTotal.div(inQty);

      const dateStr = input.executedAt.toISOString().slice(0, 10);
      const legs = [
        {
          portfolioId,
          instrumentId: input.fromInstrumentId,
          type: "sell" as const,
          quantity: outQty.toString(),
          price: sellPrice.toString(),
          fees: "0",
          currency,
          executedAt: input.executedAt,
          kind: "merger",
          source: "manual" as const,
          externalId: `merger:out:${input.fromInstrumentId}:${dateStr}`,
        },
        {
          portfolioId,
          instrumentId: input.toInstrumentId,
          type: "buy" as const,
          quantity: inQty.toString(),
          price: buyPrice.toString(),
          fees: "0",
          currency,
          executedAt: input.executedAt,
          kind: "merger",
          source: "manual" as const,
          externalId: `merger:in:${input.toInstrumentId}:${dateStr}`,
        },
      ];

      // The legs share a deterministic externalId per side, so re-recording the same
      // merger trips the (portfolioId, source, externalId) unique index — surface that
      // as a friendly 409 rather than a 500.
      let created;
      try {
        created = await app.db.insert(transactions).values(legs).returning();
      } catch (err) {
        // Postgres unique-violation is 23505; drizzle/PGlite may nest it under `cause`,
        // so also match the message as a fallback across drivers.
        const e = err as { code?: string; cause?: { code?: string }; message?: string };
        if (
          e.code === "23505" ||
          e.cause?.code === "23505" ||
          /duplicate key|unique constraint/i.test(e.message ?? "")
        ) {
          return reply.code(409).send({ error: "merger_already_recorded" });
        }
        throw err;
      }
      await enqueueRecompute(portfolioId, dateStr);
      reply.code(201);
      return created;
    },
  );
}
