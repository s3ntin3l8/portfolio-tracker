import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { instruments } from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { findOrCreateInstrument } from "../../src/services/instruments.js";

describe("findOrCreateInstrument", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  const base = {
    market: "XETRA",
    assetClass: "etf" as const,
    unit: "shares" as const,
    currency: "EUR",
  };

  it("creates a new instrument when none matches", async () => {
    const inst = await findOrCreateInstrument(getDb(), {
      ...base,
      symbol: "VWCE",
      name: "Vanguard FTSE All-World",
      isin: "IE00BK5BQT80",
    });
    expect(inst.symbol).toBe("VWCE");
    expect(inst.assetClass).toBe("etf");
  });

  it("upgrades an ISIN-as-symbol to the real ticker on an ISIN match", async () => {
    const isin = "LU1737652583";
    await getDb()
      .insert(instruments)
      .values({ ...base, symbol: isin, assetClass: "mutual_fund", name: isin, isin });

    const healed = await findOrCreateInstrument(getDb(), {
      ...base,
      symbol: "AEMD",
      name: "Amundi Core MSCI EM",
      isin,
    });
    expect(healed.symbol).toBe("AEMD");
    expect(healed.assetClass).toBe("etf"); // mutual_fund → etf
  });

  it("never downgrades a real ticker to an ISIN or etf to mutual_fund", async () => {
    const isin = "IE000CNSFAR2";
    await getDb()
      .insert(instruments)
      .values({ ...base, symbol: "MWOF", assetClass: "etf", name: "Amundi MSCI World", isin });

    const unchanged = await findOrCreateInstrument(getDb(), {
      ...base,
      symbol: isin, // an ISIN must not overwrite the good ticker
      assetClass: "mutual_fund", // must not overwrite etf
      name: "Amundi MSCI World",
      isin,
    });
    expect(unchanged.symbol).toBe("MWOF");
    expect(unchanged.assetClass).toBe("etf");
  });

  it("does not clobber a specific asset class with the generic equity default", async () => {
    const isin = "LU1737652237";
    await getDb()
      .insert(instruments)
      .values({ ...base, symbol: "10AH", assetClass: "etf", name: "Amundi MSCI World", isin });

    const unchanged = await findOrCreateInstrument(getDb(), {
      ...base,
      symbol: "10AH",
      assetClass: "equity",
      name: "Amundi MSCI World",
      isin,
    });
    expect(unchanged.assetClass).toBe("etf");
  });

  it("heals a row matched by (symbol, market) when no ISIN is supplied", async () => {
    await getDb()
      .insert(instruments)
      .values({ ...base, symbol: "EUNL", assetClass: "mutual_fund", name: "iShares Core World" });

    const healed = await findOrCreateInstrument(getDb(), {
      ...base,
      symbol: "EUNL",
      assetClass: "etf",
      name: "iShares Core World",
    });
    expect(healed.assetClass).toBe("etf");
    // Confirm it updated in place, not inserted a duplicate.
    const rows = await getDb()
      .select()
      .from(instruments)
      .where(eq(instruments.symbol, "EUNL"));
    expect(rows).toHaveLength(1);
  });
});
