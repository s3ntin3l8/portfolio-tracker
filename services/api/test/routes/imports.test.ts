import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  parsedGoldContractSchema,
  type ParsedGoldContract,
  type ParsedTransaction,
} from "@portfolio/schema";
import type { ScreenshotParser } from "../../src/services/parsers/types.js";

/**
 * Build a raw multipart/form-data Buffer for a screenshot/PDF import.
 * Returns `{ headers, payload }` compatible with `app.inject()`.
 * Avoids the `form-auto-content` ESM/CJS interop issue under NodeNext resolution.
 */
function screenshotPart(buf: Buffer, contentType: string, filename = "upload") {
  const boundary = "----PortfolioTestBoundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  };
}

// Mock parser so the screenshot flow is hermetic (no Anthropic/Gemini/OpenRouter call).
function mockParser(
  drafts: ParsedTransaction[],
  configured = true,
  contracts: ParsedGoldContract[] = [],
): ScreenshotParser {
  return {
    name: "mock",
    isConfigured: () => configured,
    parse: async () => ({ drafts, contracts }),
  };
}

const GOLD_DRAFT = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  fees: "0",
  currency: "IDR",
  executedAt: new Date("2026-02-08T00:00:00.000Z"),
  confidence: 0.9,
} satisfies ParsedTransaction;

const ISSUER = "https://auth.test/o/p/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let privateKey: CryptoKey;

async function token(sub: string) {
  return new SignJWT({ email: `${sub}@example.com` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const CSV = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR`;

// A DKB Girokonto Umsatzliste (anonymised): a savings-plan buy, a dividend, a cash
// deposit and a cash withdrawal — the four row kinds the parser must classify.
const DKB_GIRO_CSV = [
  '"Girokonto";"DE78120300001066505387"',
  '"Zeitraum:";"01.01.2026 - 15.06.2026"',
  '""',
  '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"',
  '"15.06.26";"12.06.26";"Gebucht";"DKB AG";"Max Mustermann";"Depot 0506740786 Wertpapierertrag 12.06.2026 000066336002660 WKN 870747 MICROSOFT    DL-,00000625 ISIN US5949181045";"Eingang";"0000000000";"0,67";"";"";""',
  '"08.06.26";"09.06.26";"Gebucht";"Max Mustermann";"DKB AG";"Depot 0506740786 Wertp.Abrechn. 05.06.2026 000006520078300 WKN A2H9Q0 Gesch.Art KV AIS-A.CO.MSCI E.M.UETFDRD ISIN LU1737652583 Ihr Wertpapier-Sparplan Preis       74,50600000 EUR Stück           0,3355";"Ausgang";"0000000000";"-25";"";"";""',
  '"01.06.26";"01.06.26";"Gebucht";"Erika Mustermann";"FRAU MAX MUSTERMANN";"Sparplan";"Eingang";"DE69120300001053487276";"75";"";"";""',
  '"13.04.26";"11.04.26";"Gebucht";"Max Mustermann";"Erika Mustermann";"Übertrag";"Ausgang";"DE15100123450587698301";"-509,59";"";"";""',
].join("\n");

describe("CSV import → confirm flow", () => {
  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    // This block shares one app across many tests, so the global rate limiter (default
    // 100/min) accumulates and would 429 later tests. Lift it for the suite.
    process.env.RATE_LIMIT_MAX = "10000";
    app = await buildApp({ authKey: kp.publicKey });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    delete process.env.RATE_LIMIT_MAX;
  });

  it("imports drafts, confirms to transactions, and 409s on re-confirm", async () => {
    const t = await token("imp-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "BCA", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: CSV },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(1);

    const got = await app.inject({
      method: "GET",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe("draft");

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    expect(confirm.json().confirmed).toBe(1);

    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(1);

    const again = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(again.statusCode).toBe(409);
  });

  it("imports a DKB Girokonto export: securities + cash, idempotent on re-import", async () => {
    const t = await token("dkb-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DKB", baseCurrency: "EUR" },
      })
    ).json().id;

    const imp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV, format: "dkb" },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(4); // dividend, savings-plan buy, deposit, withdrawal

    const stored = await app.inject({
      method: "GET",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(stored.json().parser).toBe("dkb");

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    const txns = confirm.json().transactions as Array<{
      type: string;
      source: string;
      currency: string;
      instrumentId: string | null;
    }>;
    expect(txns).toHaveLength(4);
    expect(txns.every((x) => x.source === "csv")).toBe(true);
    expect(txns.every((x) => x.currency === "EUR")).toBe(true);
    // Cash rows have no instrument; securities rows do.
    const cash = txns.filter((x) => x.type === "deposit" || x.type === "withdrawal");
    const securities = txns.filter((x) => x.type === "savings_plan" || x.type === "dividend");
    expect(cash).toHaveLength(2);
    expect(cash.every((x) => x.instrumentId === null)).toBe(true);
    expect(securities.every((x) => x.instrumentId !== null)).toBe(true);

    // Re-uploading the same export: the file fingerprint returns the confirmed import
    // (no new draft created). The idempotency guarantee is now enforced at the upload
    // level before a new draft would be spawned.
    const reImp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV, format: "dkb" },
    });
    expect(reImp.json().alreadyConfirmed).toBe(true);
    expect(reImp.json().importId).toBe(importId);
  });

  it("auto-detects the parser when format is omitted (DKB vs generic)", async () => {
    const t = await token("auto-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Auto", baseCurrency: "EUR" },
      })
    ).json().id;

    // No format → the DKB Girokonto export is recognised and parsed as DKB.
    const dkb = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: DKB_GIRO_CSV },
    });
    expect(dkb.statusCode).toBe(201);
    expect(dkb.json().drafts).toHaveLength(4);
    const dkbDetail = (
      await app.inject({ method: "GET", url: `/imports/${dkb.json().importId}`, headers: auth(t) })
    ).json();
    expect(dkbDetail.parser).toBe("dkb");
    // The single-import endpoint returns the parsed drafts (powers the review screen).
    expect(dkbDetail.drafts).toHaveLength(4);
    expect(dkbDetail.status).toBe("draft");

    // No format → the generic column CSV falls through to the generic parser.
    const generic = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: CSV },
    });
    expect(generic.statusCode).toBe(201);
    expect(generic.json().drafts).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: `/imports/${generic.json().importId}`, headers: auth(t) })).json().parser,
    ).toBe("csv");
  });

  it("lists imports, discards a draft, and undoes a confirmed import", async () => {
    const t = await token("hist-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Hist", baseCurrency: "IDR" },
      })
    ).json().id;

    // One draft we'll discard, one we'll confirm then undo.
    // Use distinct CSV content so the file fingerprint creates two separate imports.
    const CSV_BMRI = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency\n2026-01-16,buy,equity,BMRI,Bank Mandiri,200,shares,6000,0,IDR`;
    const draftImp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    const confirmImp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV_BMRI },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${confirmImp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: confirmImp.drafts },
    });

    // List: newest first, with status + count.
    const list = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; status: string; count: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(draftImp.importId);
    expect(rows.find((r) => r.id === confirmImp.importId)!.status).toBe("confirmed");
    expect(rows.find((r) => r.id === draftImp.importId)!.count).toBe(1);

    // Discard the draft (confirmed imports can't be discarded — 409).
    expect(
      (await app.inject({ method: "POST", url: `/imports/${draftImp.importId}/discard`, headers: auth(t) }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "POST", url: `/imports/${confirmImp.importId}/discard`, headers: auth(t) }))
        .statusCode,
    ).toBe(409);

    // Undo the confirmed import: its transaction is removed and it's marked discarded.
    const undo = await app.inject({
      method: "DELETE",
      url: `/imports/${confirmImp.importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().removed).toBe(1);
    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(0);
    expect(
      (await app.inject({ method: "GET", url: `/imports/${confirmImp.importId}`, headers: auth(t) }))
        .json().status,
    ).toBe("discarded");

    // Another user can't touch these imports.
    const other = await token("hist-other");
    expect(
      (await app.inject({ method: "DELETE", url: `/imports/${draftImp.importId}`, headers: auth(other) }))
        .statusCode,
    ).toBe(404);
  });

  it("clears a discarded import (hard-delete)", async () => {
    const t = await token("clear-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "ClearTest", baseCurrency: "IDR" },
      })
    ).json().id;

    // Create a draft and discard it.
    const imp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/discard`,
      headers: auth(t),
    });

    // Clear should hard-delete the row → 204, then 404 on GET, and absent from list.
    const clear = await app.inject({
      method: "DELETE",
      url: `/imports/${imp.importId}/clear`,
      headers: auth(t),
    });
    expect(clear.statusCode).toBe(204);

    expect(
      (await app.inject({ method: "GET", url: `/imports/${imp.importId}`, headers: auth(t) }))
        .statusCode,
    ).toBe(404);

    const list = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(list.json().map((r: { id: string }) => r.id)).not.toContain(imp.importId);
  });

  it("rejects clear on a draft or confirmed import (409)", async () => {
    const t = await token("clear-409-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "ClearTest2", baseCurrency: "IDR" },
      })
    ).json().id;

    // draft → 409
    const draftImp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/imports/${draftImp.importId}/clear`,
          headers: auth(t),
        })
      ).statusCode,
    ).toBe(409);

    // confirmed → 409
    await app.inject({
      method: "POST",
      url: `/imports/${draftImp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: draftImp.drafts },
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/imports/${draftImp.importId}/clear`,
          headers: auth(t),
        })
      ).statusCode,
    ).toBe(409);
  });

  it("rejects clear from another user (404)", async () => {
    const owner = await token("clear-owner");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(owner),
        payload: { name: "ClearOwner", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(owner),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/discard`,
      headers: auth(owner),
    });

    const other = await token("clear-other");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/imports/${imp.importId}/clear`,
          headers: auth(other),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("bulk-clears only the caller's discarded imports", async () => {
    const t = await token("bulk-clear-user");
    await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "BulkClear", baseCurrency: "IDR" },
    });

    // Three imports: discard two, leave one as a draft.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const imp = (
        await app.inject({
          method: "POST",
          url: `/imports/csv`,
          headers: auth(t),
          // Vary the content so each is a distinct import (file-level dedup otherwise
          // collapses identical re-uploads onto the same draft row).
          payload: { content: `${CSV}\n# import ${i}` },
        })
      ).json();
      ids.push(imp.importId);
    }
    const [discardedA, discardedB, draftId] = ids;
    for (const id of [discardedA, discardedB]) {
      await app.inject({ method: "POST", url: `/imports/${id}/discard`, headers: auth(t) });
    }

    // Another user's discarded import — must not be touched by t's bulk-clear.
    const other = await token("bulk-clear-other");
    await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(other),
      payload: { name: "OtherBulk", baseCurrency: "IDR" },
    });
    const otherImp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(other),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${otherImp.importId}/discard`,
      headers: auth(other),
    });

    // Clear all four ids in one request: only t's two discarded rows are removed —
    // the draft (not discarded) and the other user's row (not owned) are skipped.
    const res = await app.inject({
      method: "POST",
      url: "/imports/bulk-clear",
      headers: auth(t),
      payload: { ids: [discardedA, discardedB, draftId, otherImp.importId] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared).toBe(2);

    // The discarded rows are gone; the draft survives.
    const remaining = (
      await app.inject({ method: "GET", url: "/imports", headers: auth(t) })
    ).json().map((r: { id: string }) => r.id);
    expect(remaining).not.toContain(discardedA);
    expect(remaining).not.toContain(discardedB);
    expect(remaining).toContain(draftId);

    // The other user's discarded row is untouched.
    expect(
      (await app.inject({ method: "GET", url: `/imports/${otherImp.importId}`, headers: auth(other) }))
        .statusCode,
    ).toBe(200);
  });

  it("rejects bulk-clear with an empty id list (400)", async () => {
    const t = await token("bulk-clear-empty-user");
    const res = await app.inject({
      method: "POST",
      url: "/imports/bulk-clear",
      headers: auth(t),
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns existing draft import on re-upload of identical CSV", async () => {
    const t = await token("fingerprint-draft-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "FpDraft", baseCurrency: "IDR" },
      })
    ).json().id;

    const first = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(first.importId).toBeDefined();

    // Second upload of the same content → same importId, alreadyExists flag.
    const second = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(second.importId).toBe(first.importId);
    expect(second.alreadyExists).toBe(true);
    expect(second.alreadyConfirmed).toBeFalsy();

    // Only one row in the import list (per-user dedup prevents a second row).
    const list = await app.inject({ method: "GET", url: "/imports", headers: auth(t) });
    expect(list.json()).toHaveLength(1);
  });

  it("returns alreadyConfirmed when re-uploading a confirmed CSV", async () => {
    const t = await token("fingerprint-confirmed-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "FpConf", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp.drafts },
    });

    const second = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(second.importId).toBe(imp.importId);
    expect(second.alreadyConfirmed).toBe(true);
    expect(second.alreadyExists).toBeFalsy();
    expect(second.drafts).toHaveLength(0);
  });

  it("re-imports a confirmed CSV after its transactions were all deleted (#229)", async () => {
    const t = await token("redup-after-delete-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Redup", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp.drafts },
    });
    expect(confirm.statusCode).toBe(201);
    const ids = (confirm.json().transactions as Array<{ id: string }>).map((x) => x.id);
    expect(ids.length).toBeGreaterThan(0);

    // While the transactions still exist the file-level guard blocks the re-upload (as before).
    const blocked = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(blocked.alreadyConfirmed).toBe(true);
    expect(blocked.drafts).toHaveLength(0);

    // Delete every transaction the import created.
    const del = await app.inject({
      method: "POST",
      url: `/portfolios/${portfolioId}/transactions/bulk-delete`,
      headers: auth(t),
      payload: { ids },
    });
    expect(del.json().deleted).toBe(ids.length);

    // Re-upload now: the confirmed import is stale (no live rows) → a fresh draft, no block.
    const reImp = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(reImp.alreadyConfirmed).toBeFalsy();
    expect(reImp.drafts.length).toBeGreaterThan(0);
    expect(reImp.importId).not.toBe(imp.importId);

    // The stale confirmed import was superseded (marked discarded) so it won't re-block.
    const list = (await app.inject({ method: "GET", url: "/imports", headers: auth(t) })).json() as Array<{
      id: string;
      status: string;
    }>;
    expect(list.find((r) => r.id === imp.importId)?.status).toBe("discarded");
    expect(list.find((r) => r.id === reImp.importId)?.status).toBe("draft");
  });

  it("force-re-imports a confirmed CSV even when its transactions survive (#229)", async () => {
    const t = await token("force-reimport-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "ForceReimport", baseCurrency: "IDR" },
      })
    ).json().id;

    const imp = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp.drafts },
    });

    // No force → blocked even though it's the same file.
    const blocked = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(blocked.alreadyConfirmed).toBe(true);

    // force=true → fresh drafts despite the surviving transactions. Any economic
    // duplicate is re-surfaced at confirm time (acknowledgeDuplicates), not here.
    const forced = (
      await app.inject({
        method: "POST",
        url: `/imports/csv?force=true`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(forced.alreadyConfirmed).toBeFalsy();
    expect(forced.drafts.length).toBeGreaterThan(0);
    expect(forced.importId).not.toBe(imp.importId);
  });

  it("allows re-import after discarding (discarded imports do not block)", async () => {
    const t = await token("fingerprint-discard-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "FpDiscard", baseCurrency: "IDR" },
      })
    ).json().id;

    const first = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/imports/${first.importId}/discard`,
      headers: auth(t),
    });

    // Same content after discard → new import, no alreadyExists/alreadyConfirmed.
    const second = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(second.importId).not.toBe(first.importId);
    expect(second.alreadyExists).toBeFalsy();
    expect(second.alreadyConfirmed).toBeFalsy();
  });

  it("different CSV content creates a new import (hash is content-sensitive)", async () => {
    const t = await token("fingerprint-diff-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "FpDiff", baseCurrency: "IDR" },
      })
    ).json().id;

    const first = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();

    const CSV2 = `date,action,assetClass,ticker,name,quantity,unit,price,fees,currency\n2026-02-01,buy,equity,BMRI,Bank Mandiri,200,shares,6000,0,IDR`;
    const second = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV2 },
      })
    ).json();
    expect(second.importId).not.toBe(first.importId);
    expect(second.alreadyExists).toBeFalsy();
  });

  it("assigns deterministic content-hash externalIds to generic CSV drafts", async () => {
    const t = await token("hash-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "HashTest", baseCurrency: "IDR" },
      })
    ).json().id;

    // First parse.
    const imp1 = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    const id1 = imp1.drafts[0].externalId as string;
    expect(id1).toMatch(/^csv:[0-9a-f]+:0$/);

    // Second parse of the same content produces the same id.
    const imp2 = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(imp2.drafts[0].externalId).toBe(id1);
  });

  it("assigns distinct occ-suffixed ids to N identical rows in the same CSV", async () => {
    const t = await token("occ-user");
    const _portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "OccTest", baseCurrency: "IDR" },
      })
    ).json().id;

    // Three identical rows.
    const header = "date,action,assetClass,ticker,name,quantity,unit,price,fees,currency";
    const row = "2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR";
    const tripleCSV = `${header}\n${row}\n${row}\n${row}`;

    const imp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: tripleCSV },
      })
    ).json();

    const ids = imp.drafts.map((d: { externalId: string }) => d.externalId);
    expect(ids).toHaveLength(3);
    // All share the same hash prefix but differ by occ suffix.
    expect(ids[0]).toMatch(/:0$/);
    expect(ids[1]).toMatch(/:1$/);
    expect(ids[2]).toMatch(/:2$/);
    // Hash prefix is identical across all three.
    const prefix = (ids[0] as string).replace(/:0$/, "");
    expect(ids[1]).toBe(`${prefix}:1`);
    expect(ids[2]).toBe(`${prefix}:2`);
  });

  it("re-confirming the same CSV writes each transaction exactly once", async () => {
    const t = await token("dedup-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "DedupTest", baseCurrency: "IDR" },
      })
    ).json().id;

    // First import + confirm.
    const imp1 = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    const confirm1 = await app.inject({
      method: "POST",
      url: `/imports/${imp1.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp1.drafts },
    });
    expect(confirm1.json().confirmed).toBe(1);

    // Re-uploading the same CSV returns the confirmed import (file fingerprint),
    // preventing a duplicate draft from being created in the first place.
    const imp2 = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: CSV },
      })
    ).json();
    expect(imp2.alreadyConfirmed).toBe(true);
    expect(imp2.importId).toBe(imp1.importId);

    // Holdings unchanged — still one position.
    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(1);
  });

  it("partial-then-rest confirm writes each unique transaction exactly once", async () => {
    const t = await token("partial-dedup-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "PartialDedup", baseCurrency: "IDR" },
      })
    ).json().id;

    // Two different rows so we can confirm one then the other.
    const header = "date,action,assetClass,ticker,name,quantity,unit,price,fees,currency";
    const twoRowCSV = [
      header,
      "2026-01-15,buy,equity,BBCA,Bank Central Asia,100,shares,9500,0,IDR",
      "2026-01-16,buy,equity,BMRI,Bank Mandiri,200,shares,6000,0,IDR",
    ].join("\n");

    const imp = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: twoRowCSV },
      })
    ).json();

    // Confirm first draft only.
    const c1 = await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: [imp.drafts[0]] },
    });
    expect(c1.json().confirmed).toBe(1);

    // Re-use the same import to confirm the second draft.
    const c2 = await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: [imp.drafts[1]] },
    });
    expect(c2.json().confirmed).toBe(1);

    // After both drafts are confirmed the import is fully confirmed (409 on re-confirm).
    const c3 = await app.inject({
      method: "POST",
      url: `/imports/${imp.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: [imp.drafts[0]] },
    });
    expect(c3.statusCode).toBe(409);

    // Two distinct holdings (BBCA + BMRI).
    const holdings = await app.inject({
      method: "GET",
      url: `/portfolios/${portfolioId}/holdings`,
      headers: auth(t),
    });
    expect(holdings.json()).toHaveLength(2);
  });

  it("auto-detects and imports an IBKR Flex Trades CSV", async () => {
    const t = await token("ibkr-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "IBKR", baseCurrency: "USD" },
      })
    ).json().id;

    const ibkr = [
      "Symbol,DateTime,Quantity,TradePrice,IBCommission,CurrencyPrimary,AssetClass,Description,TradeID",
      'AAPL,"20260115;093000",10,190.50,-1.00,USD,STK,"APPLE INC",111',
      'TSLA,"20260116;100000",-5,250.00,-1.25,USD,STK,"TESLA INC",112',
    ].join("\n");

    const imp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: ibkr }, // format omitted → auto
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().drafts).toHaveLength(2);

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${imp.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: imp.json().drafts },
    });
    expect(confirm.statusCode).toBe(201);
    const txns = confirm.json().transactions as Array<{ type: string; source: string }>;
    expect(txns.map((x) => x.type).sort()).toEqual(["buy", "sell"]);
    expect(txns.every((x) => x.source === "csv")).toBe(true);
  });

  it("rejects confirming into another user's portfolio (ownership check at confirm)", async () => {
    const tA = await token("imp-a");
    const tB = await token("imp-b");
    const portfolioIdA = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(tA),
        payload: { name: "A" },
      })
    ).json().id;

    // User B can upload without a portfolio (uploads are now portfolio-agnostic).
    const imp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(tB),
      payload: { content: CSV },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();

    // But B cannot confirm into A's portfolio.
    const res = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(tB),
      payload: { portfolioId: portfolioIdA, transactions: drafts },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects confirm when no portfolioId in body and none stored on import (400)", async () => {
    const t = await token("no-pid-user");
    const imp = await app.inject({
      method: "POST",
      url: `/imports/csv`,
      headers: auth(t),
      payload: { content: CSV },
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    // No portfolioId in body, none stored (new-style upload).
    const res = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { transactions: drafts },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("portfolio_required");
  });

  it("same CSV uploaded to two different portfolios is deduped per-user (blocked)", async () => {
    const t = await token("cross-portfolio-dedup-user");
    const p1 = (
      await app.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P1" } })
    ).json().id;
    const p2 = (
      await app.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P2" } })
    ).json().id;

    // First upload — creates a draft.
    const first = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(first.importId).toBeDefined();

    // Second upload of the same content — blocked, returns same importId.
    const second = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(second.importId).toBe(first.importId);
    expect(second.alreadyExists).toBe(true);

    // Confirm first import into portfolio 1.
    await app.inject({
      method: "POST",
      url: `/imports/${first.importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: p1, transactions: first.drafts },
    });

    // Third upload of the same content — now blocked as already confirmed.
    const third = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(t), payload: { content: CSV } })
    ).json();
    expect(third.alreadyConfirmed).toBe(true);
    expect(third.importId).toBe(first.importId);

    // Different user — same content is NOT deduped against user 1.
    const other = await token("cross-portfolio-other");
    const otherImp = (
      await app.inject({ method: "POST", url: `/imports/csv`, headers: auth(other), payload: { content: CSV } })
    ).json();
    expect(otherImp.importId).not.toBe(first.importId);
    expect(otherImp.alreadyExists).toBeFalsy();

    void p2; // both portfolios were created
  });

  // IDX KIK ETF upgrade (#120): a CSV draft whose type is mutual_fund but whose ticker
  // matches the IDX ETF convention should be stored as etf, not mutual_fund.
  it("classifies an IDX KIK ETF ticker (XIIT) as etf even when the CSV row says mutual_fund", async () => {
    const t = await token("idx-etf-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "ETF Portfolio", baseCurrency: "IDR" },
      })
    ).json().id;

    const etfCsv = [
      "date,action,assetClass,ticker,name,quantity,unit,price,fees,currency",
      "2026-01-15,buy,mutual_fund,XIIT,Premier ETF IDX30,100,shares,1500,0,IDR",
    ].join("\n");

    const { importId, drafts } = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: etfCsv },
      })
    ).json();
    expect(drafts).toHaveLength(1);

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);

    // The stored instrument must be classed etf (not mutual_fund).
    const found = (
      await app.inject({
        method: "GET",
        url: `/instruments?q=XIIT`,
        headers: auth(t),
      })
    ).json() as { symbol: string; assetClass: string }[];
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].assetClass).toBe("etf");
  });

  it("keeps a genuine open-end reksa dana (non-ETF ticker) as mutual_fund after CSV confirm", async () => {
    const t = await token("idx-fund-user");
    const portfolioId = (
      await app.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Fund Portfolio", baseCurrency: "IDR" },
      })
    ).json().id;

    // SCHRODER is a fund code that doesn't match the X / R- pattern.
    const fundCsv = [
      "date,action,assetClass,ticker,name,quantity,unit,price,fees,currency",
      "2026-01-15,buy,mutual_fund,SCHRODER,Schroder Dana Prestasi,100,shares,20000,0,IDR",
    ].join("\n");

    const { importId, drafts } = (
      await app.inject({
        method: "POST",
        url: `/imports/csv`,
        headers: auth(t),
        payload: { content: fundCsv },
      })
    ).json();
    expect(drafts).toHaveLength(1);

    const confirm = await app.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);

    const found = (
      await app.inject({
        method: "GET",
        url: `/instruments?q=SCHRODER`,
        headers: auth(t),
      })
    ).json() as { symbol: string; assetClass: string }[];
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].assetClass).toBe("mutual_fund");
  });
});

describe("screenshot import → confirm flow", () => {
  let ssApp: App;
  let ssKey: CryptoKey;

  async function ssToken(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(ssKey);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    ssKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    ssApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([GOLD_DRAFT]),
    });
  });

  afterAll(async () => {
    await ssApp.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("parses a screenshot into a draft, confirms it, and records source=screenshot", async () => {
    const t = await ssToken("ss-user");
    const portfolioId = (
      await ssApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Gold", baseCurrency: "IDR" },
      })
    ).json().id;

    const form = screenshotPart(Buffer.from("fake-png"), "image/png", "fake.png");
    const imp = await ssApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts } = imp.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].assetClass).toBe("gold");

    const confirm = await ssApp.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, transactions: drafts },
    });
    expect(confirm.statusCode).toBe(201);
    expect(confirm.json().confirmed).toBe(1);
    expect(confirm.json().transactions[0].source).toBe("screenshot");
  });

  it("accepts a PDF document and rejects an unsupported media type", async () => {
    const t = await ssToken("ss-pdf-user");
    const _portfolioId = (
      await ssApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "PDF", baseCurrency: "IDR" },
      })
    ).json().id;

    const pdfForm = screenshotPart(Buffer.from("%PDF-1.4 fake"), "application/pdf", "stmt.pdf");
    const pdf = await ssApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...pdfForm.headers },
      payload: pdfForm.payload,
    });
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json().drafts).toHaveLength(1);

    const badForm = screenshotPart(Buffer.from("not-an-image"), "text/plain", "bad.txt");
    const bad = await ssApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...badForm.headers },
      payload: badForm.payload,
    });
    expect(bad.statusCode).toBe(415);
  });

  it("413s when the uploaded file exceeds the 25 MB limit", async () => {
    const t = await ssToken("ss-size-user");
    // Build a buffer just over the 25 MB limit (after form encoding).
    const bigBuf = Buffer.alloc(26 * 1024 * 1024, 0x41); // 26 MB of 'A'
    const form = screenshotPart(bigBuf, "image/png", "big.png");
    const res = await ssApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("file_too_large");
  });

  // NOTE: This test creates and closes its own app instance. Closing it fires the
  // dbPlugin.onClose hook → closeDb(), destroying the shared PGlite singleton. Any
  // subsequent test that uses ssApp (from beforeAll) will fail with "PGlite is closed".
  // Keep all ssApp-dependent tests ABOVE this one.
  it("503s when the configured parser has no key", async () => {
    const kp = await generateKeyPair("ES256");
    const inertApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([], false),
    });
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("ss-inert")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    const form503 = screenshotPart(Buffer.from("abc"), "image/png");
    const res = await inertApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...form503.headers },
      payload: form503.payload,
    });
    expect(res.statusCode).toBe(503);
    await inertApp.close();
  });

  it("502s with provider reason when the parser throws a vision error", async () => {
    const kp = await generateKeyPair("ES256");
    const failApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: {
        name: "mock-fail",
        isConfigured: () => true,
        parse: async () => {
          throw new Error("mock_fail_vision_error_429");
        },
      },
    });
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("ss-fail-user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    const form = screenshotPart(Buffer.from("fake"), "image/png");
    const res = await failApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...form.headers },
      payload: form.payload,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("screenshot_parse_failed");
    expect(res.json().reason).toBe("provider_error");
    expect(res.json().provider).toBe("mock-fail");
    expect(res.json().providerStatus).toBe(429);

    await failApp.close();
  });

  it("returns matchedPortfolioId when the parsed account number matches a portfolio", async () => {
    const kp = await generateKeyPair("ES256");
    const detectApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: {
        name: "mock-detect",
        isConfigured: () => true,
        parse: async () => ({
          drafts: [GOLD_DRAFT],
          contracts: [],
          accountNumber: "SID-12345678",
        }),
      },
    });
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("detect-user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    // Create two portfolios; only one has the matching account number.
    const pid1 = (
      await detectApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Matched", baseCurrency: "IDR", accountNumber: "SID12345678" },
      })
    ).json().id;
    await detectApp.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Other", baseCurrency: "IDR" },
    });

    const detectForm = screenshotPart(Buffer.from("detect-img"), "image/png", "detect.png");
    const res = await detectApp.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...detectForm.headers },
      payload: detectForm.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().matchedPortfolioId).toBe(pid1);

    await detectApp.close();
  });

  it("returns null matchedPortfolioId when no portfolio account number matches", async () => {
    const kp = await generateKeyPair("ES256");
    const noMatchApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: {
        name: "mock-no-match",
        isConfigured: () => true,
        parse: async () => ({
          drafts: [GOLD_DRAFT],
          contracts: [],
          accountNumber: "UNKNOWN9999",
        }),
      },
    });
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("no-match-user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    await noMatchApp.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Portfolio A", baseCurrency: "IDR", accountNumber: "SID11111111" },
    });

    const noMatchForm = screenshotPart(Buffer.from("no-match-img"), "image/png", "stmt.png");
    const res = await noMatchApp.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...noMatchForm.headers },
      payload: noMatchForm.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().matchedPortfolioId).toBeNull();

    await noMatchApp.close();
  });
});

describe("gold installment contract import → confirm → undo", () => {
  let gApp: App;
  let gKey: CryptoKey;

  // A future-dated contract: no installment is due yet, so the round-trip is
  // deterministic (0 repayments booked, liability == principal) regardless of the
  // wall clock. The repayment/now-dependent path is covered in gold-contract.test.ts.
  const CONTRACT = parsedGoldContractSchema.parse({
    provider: "GALERI24",
    contractNo: "TEST-CONTRACT-1",
    currency: "IDR",
    grams: "50",
    goldName: "LM 50 Gram",
    purchasePrice: "80243000",
    downPayment: "12036450",
    adminFee: "50000",
    discount: "1250000",
    principal: "68206550",
    marginTotal: "8858832",
    tenorMonths: 12,
    monthlyInstallment: "6422116",
    startDate: "2099-01-13",
    schedule: Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      dueDate: `2099-${String((i % 11) + 2).padStart(2, "0")}-13`,
      pokok: "5683880",
      sewaModal: "738236",
      angsuran: "6422116",
      sisaPokok: "0",
    })),
    confidence: 0.95,
  });

  async function gToken(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(gKey);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair("ES256");
    gKey = kp.privateKey;
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
    gApp = await buildApp({
      authKey: kp.publicKey,
      screenshotParser: mockParser([], true, [CONTRACT]),
    });
  });

  afterAll(async () => {
    await gApp.close();
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  it("parses a contract, confirms it to a gold holding + loan, then undoes it", async () => {
    const t = await gToken("gold-contract-user");
    const portfolioId = (
      await gApp.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Cicilan", baseCurrency: "IDR" },
      })
    ).json().id;

    const contractForm = screenshotPart(Buffer.from("fake-pdf"), "application/pdf", "contract.pdf");
    const imp = await gApp.inject({
      method: "POST",
      url: `/imports/screenshot`,
      headers: { ...auth(t), ...contractForm.headers },
      payload: contractForm.payload,
    });
    expect(imp.statusCode).toBe(201);
    const { importId, drafts, contracts } = imp.json();
    expect(drafts).toHaveLength(0);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].grams).toBe("50");

    // Confirm with the (user-reviewed) contract.
    const confirm = await gApp.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId, contracts },
    });
    expect(confirm.statusCode).toBe(201);
    // 4 booking legs (buy, drawdown, admin, discount); no installments due yet.
    expect(confirm.json().confirmed).toBe(4);

    const holdings = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/holdings`,
        headers: auth(t),
      })
    ).json();
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe("50");

    const summary = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    expect(summary.totalLiabilities).toBe("68206550");
    // Default (purchase_price) cost basis is the G24 purchase price.
    expect(summary.holdings[0].costBasis).toBe("80243000");

    // The cost-basis toggle moves only the holding's cost basis, never net worth.
    const totalPaid = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary?costBasis=total_paid`,
        headers: auth(t),
      })
    ).json();
    expect(totalPaid.netWorth).toBe(summary.netWorth);
    expect(totalPaid.totalLiabilities).toBe(summary.totalLiabilities);
    // financing to date = admin 50,000 − discount 1,250,000 (no installments due yet).
    expect(totalPaid.holdings[0].costBasis).toBe("79043000");

    // Undo removes the legs and the loan; liability and holdings return to zero.
    const undo = await gApp.inject({
      method: "DELETE",
      url: `/imports/${importId}`,
      headers: auth(t),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().removed).toBe(4);

    const afterHoldings = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/holdings`,
        headers: auth(t),
      })
    ).json();
    expect(afterHoldings).toHaveLength(0);

    const afterSummary = (
      await gApp.inject({
        method: "GET",
        url: `/portfolios/${portfolioId}/summary`,
        headers: auth(t),
      })
    ).json();
    expect(afterSummary.totalLiabilities).toBe("0");
  });
});

// ── #196 cross-format dedup + #197 account-mismatch ──────────────────────────
describe("import dedup + account mismatch (#196, #197)", () => {
  beforeAll(() => {
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  });

  afterAll(async () => {
    // The embedded PGlite db is a shared singleton; each test built+closed its own app
    // (closing the db). Reset it so a following describe re-initialises cleanly.
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  // Each test gets its own app + signing key. buildApp reuses the shared db singleton, but
  // closing one app closes that db — so every test builds fresh (getting an empty db) and
  // closes at the end, keeping the cases isolated.
  async function freshApp(parser?: ScreenshotParser) {
    const kp = await generateKeyPair("ES256");
    const a = await buildApp(parser ? { authKey: kp.publicKey, screenshotParser: parser } : { authKey: kp.publicKey });
    const mkTok = (sub: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(kp.privateKey);
    return { a, mkTok };
  }

  // The same Amazon trade as a vision draft (source="screenshot") and as a DKB depot
  // row (source="csv"). Identical economic fingerprint, different broker refs / source.
  const SAME_TRADE: ParsedTransaction = {
    assetClass: "equity",
    action: "buy",
    isin: "US0231351067",
    name: "Amazon",
    quantity: "5",
    unit: "shares",
    price: "81.37",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-06-15T00:00:00.000Z"),
    confidence: 1,
  };
  const DKB_DEPOT_ONE = [
    "Datum der Erstellung;Depotnummer;Wertpapierbezeichnung;WKN;ISIN;Einstiegskurs;Bewertungskurs;Stückzahl;Absoluter Gewinn;Relativer Gewinn;Assetklasse",
    '15.06.2026;506740786;"AMAZON.COM INC.    DL-,01";906866;US0231351067;"81,37 €";"210,10 €";5;"643,65 €";158.2%;Aktien',
  ].join("\n");

  it("flags a cross-source duplicate on the second import (screenshot → DKB CSV)", async () => {
    // A mock vision parser that returns the shared trade (source="screenshot").
    const { a, mkTok } = await freshApp({
      name: "mock-dup",
      isConfigured: () => true,
      parse: async () => ({ drafts: [SAME_TRADE], contracts: [] }),
    });
    const t = await mkTok("dup-user");

    // Single portfolio → it is the unambiguous candidate for upload-time flagging.
    const pid = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Solo", baseCurrency: "EUR" },
      })
    ).json().id;

    // 1) Import the trade as a screenshot and confirm it (source="screenshot").
    const up1 = screenshotPart(Buffer.from("amazon-screenshot"), "image/png");
    const r1 = await a.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...up1.headers },
      payload: up1.payload,
    });
    expect(r1.statusCode).toBe(201);
    const conf1 = await a.inject({
      method: "POST",
      url: `/imports/${r1.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: r1.json().drafts },
    });
    expect(conf1.statusCode).toBe(201);
    expect(conf1.json().confirmed).toBe(1);

    // 2) Import the SAME trade as a DKB CSV — it must be flagged as a likely duplicate.
    const r2 = await a.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: DKB_DEPOT_ONE, format: "dkb" },
    });
    expect(r2.statusCode).toBe(201);
    const dkbDraft = r2.json().drafts[0];
    expect(dkbDraft.likelyDuplicate).toBeTruthy();
    expect(dkbDraft.likelyDuplicate.source).toBe("screenshot");
    expect(dkbDraft.likelyDuplicate.executedAt.slice(0, 10)).toBe("2026-06-15");

    await a.close();
  });

  it("does NOT flag two legitimate identical same-day trades against an empty history", async () => {
    const { a, mkTok } = await freshApp();
    const t = await mkTok("fp-user");
    await a.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Empty", baseCurrency: "EUR" },
    });
    // Two identical depot rows; nothing committed yet → count-aware match flags zero.
    const twoRows = [
      "Datum der Erstellung;Depotnummer;Wertpapierbezeichnung;WKN;ISIN;Einstiegskurs;Bewertungskurs;Stückzahl;Absoluter Gewinn;Relativer Gewinn;Assetklasse",
      '15.06.2026;506740786;"AMAZON.COM INC.    DL-,01";906866;US0231351067;"81,37 €";"210,10 €";5;"643,65 €";158.2%;Aktien',
      '15.06.2026;506740786;"AMAZON.COM INC.    DL-,01";906866;US0231351067;"81,37 €";"210,10 €";5;"643,65 €";158.2%;Aktien',
    ].join("\n");
    const r = await a.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: twoRows, format: "dkb" },
    });
    expect(r.statusCode).toBe(201);
    const drafts = r.json().drafts;
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d: { likelyDuplicate?: unknown }) => !d.likelyDuplicate)).toBe(true);
    // …and both carry distinct externalIds so both would be written.
    expect(drafts[0].externalId).not.toBe(drafts[1].externalId);
    await a.close();
  });

  it("blocks confirm into a mismatched portfolio until acknowledged (#197)", async () => {
    const { a, mkTok } = await freshApp({
      name: "mock-acct",
      isConfigured: () => true,
      parse: async () => ({ drafts: [GOLD_DRAFT], contracts: [], accountNumber: "506740786" }),
    });
    const t = await mkTok("acct-user");

    const a1 = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Depot A", baseCurrency: "EUR", accountNumber: "506740786" },
      })
    ).json().id;
    const b = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Other B", baseCurrency: "EUR" },
      })
    ).json().id;

    const up = screenshotPart(Buffer.from("acct-doc"), "image/png");
    const r = await a.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...up.headers },
      payload: up.payload,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().matchedPortfolioId).toBe(a1); // routed to the matching depot
    const importId = r.json().importId;
    const drafts = r.json().drafts;

    // Confirm into the WRONG portfolio without acknowledging → 409 with the verdict.
    const blocked = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: b, transactions: drafts },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("account_mismatch");
    expect(blocked.json().kind).toBe("other_portfolio");
    expect(blocked.json().matchedPortfolioId).toBe(a1);

    // Acknowledge → it goes through.
    const forced = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: b, transactions: drafts, acknowledgeAccountMismatch: true },
    });
    expect(forced.statusCode).toBe(201);

    await a.close();
  });

  it("does not warn when the account matches, or when either side has no account number", async () => {
    // Parser returns NO account number → nothing to compare → never blocks.
    const { a, mkTok } = await freshApp({
      name: "mock-noacct",
      isConfigured: () => true,
      parse: async () => ({ drafts: [GOLD_DRAFT], contracts: [] }),
    });
    const t = await mkTok("noacct-user");

    const pid = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Has Account", baseCurrency: "EUR", accountNumber: "999999" },
      })
    ).json().id;
    const up = screenshotPart(Buffer.from("noacct-doc"), "image/png");
    const r = await a.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...up.headers },
      payload: up.payload,
    });
    expect(r.json().accountMismatch ?? null).toBeNull(); // file has no account number
    const confirmed = await a.inject({
      method: "POST",
      url: `/imports/${r.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: r.json().drafts },
    });
    expect(confirmed.statusCode).toBe(201); // no warning, no block

    await a.close();
  });

  // ── #217 cross-source dedup is a real backstop, not just advisory ──────────
  // Helper: commit DKB_DEPOT_ONE (the Amazon buy, source="csv") into a fresh solo portfolio,
  // then return an app whose vision parser yields `draft` so a screenshot of the "same" trade
  // can be confirmed and asserted on.
  async function committedCsvThenScreenshot(draft: ParsedTransaction, sub: string) {
    const { a, mkTok } = await freshApp({
      name: "mock-217",
      isConfigured: () => true,
      parse: async () => ({ drafts: [draft], contracts: [] }),
    });
    const t = await mkTok(sub);
    const pid = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Solo", baseCurrency: "EUR" },
      })
    ).json().id;
    // Commit the trade as a DKB CSV (source="csv").
    const csv = await a.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: DKB_DEPOT_ONE, format: "dkb" },
    });
    const conf = await a.inject({
      method: "POST",
      url: `/imports/${csv.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: csv.json().drafts },
    });
    expect(conf.json().confirmed).toBe(1);
    // Now import the screenshot draft.
    const up = screenshotPart(Buffer.from(`shot-${draft.action}-${String(draft.executedAt)}`), "image/png");
    const shot = await a.inject({
      method: "POST",
      url: "/imports/screenshot",
      headers: { ...auth(t), ...up.headers },
      payload: up.payload,
    });
    return { a, t, pid, importId: shot.json().importId as string, drafts: shot.json().drafts };
  }

  it("blocks a PDF/screenshot confirm of a trade already imported from CSV, until acknowledged", async () => {
    const { a, t, pid, importId, drafts } = await committedCsvThenScreenshot(SAME_TRADE, "dup217-csv");

    // Selecting the duplicated draft (i.e. the upload-time flag was missed or overridden)
    // must hit the backstop: a 409 listing the duplicate, NOT a silent double-write.
    const blocked = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: drafts },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("duplicate_transactions");
    expect(blocked.json().count).toBe(1);
    expect(blocked.json().duplicates[0].matchedSource).toBe("csv");

    // Acknowledging the override writes it through (the user consciously chose to).
    const forced = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: drafts, acknowledgeDuplicates: true },
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().confirmed).toBe(1);

    await a.close();
  });

  it("matches across the buy ↔ savings_plan action divergence", async () => {
    // The CSV records the savings-plan execution as a `buy`; the screenshot/PDF as
    // `savings_plan`. Same acquisition — the backstop must still catch it.
    const { a, t, pid, importId, drafts } = await committedCsvThenScreenshot(
      { ...SAME_TRADE, action: "savings_plan" },
      "dup217-sp",
    );
    const blocked = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: drafts },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("duplicate_transactions");

    await a.close();
  });

  it("matches across a ±1 day trade-vs-settlement date skew", async () => {
    // CSV trade date 2026-06-15; the screenshot carries the settlement date one day later.
    const { a, t, pid, importId, drafts } = await committedCsvThenScreenshot(
      { ...SAME_TRADE, executedAt: new Date("2026-06-16T00:00:00.000Z") },
      "dup217-day",
    );
    const blocked = await a.inject({
      method: "POST",
      url: `/imports/${importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: drafts },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("duplicate_transactions");

    await a.close();
  });

  it("does NOT block a same-source re-import that onConflictDoNothing already dedupes", async () => {
    // A second CSV file that *also* contains the already-committed Amazon row (plus a new
    // trade). The Amazon row has the same (source, content externalId) → silently skipped by
    // the unique index, so it must not raise a 409; only the genuinely new trade is written.
    const { a, mkTok } = await freshApp();
    const t = await mkTok("samesrc-user");
    const pid = (
      await a.inject({
        method: "POST",
        url: "/portfolios",
        headers: auth(t),
        payload: { name: "Solo", baseCurrency: "EUR" },
      })
    ).json().id;

    const csv1 = await a.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: DKB_DEPOT_ONE, format: "dkb" },
    });
    await a.inject({
      method: "POST",
      url: `/imports/${csv1.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: csv1.json().drafts },
    });

    // File B: the same Amazon row + a distinct Microsoft row → different file hash, but the
    // Amazon row reproduces the identical content externalId.
    const DKB_DEPOT_TWO = [
      "Datum der Erstellung;Depotnummer;Wertpapierbezeichnung;WKN;ISIN;Einstiegskurs;Bewertungskurs;Stückzahl;Absoluter Gewinn;Relativer Gewinn;Assetklasse",
      '15.06.2026;506740786;"AMAZON.COM INC.    DL-,01";906866;US0231351067;"81,37 €";"210,10 €";5;"643,65 €";158.2%;Aktien',
      '15.06.2026;506740786;"MICROSOFT CORP.";870747;US5949181045;"270,55 €";"300,00 €";1;"29,45 €";10.9%;Aktien',
    ].join("\n");
    const csv2 = await a.inject({
      method: "POST",
      url: "/imports/csv",
      headers: auth(t),
      payload: { content: DKB_DEPOT_TWO, format: "dkb" },
    });
    const conf2 = await a.inject({
      method: "POST",
      url: `/imports/${csv2.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: csv2.json().drafts },
    });
    // No 409: the overlapping Amazon row is a silent no-op, only Microsoft is written.
    expect(conf2.statusCode).toBe(201);
    expect(conf2.json().confirmed).toBe(1);

    await a.close();
  });
});

// ---------------------------------------------------------------------------
// #259 — enrichment vs duplicate preview and auto-enrich
// ---------------------------------------------------------------------------

import type { StorageProvider } from "../../src/storage/types.js";

/** In-memory storage provider (same pattern as imports-receipts.test.ts). */
function makeMemoryStorage(): StorageProvider {
  const data = new Map<string, Buffer>();
  return {
    put: async (key, body) => { data.set(key, body instanceof Buffer ? body : Buffer.from("bytes")); },
    getSignedUrl: async (key) => `https://fake/${key}`,
    delete: async (key) => { data.delete(key); },
    exists: async (key) => data.has(key),
    get: async (key) => data.get(key) ?? null,
    move: async (src, dest) => {
      const buf = data.get(src);
      if (buf) { data.set(dest, buf); data.delete(src); }
    },
    stats: async () => ({ objectCount: data.size, totalBytes: 0 }),
  };
}

describe("enrichment vs duplicate preview and auto-enrich (#259)", () => {
  beforeAll(() => {
    process.env.AUTHENTIK_ISSUER = ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  });

  afterAll(async () => {
    await closeDb();
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
  });

  async function freshApp259(opts?: { parser?: ScreenshotParser; storage?: StorageProvider }) {
    const kp = await generateKeyPair("ES256");
    const a = await buildApp({
      authKey: kp.publicKey,
      ...(opts?.parser ? { screenshotParser: opts.parser } : {}),
      ...(opts?.storage ? { storage: opts.storage } : {}),
    });
    const mkTok = (sub: string) =>
      new SignJWT({ email: `${sub}@test.example` })
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(kp.privateKey);
    return { a, mkTok };
  }

  // BCA trade as a mock screenshot draft — ticker must match the CSV's "BBCA" so the
  // confirm-path instrument lookup resolves to the same DB row (instrumentId-based dedup).
  const BCA_SCREENSHOT_DRAFT: ParsedTransaction = {
    assetClass: "equity",
    action: "buy",
    ticker: "BBCA",
    name: "Bank Central Asia",
    quantity: "100",
    unit: "shares",
    price: "9500",
    fees: "0",
    currency: "IDR",
    executedAt: new Date("2026-01-15T00:00:00.000Z"),
    confidence: 0.9,
  };

  // A second CSV with the same BCA trade but different file content (different hash).
  const CSV_DUP = [
    "date,action,assetClass,name,ticker,quantity,unit,price,fees,currency",
    "2026-01-15,buy,equity,Bank Central Asia,BBCA,100,shares,9500,0,IDR",
  ].join("\n");

  it("preview endpoint returns kind=duplicate for same-source CSV re-import", async () => {
    const { a, mkTok } = await freshApp259();
    const t = await mkTok("dup-preview-user");

    const pid = (await a.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P", baseCurrency: "IDR" } })).json().id;

    // Confirm the first CSV import.
    const r1 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV } });
    await a.inject({ method: "POST", url: `/imports/${r1.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r1.json().drafts } });

    // Import the same trade via a different CSV file (different hash).
    const r2 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV_DUP } });
    expect(r2.statusCode).toBe(201);
    const importId2 = r2.json().importId;

    // Preview: same csv source → duplicate.
    const preview = await a.inject({ method: "POST", url: `/imports/${importId2}/duplicates`, headers: auth(t), payload: { portfolioId: pid } });
    expect(preview.statusCode).toBe(200);
    const { annotations } = preview.json() as { annotations: Array<{ draftIndex: number; kind: string }> };
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe("duplicate");

    await a.close();
  });

  it("preview endpoint returns kind=enrichment for cross-source screenshot vs CSV tx", async () => {
    const storage = makeMemoryStorage();
    const { a, mkTok } = await freshApp259({
      parser: { name: "mock", isConfigured: () => true, parse: async () => ({ drafts: [BCA_SCREENSHOT_DRAFT], contracts: [] }) },
      storage,
    });
    const t = await mkTok("enrich-preview-user");

    const pid = (await a.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P", baseCurrency: "IDR" } })).json().id;

    // Confirm CSV import (source="csv").
    const r1 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV } });
    await a.inject({ method: "POST", url: `/imports/${r1.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r1.json().drafts } });

    // Upload a screenshot with the same trade.
    const form = screenshotPart(Buffer.from("fake-bca-screenshot"), "image/png", "bca.png");
    const r2 = await a.inject({ method: "POST", url: "/imports/screenshot", headers: { ...auth(t), ...form.headers }, payload: form.payload });
    expect(r2.statusCode).toBe(201);
    const importId2 = r2.json().importId;

    // Preview: screenshot vs csv → enrichment.
    const preview = await a.inject({ method: "POST", url: `/imports/${importId2}/duplicates`, headers: auth(t), payload: { portfolioId: pid } });
    expect(preview.statusCode).toBe(200);
    const { annotations } = preview.json() as { annotations: Array<{ draftIndex: number; kind: string; matchedTransactionId: string }> };
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe("enrichment");
    expect(annotations[0].matchedTransactionId).toBeTruthy();

    await a.close();
  });

  it("auto-enrich: confirming a screenshot that matches a CSV tx returns enriched=1 and no 409", async () => {
    const storage = makeMemoryStorage();
    const { a, mkTok } = await freshApp259({
      parser: { name: "mock", isConfigured: () => true, parse: async () => ({ drafts: [BCA_SCREENSHOT_DRAFT], contracts: [] }) },
      storage,
    });
    const t = await mkTok("auto-enrich-user");

    const pid = (await a.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P", baseCurrency: "IDR" } })).json().id;

    // Confirm CSV import first.
    const r1 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV } });
    const conf1 = await a.inject({ method: "POST", url: `/imports/${r1.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r1.json().drafts } });
    expect(conf1.statusCode).toBe(201);
    expect(conf1.json().confirmed).toBe(1);

    // Upload screenshot (same trade).
    const form = screenshotPart(Buffer.from("bca-screenshot-bytes"), "image/png", "bca2.png");
    const r2 = await a.inject({ method: "POST", url: "/imports/screenshot", headers: { ...auth(t), ...form.headers }, payload: form.payload });
    expect(r2.statusCode).toBe(201);
    const { importId: impId2, drafts: drafts2 } = r2.json();

    // Confirm screenshot — should auto-enrich, not 409.
    const conf2 = await a.inject({ method: "POST", url: `/imports/${impId2}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: drafts2 } });
    expect(conf2.statusCode).toBe(201);
    const body = conf2.json() as { confirmed: number; enriched: number };
    expect(body.confirmed).toBe(0); // not a new tx
    expect(body.enriched).toBe(1);  // enriched the existing one

    // Holdings count is still 1 (no duplicate tx created).
    const holdings = await a.inject({ method: "GET", url: `/portfolios/${pid}/holdings`, headers: auth(t) });
    expect(holdings.json()).toHaveLength(1);

    await a.close();
  });

  it("plain same-source CSV re-import is silently absorbed (skipped, no 409)", async () => {
    // Same source (csv) + same content → assignContentExternalIds produces the same hash,
    // so committedExtKeys filters the match before classification. The insert no-ops via
    // onConflictDoNothing. No 409 — same-source re-imports are handled quietly.
    const { a, mkTok } = await freshApp259();
    const t = await mkTok("plain-dup-user");

    const pid = (await a.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P", baseCurrency: "IDR" } })).json().id;

    const r1 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV } });
    await a.inject({ method: "POST", url: `/imports/${r1.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r1.json().drafts } });

    // Second import with same trade, different file content → different hash, new import record.
    const r2 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV_DUP } });
    expect(r2.statusCode).toBe(201);

    const conf2 = await a.inject({ method: "POST", url: `/imports/${r2.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r2.json().drafts } });
    // 201 not 409: same-source + same content → onConflictDoNothing, skipped=1.
    expect(conf2.statusCode).toBe(201);
    expect(conf2.json().skipped).toBe(1);

    // Holdings still has exactly 1 row (no duplicate tx created).
    const holdings = await a.inject({ method: "GET", url: `/portfolios/${pid}/holdings`, headers: auth(t) });
    expect(holdings.json()).toHaveLength(1);

    await a.close();
  });

  it("acknowledging duplicate bypasses 409 and writes the transaction", async () => {
    const { a, mkTok } = await freshApp259();
    const t = await mkTok("ack-dup-user");

    const pid = (await a.inject({ method: "POST", url: "/portfolios", headers: auth(t), payload: { name: "P", baseCurrency: "IDR" } })).json().id;

    const r1 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV } });
    await a.inject({ method: "POST", url: `/imports/${r1.json().importId}/confirm`, headers: auth(t), payload: { portfolioId: pid, transactions: r1.json().drafts } });

    const r2 = await a.inject({ method: "POST", url: "/imports/csv", headers: auth(t), payload: { content: CSV_DUP } });
    const conf2 = await a.inject({
      method: "POST",
      url: `/imports/${r2.json().importId}/confirm`,
      headers: auth(t),
      payload: { portfolioId: pid, transactions: r2.json().drafts, acknowledgeDuplicates: true },
    });
    expect(conf2.statusCode).toBe(201);

    await a.close();
  });
});
