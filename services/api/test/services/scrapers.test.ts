import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { extractBuybackFromHtml } from "../../src/services/scrapers/antam-buyback.js";
import { extractBuybackFromHtml as extractGaleri24Buyback } from "../../src/services/scrapers/galeri24-buyback.js";
import { decryptBibitEnvelope, refreshBibitNav } from "../../src/services/scrapers/bibit-nav.js";
import {
  upsertScrapedQuote,
  getScrapedQuote,
  refreshAntamBuyback,
  refreshGaleri24Buyback,
  refreshNav,
  ANTAM_BUYBACK_KEY,
  GALERI24_BUYBACK_KEY,
  navKey,
} from "../../src/services/scrapers/store.js";

// A trimmed real-structure snapshot of galeri24.co.id/harga-emas (Nuxt CSS-grid, no tables).
const GALERI24_HTML = readFileSync(
  new URL("../fixtures/galeri24-harga-emas.html", import.meta.url),
  "utf-8",
);

// Minimal fetch stub: a responder maps a URL to { ok?, body } (text or json).
function mockFetch(
  responder: (url: string) => { ok?: boolean; text?: string; json?: unknown },
): typeof fetch {
  return (async (url: string) => {
    const { ok = true, text, json } = responder(String(url));
    return {
      ok,
      status: ok ? 200 : 500,
      text: async () => text ?? "",
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
}

// Encrypt a payload into the same self-describing envelope Bibit returns:
// iv(hex) + ciphertext(hex) + key(utf8, 32 chars).
function encryptBibitEnvelope(payload: unknown): string {
  const key = "0123456789abcdef0123456789abcdef"; // 32 chars → AES-256 key
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  return iv.toString("hex") + ct.toString("hex") + key;
}

// Mirrors the live harga-emas.org markup (interleaved HTML comments included).
const HARGA_EMAS_HTML = `<html><body>
  <td><div><span>Update harga LM Antam: <!-- -->16 Juni 2026 pukul 17.01</span>
  <span>Harga pembelian kembali: <!-- -->Rp2.591.100<!-- --> <!-- -->/grm</span></div></td>
</body></html>`;

describe("extractBuybackFromHtml", () => {
  it("reads the per-gram buyback after the label, stripping separators", () => {
    expect(extractBuybackFromHtml(HARGA_EMAS_HTML)).toBe(2591100);
  });

  it("returns null when the label/number is absent", () => {
    expect(extractBuybackFromHtml("<html><body>no price here</body></html>")).toBeNull();
  });
});

describe("galeri24 extractBuybackFromHtml", () => {
  it("reads the 1g buyback from the GALERI 24 section, not other brands", () => {
    // The fixture's decoy BABY GALERI 24 section has a 1g buyback of 9999999.
    expect(extractGaleri24Buyback(GALERI24_HTML)).toBe(2549000);
  });

  it("returns null when the GALERI 24 section is missing", () => {
    expect(extractGaleri24Buyback('<html><body><div id="ANTAM">…</div></body></html>')).toBeNull();
  });

  it("returns null when the section has no 1g row (layout change)", () => {
    const noOneGram = GALERI24_HTML.replace(
      /<div class="p-3 col-span-1 whitespace-nowrap w-fit">1<\/div>/,
      '<div class="p-3 col-span-1 whitespace-nowrap w-fit">1.5</div>',
    );
    expect(extractGaleri24Buyback(noOneGram)).toBeNull();
  });
});

describe("decryptBibitEnvelope / refreshBibitNav", () => {
  it("decrypts the self-describing envelope round-trip", () => {
    const env = encryptBibitEnvelope([{ symbol: "RD1", nav: { value: 1.5 } }]);
    expect(decryptBibitEnvelope(env)).toEqual([{ symbol: "RD1", nav: { value: 1.5 } }]);
  });

  it("builds a symbol→nav map, skipping funds without a usable symbol/nav", async () => {
    const funds = [
      { symbol: "RD4196", name: "A", nav: { value: 1000.1 } },
      { symbol: "RD1349", name: "B", nav: { value: 1232.46 } },
      { symbol: "RDX", name: "no nav", nav: null },
      { name: "no symbol", nav: { value: 5 } },
    ];
    const fetchStub = mockFetch(() => ({ json: { data: encryptBibitEnvelope(funds) } }));
    const map = await refreshBibitNav(fetchStub);
    expect(map.get("RD4196")).toBe(1000.1);
    expect(map.get("RD1349")).toBe(1232.46);
    expect(map.has("RDX")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("returns an empty map when the source is unreachable", async () => {
    const map = await refreshBibitNav(mockFetch(() => ({ ok: false })));
    expect(map.size).toBe(0);
  });
});

describe("scraped_quotes store", () => {
  beforeAll(async () => {
    await ensureDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("upserts and reads back a value", async () => {
    const db = getDb();
    await upsertScrapedQuote(db, "k1", 123.45, "test");
    expect(await getScrapedQuote(db, "k1")).toBe(123.45);
    await upsertScrapedQuote(db, "k1", 678.9, "test"); // overwrite
    expect(await getScrapedQuote(db, "k1")).toBe(678.9);
    expect(await getScrapedQuote(db, "missing")).toBeNull();
  });

  it("refreshAntamBuyback scrapes and caches the buyback", async () => {
    const db = getDb();
    const value = await refreshAntamBuyback(
      db,
      mockFetch(() => ({ text: HARGA_EMAS_HTML })),
    );
    expect(value).toBe(2591100);
    expect(await getScrapedQuote(db, ANTAM_BUYBACK_KEY)).toBe(2591100);
  });

  it("refreshAntamBuyback caches nothing on failure", async () => {
    const db = getDb();
    const value = await refreshAntamBuyback(
      db,
      mockFetch(() => ({ ok: false })),
    );
    expect(value).toBeNull();
  });

  it("refreshGaleri24Buyback scrapes and caches the buyback", async () => {
    const db = getDb();
    const value = await refreshGaleri24Buyback(
      db,
      mockFetch(() => ({ text: GALERI24_HTML })),
    );
    expect(value).toBe(2549000);
    expect(await getScrapedQuote(db, GALERI24_BUYBACK_KEY)).toBe(2549000);
  });

  it("refreshGaleri24Buyback caches nothing on failure", async () => {
    const db = getDb();
    const value = await refreshGaleri24Buyback(
      db,
      mockFetch(() => ({ ok: false })),
    );
    expect(value).toBeNull();
  });

  it("refreshNav scrapes the catalogue and caches each fund's nav", async () => {
    const db = getDb();
    const funds = [
      { symbol: "RDPU", nav: { value: 1234.56 } },
      { symbol: "RD4196", nav: { value: 1000.1 } },
    ];
    const count = await refreshNav(
      db,
      mockFetch(() => ({ json: { data: encryptBibitEnvelope(funds) } })),
    );
    expect(count).toBe(2);
    expect(await getScrapedQuote(db, navKey("RDPU"))).toBe(1234.56);
    expect(await getScrapedQuote(db, navKey("RD4196"))).toBe(1000.1);
  });
});
