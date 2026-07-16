import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, ilike, or, count } from "drizzle-orm";
import { instruments, providerSettings } from "@portfolio/db";
import { assetClassSchema, instrumentInputSchema } from "@portfolio/schema";
import { findOrCreateInstrument, updateInstrument } from "../services/instruments.js";
import { getMarketData, goldSources, getBorseFrankfurt } from "../services/market-data.js";
import { withDerivationCache, createStore } from "../lib/derivation-cache.js";
import { logTiming } from "../lib/timing.js";
import {
  FUNDAMENTALS_ASSET_CLASSES,
  isFundamentalsStale,
} from "../services/instrument-metadata.js";
import type { InstrumentFundamentals } from "@portfolio/market-data";

const instrumentsCache = createStore<{
  rows: (typeof instruments.$inferSelect)[];
  total: number;
}>();

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const lookupQuerySchema = z.object({ q: z.string().trim().min(1) });
const historyQuerySchema = z.object({ range: z.string().default("1y") });
const patchInstrumentSchema = z.object({
  isin: z.string().nullable().optional(),
  wkn: z.string().nullable().optional(),
  symbol: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  assetClass: assetClassSchema.optional(),
  market: z.string().min(1).optional(),
});
const enrichQuerySchema = z.object({ q: z.string().trim().min(1) });

export async function instrumentsRoute(app: FastifyInstance) {
  // Search instruments (shared reference data) for the manual-entry picker.
  app.get("/instruments", { preHandler: app.authenticate }, async (request) => {
    const t0 = performance.now();
    const parsed = searchQuerySchema.parse(request.query);
    const q = parsed.q;
    const pageSize = parsed.pageSize;

    if (parsed.page) {
      const page = parsed.page;
      const cacheKey = `instruments:${q || ""}:${page}:${pageSize}`;
      const { rows, total } = await withDerivationCache(instrumentsCache, cacheKey, async () => {
        const conditions = q
          ? or(
              ilike(instruments.symbol, `%${q}%`),
              ilike(instruments.name, `%${q}%`),
              ilike(instruments.isin, `%${q}%`),
              ilike(instruments.wkn, `%${q}%`),
            )
          : undefined;
        const [cnt, _rows] = await Promise.all([
          conditions
            ? app.db
                .select({ count: count() })
                .from(instruments)
                .where(conditions)
                .then((r) => Number(r[0].count))
            : app.db
                .select({ count: count() })
                .from(instruments)
                .then((r) => Number(r[0].count)),
          conditions
            ? app.db
                .select()
                .from(instruments)
                .where(conditions)
                .orderBy(asc(instruments.symbol))
                .limit(pageSize)
                .offset((page - 1) * pageSize)
            : app.db
                .select()
                .from(instruments)
                .orderBy(asc(instruments.symbol))
                .limit(pageSize)
                .offset((page - 1) * pageSize),
        ]);
        return { rows: _rows, total: cnt };
      });
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /instruments (paginated)", durationMs, { q, page, pageSize, total });
      return { rows, total };
    }

    // Legacy path: no pagination, return bare array.
    const conditions = q
      ? or(
          ilike(instruments.symbol, `%${q}%`),
          ilike(instruments.name, `%${q}%`),
          ilike(instruments.isin, `%${q}%`),
          ilike(instruments.wkn, `%${q}%`),
        )
      : undefined;
    const rows = conditions
      ? await app.db.select().from(instruments).where(conditions).orderBy(asc(instruments.symbol))
      : await app.db.select().from(instruments).orderBy(asc(instruments.symbol));
    const durationMs = performance.now() - t0;
    logTiming(request, "GET /instruments", durationMs, { q, rowCount: rows.length });
    return rows;
  });

  // Discover instruments from market-data providers (ticker/name search or ISIN
  // resolution) to auto-fill the manual-entry form. Complements `GET /instruments`,
  // which only matches already-saved reference data. Provider failures degrade to [].
  app.get("/instruments/lookup", { preHandler: app.authenticate }, async (request) => {
    const { q } = lookupQuerySchema.parse(request.query);
    try {
      const md = await getMarketData();
      return await md.search(q);
    } catch (err) {
      request.log.warn({ err }, "instrument lookup failed");
      return [];
    }
  });

  // Selectable gold buyback sources (Antam, and any other configured gold provider) for the
  // manual-entry form's gold flow. Each maps to the `market` to stamp on the instrument so
  // quotes route to the right provider. Registry-driven — no UI change when a source is added.
  app.get("/instruments/gold-sources", { preHandler: app.authenticate }, async () => {
    const rows = await app.db
      .select({
        provider: providerSettings.provider,
        enabled: providerSettings.enabled,
        priority: providerSettings.priority,
      })
      .from(providerSettings);
    return goldSources(rows);
  });

  // Fetch a single instrument by id.
  app.get<{ Params: { id: string } }>(
    "/instruments/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const [inst] = await app.db
        .select()
        .from(instruments)
        .where(eq(instruments.id, request.params.id))
        .limit(1);
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /instruments/:id", durationMs, { instrumentId: request.params.id });
      if (!inst) return reply.code(404).send({ error: "instrument_not_found" });
      return inst;
    },
  );

  // Price history (candles) for an instrument's detail chart.
  app.get<{ Params: { id: string } }>(
    "/instruments/:id/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const { range } = historyQuerySchema.parse(request.query);
      const [inst] = await app.db
        .select()
        .from(instruments)
        .where(eq(instruments.id, request.params.id))
        .limit(1);
      if (!inst) {
        const durationMs = performance.now() - t0;
        logTiming(request, "GET /instruments/:id/history", durationMs, {
          instrumentId: request.params.id,
          range,
          found: false,
        });
        return reply.code(404).send({ error: "instrument_not_found" });
      }
      const md = await getMarketData();
      const result = await md.getHistory(
        {
          symbol: inst.symbol,
          market: inst.market,
          assetClass: inst.assetClass,
          currency: inst.currency,
        },
        range,
      );
      const durationMs = performance.now() - t0;
      logTiming(request, "GET /instruments/:id/history", durationMs, {
        instrumentId: request.params.id,
        range,
        found: true,
      });
      return result;
    },
  );

  // Fundamentals (market cap, PE, EPS, dividend yield, 52-week range, analyst
  // recommendations, revenue-vs-earnings, next earnings date) for the instrument detail
  // view. Equity/ETF only — other asset classes (gold, bond, mutual_fund, crypto, cash)
  // return null without hitting a provider. Self-heals: serves the cached DB blob when
  // fresh (< 24h), otherwise fetches live and persists. `fundamentalsCheckedAt` is stamped
  // on every attempt that reaches the provider loop — even an empty/failed result — so a
  // provider miss isn't re-queried on every page view, and never clobbers a previously-good
  // cached blob with an empty result. Note: MarketDataService.getFundamentals() already
  // swallows a per-provider exception and returns null (same convention as getQuote/
  // getProfile/etc.), so a throwing provider is indistinguishable here from "no data" and
  // is stamped the same way; the try/catch below only guards failures outside that loop
  // (e.g. getMarketData() itself throwing).
  app.get<{ Params: { id: string } }>(
    "/instruments/:id/fundamentals",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const t0 = performance.now();
      const [inst] = await app.db
        .select()
        .from(instruments)
        .where(eq(instruments.id, request.params.id))
        .limit(1);
      if (!inst) {
        logTiming(request, "GET /instruments/:id/fundamentals", performance.now() - t0, {
          instrumentId: request.params.id,
          found: false,
        });
        return reply.code(404).send({ error: "instrument_not_found" });
      }

      if (!FUNDAMENTALS_ASSET_CLASSES.has(inst.assetClass)) {
        logTiming(request, "GET /instruments/:id/fundamentals", performance.now() - t0, {
          instrumentId: request.params.id,
          assetClass: inst.assetClass,
          supported: false,
        });
        return null;
      }

      // The jsonb column is stored as a loosely-typed Record; cast at the boundary since
      // `InstrumentFundamentals` (a concrete interface) is what actually flows through.
      const cached = (inst.fundamentals ?? null) as InstrumentFundamentals | null;

      if (!isFundamentalsStale(inst)) {
        logTiming(request, "GET /instruments/:id/fundamentals", performance.now() - t0, {
          instrumentId: request.params.id,
          cacheHit: true,
        });
        return cached;
      }

      const md = await getMarketData();
      let fetched: InstrumentFundamentals | null = null;
      let fetchFailed = false;
      try {
        fetched = await md.getFundamentals({
          symbol: inst.symbol,
          market: inst.market,
          assetClass: inst.assetClass,
          currency: inst.currency,
          isin: inst.isin ?? undefined,
        });
      } catch (err) {
        fetchFailed = true;
        request.log.warn({ err, instrumentId: inst.id }, "fundamentals fetch failed");
      }

      if (!fetchFailed) {
        await app.db
          .update(instruments)
          .set({
            fundamentalsCheckedAt: new Date(),
            // Only overwrite the stored blob when we actually got something — an
            // empty provider response shouldn't wipe out a previously-good snapshot.
            ...(fetched != null
              ? { fundamentals: fetched as unknown as Record<string, unknown> }
              : {}),
          })
          .where(eq(instruments.id, inst.id));
      }

      logTiming(request, "GET /instruments/:id/fundamentals", performance.now() - t0, {
        instrumentId: request.params.id,
        cacheHit: false,
        fetchFailed,
        found: fetched != null,
      });
      return fetched ?? cached;
    },
  );

  // Find-or-create an instrument by its (market, symbol) identity. When the input
  // carries an ISIN with an unrecognised market, an OpenFIGI lookup corrects it before
  // the identity search and insert (best-effort; falls back to the provided market on
  // any failure).
  app.post("/instruments", { preHandler: app.authenticate }, async (request, reply) => {
    const input = instrumentInputSchema.parse(request.body);
    const md = await getMarketData();
    const instrument = await findOrCreateInstrument(app.db, input, {
      resolveMarket: async (isin) => {
        const [hit] = await md.search(isin);
        return hit ? { market: hit.market, currency: hit.currency } : null;
      },
    });
    reply.code(201);
    return instrument;
  });

  // Update an instrument's editable identifiers (ISIN, WKN, symbol, name, assetClass).
  // Returns 409 when the new ISIN or WKN is already taken by another row.
  // Admin-gated: this is shared reference data that feeds every user's valuations —
  // find-or-create (POST, above) stays open since it's load-bearing for normal
  // add-transaction flows, but editing an existing instrument's identity is not.
  app.patch<{ Params: { id: string } }>(
    "/instruments/:id",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const patch = patchInstrumentSchema.parse(request.body);
      const result = await updateInstrument(app.db, request.params.id, patch);
      if (result === "not_found") return reply.code(404).send({ error: "instrument_not_found" });
      if (result === "conflict") return reply.code(409).send({ error: "identifier_conflict" });
      return result;
    },
  );

  // On-demand enrichment via Börse Frankfurt. Returns ISIN + WKN + ticker together for a
  // given query. Only available when BORSE_FRANKFURT_ENABLED=true. Not on the typeahead.
  app.get("/instruments/enrich", { preHandler: app.authenticate }, async (request, reply) => {
    const { q } = enrichQuerySchema.parse(request.query);
    const bf = getBorseFrankfurt();
    if (!bf) return reply.code(503).send({ error: "enrichment_unavailable" });
    try {
      return await bf.search(q);
    } catch (err) {
      request.log.warn({ err }, "BF enrichment failed");
      return [];
    }
  });
}
