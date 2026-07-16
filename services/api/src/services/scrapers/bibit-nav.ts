import crypto from "node:crypto";

/**
 * Scraper for Indonesian reksa-dana (mutual fund) NAV — IDR per unit — from Bibit (#110).
 * Writes into `scraped_quotes`, read in-process by the default NAV provider (or via the
 * authenticated `/internal/nav/:symbol` route for an external URL override).
 *
 * There is no clean per-fund API. Bibit's own catalogue endpoint, `products/list`, returns
 * an AES-CBC-encrypted envelope whose key/IV are embedded in the payload (scheme cribbed
 * from the community `risan/bibit-reksadana` proxy): the first 32 hex chars are the IV, the
 * last 32 chars are the UTF-8 AES-256 key, and the middle is the hex ciphertext. We page the
 * whole catalogue once per refresh, decrypt, and build a `symbol -> nav` map.
 *
 * The canonical fund symbol is Bibit's `symbol` field (e.g. "RD4196"); store that on the
 * `mutual_fund` instrument so lookups resolve. Per-unit NAV is `nav.value`. Unofficial and
 * encrypted, so any failure yields a partial/empty map and the provider falls through.
 */
const BIBIT_LIST_URL = "https://api.bibit.id/products/list";
export const BIBIT_SOURCE = "bibit";

// Bibit rejects obvious bots; mirror the headers the community proxy uses.
const BIBIT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:47.0) Gecko/20100101 Firefox/47.0",
  Origin: "https://bibit.id",
};

// Page size and a hard page cap (~5k funds) so a paging bug can't loop forever; Bibit's
// catalogue is a few hundred funds, so this is comfortably above the real count.
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

interface BibitFund {
  symbol?: string;
  nav?: { value?: number } | null;
}

/** Decrypt one `products/list` envelope. Throws on a malformed payload / bad key. */
export function decryptBibitEnvelope(envelope: string): unknown {
  const iv = Buffer.from(envelope.slice(0, 32), "hex");
  const key = Buffer.from(envelope.slice(-32), "utf8");
  const ciphertext = Buffer.from(envelope.slice(32, -32), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

async function fetchPage(doFetch: typeof fetch, page: number): Promise<BibitFund[]> {
  const url = `${BIBIT_LIST_URL}?page=${page}&limit=${PAGE_LIMIT}&sort=asc&sort_by=7`;
  const res = await doFetch(url, { headers: BIBIT_HEADERS });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: unknown };
  if (typeof body.data !== "string") return [];
  const decoded = decryptBibitEnvelope(body.data);
  return Array.isArray(decoded) ? (decoded as BibitFund[]) : [];
}

/**
 * Page the full Bibit catalogue and return a `fund symbol -> per-unit NAV` map. A network
 * or decrypt failure mid-paging returns whatever was collected so far (possibly empty); the
 * caller upserts what it gets and the provider falls through for anything missing.
 */
export async function refreshBibitNav(
  doFetch: typeof fetch = globalThis.fetch,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const funds = await fetchPage(doFetch, page);
      for (const f of funds) {
        const nav = f.nav?.value;
        if (f.symbol && typeof nav === "number" && Number.isFinite(nav) && nav > 0) {
          out.set(f.symbol, nav);
        }
      }
      if (funds.length < PAGE_LIMIT) break; // last page
    }
  } catch {
    // Return the partial map; the chain degrades gracefully.
  }
  return out;
}
