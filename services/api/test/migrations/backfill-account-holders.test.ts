import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { migrationsDir } from "@portfolio/db";

// Exercises the data backfill in migration 0028 directly: pre-migration portfolios
// carrying (account_holder, birth_year, portfolio_type) should collapse into a
// deduplicated set of account_holders and relink. The SQL is read from the migration
// file so this test can never drift from what actually ships.
function backfillSql(): string {
  const file = `${migrationsDir}/0028_account_holders.sql`;
  const raw = readFileSync(file, "utf8");
  const stmt = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .find((s) => s.includes("WITH candidates"));
  if (!stmt) throw new Error("backfill statement not found in 0028 migration");
  return stmt;
}

describe("0028 account-holders backfill", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Recreate the pre-migration shape (old columns) plus the new table + FK column,
    // matching the state the backfill runs against (after the table/column are added,
    // before the old columns are dropped).
    await db.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE account_holders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        name text NOT NULL,
        type text NOT NULL DEFAULT 'other',
        birth_year integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE portfolios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        name text NOT NULL,
        account_holder_id uuid,
        account_holder text,
        birth_year integer,
        portfolio_type text NOT NULL DEFAULT 'standard'
      );
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it("dedupes holders, derives type, and relinks portfolios", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    await db.sql`INSERT INTO users (id) VALUES (${u1}), (${u2})`;

    // u1: two child depots for the same kid (same name + birth year) → one holder;
    //     a spouse's standard account → another holder;
    //     a plain account with nothing → no holder.
    // u2: a child depot with a birth year but NO explicit holder name → falls back to
    //     the portfolio name; a same-named "Emma" but for u2 → a DISTINCT holder (scoped
    //     per user).
    await db.exec(`
      INSERT INTO portfolios (user_id, name, account_holder, birth_year, portfolio_type) VALUES
        ('${u1}', 'Kid A',   'Emma',  2017, 'child'),
        ('${u1}', 'Kid B',   'Emma',  2017, 'child'),
        ('${u1}', 'Joint',   'Alex',  NULL, 'standard'),
        ('${u1}', 'Plain',   NULL,    NULL, 'standard'),
        ('${u2}', 'Junior',  NULL,    2010, 'child'),
        ('${u2}', 'Other',   'Emma',  NULL, 'standard');
    `);

    await db.exec(backfillSql());

    const holders = (
      await db.query<{ user_id: string; name: string; type: string; birth_year: number | null }>(
        `SELECT user_id, name, type, birth_year FROM account_holders ORDER BY name, user_id`,
      )
    ).rows;

    // 5 holders total: u1{Emma/child/2017, Alex/other}, u2{Emma/other, Junior/child/2010}.
    expect(holders).toEqual([
      { user_id: u1, name: "Alex", type: "other", birth_year: null },
      { user_id: u1, name: "Emma", type: "child", birth_year: 2017 },
      { user_id: u2, name: "Emma", type: "other", birth_year: null },
      { user_id: u2, name: "Junior", type: "child", birth_year: 2010 },
    ]);

    // The two u1 child depots share ONE holder row.
    const kidA = (
      await db.query<{ account_holder_id: string }>(
        `SELECT account_holder_id FROM portfolios WHERE name = 'Kid A'`,
      )
    ).rows[0];
    const kidB = (
      await db.query<{ account_holder_id: string }>(
        `SELECT account_holder_id FROM portfolios WHERE name = 'Kid B'`,
      )
    ).rows[0];
    expect(kidA.account_holder_id).toBe(kidB.account_holder_id);
    expect(kidA.account_holder_id).not.toBeNull();

    // The nothing-set portfolio stays unassigned.
    const plain = (
      await db.query<{ account_holder_id: string | null }>(
        `SELECT account_holder_id FROM portfolios WHERE name = 'Plain'`,
      )
    ).rows[0];
    expect(plain.account_holder_id).toBeNull();

    // The unnamed child depot's holder name falls back to the portfolio name.
    const junior = (
      await db.query<{ name: string }>(
        `SELECT h.name FROM portfolios p JOIN account_holders h ON h.id = p.account_holder_id
         WHERE p.name = 'Junior'`,
      )
    ).rows[0];
    expect(junior.name).toBe("Junior");
  });
});
