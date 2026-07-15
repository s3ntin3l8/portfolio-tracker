import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import {
  schema,
  users,
  portfolios,
  instruments,
  transactions,
} from "../src/index.js";

const migrationsFolder = path.resolve(import.meta.dirname, "../drizzle");

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

describe("@portfolio/db schema", () => {
  beforeAll(async () => {
    client = new PGlite({ extensions: { pg_trgm } });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await client.close();
  });

  it("applies the migration and round-trips an equity transaction", async () => {
    const [user] = await db
      .insert(users)
      .values({ authSub: "authentik|abc", email: "her@example.com" })
      .returning();
    expect(user.displayCurrency).toBe("IDR"); // default applied

    const [portfolio] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Stockbit" })
      .returning();

    const [bbca] = await db
      .insert(instruments)
      .values({
        symbol: "BBCA",
        market: "IDX",
        assetClass: "equity",
        currency: "IDR",
        name: "Bank Central Asia",
      })
      .returning();
    expect(bbca.unit).toBe("shares"); // default applied

    await db.insert(transactions).values({
      portfolioId: portfolio.id,
      instrumentId: bbca.id,
      type: "buy",
      quantity: "100",
      price: "9500",
      currency: "IDR",
      executedAt: new Date(),
      source: "manual",
    });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, portfolio.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe("100");
    expect(rows[0].type).toBe("buy");
  });

  it("supports instrument-less cash movements", async () => {
    const [user] = await db
      .insert(users)
      .values({ authSub: "authentik|cash", email: "cash@example.com" })
      .returning();
    const [portfolio] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "BCA" })
      .returning();

    const [deposit] = await db
      .insert(transactions)
      .values({
        portfolioId: portfolio.id,
        type: "deposit",
        price: "5000000",
        currency: "IDR",
        executedAt: new Date(),
      })
      .returning();
    expect(deposit.instrumentId).toBeNull();
    expect(deposit.type).toBe("deposit");
  });

  it("rejects duplicate imports via the dedup unique index", async () => {
    const [user] = await db
      .insert(users)
      .values({ authSub: "authentik|dedup", email: "dedup@example.com" })
      .returning();
    const [portfolio] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Bibit" })
      .returning();

    const row = {
      portfolioId: portfolio.id,
      type: "buy" as const,
      quantity: "1",
      price: "1000",
      currency: "IDR",
      executedAt: new Date(),
      source: "csv" as const,
      externalId: "row-42",
    };

    await db.insert(transactions).values(row);
    await expect(db.insert(transactions).values(row)).rejects.toThrow();
  });
});
