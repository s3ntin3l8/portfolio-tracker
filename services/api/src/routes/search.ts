import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { accountHolders, instruments, portfolios, transactions } from "@portfolio/db";
import { searchQuerySchema } from "@portfolio/schema";
import { requireUser } from "../plugins/auth.js";

/**
 * Global user-scoped search — two cheap ILIKE queries, no valuation computation.
 *
 * Returns:
 *   instruments — catalog hits (owned first), each tagged `owned: boolean`.
 *   transactions — the user's transactions matching description / tags.
 *
 * Scoped to the authenticated user; a `holderId` facet further narrows the
 * transaction + owned-instrument queries to that holder's portfolios (mirrors the
 * /networth?holderId= pattern).  `computeHoldings`/`summarizePortfolio` are
 * deliberately absent from this path — holdings search is represented by owned
 * instruments, not live valuations.
 */
export async function searchRoute(app: FastifyInstance) {
  app.get("/search", { preHandler: app.authenticate }, async (request, reply) => {
    const { q, types, holderId, limit } = searchQuerySchema.parse(request.query);
    const { id: userId } = requireUser(request);

    // Validate holder ownership (mirrors /networth holder guard).
    if (holderId != null) {
      const [holder] = await app.db
        .select({ id: accountHolders.id })
        .from(accountHolders)
        .where(and(eq(accountHolders.id, holderId), eq(accountHolders.userId, userId)))
        .limit(1);
      if (!holder) return reply.status(404).send({ code: "holder_not_found" });
    }

    // Resolve the user's portfolios (optionally filtered by holder).
    const pfs = await app.db
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(
        holderId != null
          ? and(eq(portfolios.userId, userId), eq(portfolios.accountHolderId, holderId))
          : eq(portfolios.userId, userId),
      );
    const pfIds = pfs.map((p) => p.id);

    // ── Instruments query ────────────────────────────────────────────────────
    // Search the global catalog by symbol / name / ISIN / WKN.  Separately
    // compute the set of instruments the user actually holds/transacted to tag
    // each result as owned or catalog-only.  Owned results sort first.
    const pattern = `%${q}%`;
    const matchedInstruments = await app.db
      .select()
      .from(instruments)
      .where(
        or(
          ilike(instruments.symbol, pattern),
          ilike(instruments.name, pattern),
          ilike(instruments.isin, pattern),
          ilike(instruments.wkn, pattern),
        ),
      )
      .orderBy(asc(instruments.symbol))
      .limit(limit);

    // Compute the owned-instrument set only when the user has portfolios.
    const ownedIds = new Set<string>();
    if (pfIds.length > 0) {
      const ownedRows = await app.db
        .selectDistinct({ instrumentId: transactions.instrumentId })
        .from(transactions)
        .where(
          and(
            inArray(transactions.portfolioId, pfIds),
            isNotNull(transactions.instrumentId),
          ),
        );
      for (const r of ownedRows) {
        if (r.instrumentId) ownedIds.add(r.instrumentId);
      }
    }

    // Sort owned instruments first, then catalog-only hits.
    const instrumentResults = [
      ...matchedInstruments
        .filter((i) => ownedIds.has(i.id))
        .map((i) => ({ ...i, owned: true })),
      ...matchedInstruments
        .filter((i) => !ownedIds.has(i.id))
        .map((i) => ({ ...i, owned: false })),
    ];

    // ── Transactions query ───────────────────────────────────────────────────
    // Match description (free-text memo) and tags (array → flattened string).
    // Joined to portfolios for the portfolioName display field.
    let txResults: object[] = [];
    if (pfIds.length > 0) {
      // Build the WHERE conditions array.
      const conds = [
        inArray(transactions.portfolioId, pfIds),
        or(
          // description is nullable; ILIKE on NULL returns NULL (= no match), which is fine.
          ilike(transactions.description, pattern),
          // Flatten the text[] tags array to a single string then ILIKE-match it.
          sql`array_to_string(${transactions.tags}, ' ') ILIKE ${pattern}`,
        ),
      ];

      // Optional type facet.
      if (types && types.length > 0) {
        conds.push(inArray(transactions.type, types));
      }

      const txRows = await app.db
        .select({
          id: transactions.id,
          portfolioId: transactions.portfolioId,
          portfolioName: portfolios.name,
          type: transactions.type,
          currency: transactions.currency,
          executedAt: transactions.executedAt,
          description: transactions.description,
          tags: transactions.tags,
          instrumentId: transactions.instrumentId,
        })
        .from(transactions)
        .leftJoin(portfolios, eq(transactions.portfolioId, portfolios.id))
        .where(and(...conds))
        .orderBy(desc(transactions.executedAt))
        .limit(limit);

      // Enrich each result with instrument symbol + name for display.
      const instrIds = [...new Set(txRows.map((r) => r.instrumentId).filter((x): x is string => x !== null))];
      const instrMap = new Map<string, { symbol: string; name: string }>();
      if (instrIds.length > 0) {
        const instrRows = await app.db
          .select({ id: instruments.id, symbol: instruments.symbol, name: instruments.name })
          .from(instruments)
          .where(inArray(instruments.id, instrIds));
        for (const r of instrRows) instrMap.set(r.id, { symbol: r.symbol, name: r.name });
      }

      txResults = txRows.map((r) => ({
        id: r.id,
        portfolioId: r.portfolioId,
        portfolioName: r.portfolioName,
        type: r.type,
        currency: r.currency,
        executedAt: r.executedAt,
        description: r.description,
        tags: r.tags,
        instrument: r.instrumentId ? (instrMap.get(r.instrumentId) ?? null) : null,
      }));
    }

    return { instruments: instrumentResults, transactions: txResults };
  });
}
