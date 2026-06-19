import { createHash } from "node:crypto";
import type { InstrumentSearchResult } from "@portfolio/market-data";

export interface BorseFrankfurtOptions {
  fetch?: typeof fetch;
  /** Injected for testing. Skips homepage salt scrape. */
  salt?: string;
}

/**
 * Börse Frankfurt on-demand enrichment. Returns ISIN + WKN + ticker together —
 * the only free source that does so. NOT on the live typeahead; used only via an
 * explicit "Look up on Börse Frankfurt" action on the create/edit-instrument form.
 *
 * Request signing (reverse-engineered from joqueka/bf4py):
 *   client-date      = UTC ISO ms + "Z"
 *   x-client-traceid = md5(client-date + url + salt)
 *   x-security       = md5(local YYYYMMDDHHMM)
 * Salt is scraped from main.*.js on www.boerse-frankfurt.de and cached;
 * re-scraped once on 401. Inject `salt` in tests to skip the scrape.
 */
export class BorseFrankfurtProvider {
  private readonly doFetch: typeof fetch;
  private readonly injectedSalt?: string;
  private cachedSalt: string | null = null;

  private static readonly SEARCH_BASE = "https://api.boerse-frankfurt.de/v1/search/";
  private static readonly HOMEPAGE = "https://www.boerse-frankfurt.de/";

  constructor(opts: BorseFrankfurtOptions = {}) {
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.injectedSalt = opts.salt;
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    const url = `${BorseFrankfurtProvider.SEARCH_BASE}equity_search`;
    const body = JSON.stringify({ searchTerms: query, limit: 10, offset: 0, types: [] });
    const res = await this.signedPost(url, body, true);
    if (!res) return [];

    const data = (await res.json()) as {
      data?: { name?: string; isin?: string; wkn?: string; slug?: string }[];
    };
    return (data.data ?? []).flatMap((e) => {
      if (!e.isin && !e.wkn) return [];
      return [
        {
          symbol: e.slug ?? e.isin ?? e.wkn ?? query,
          name: e.name ?? query,
          market: "XETRA",
          assetClass: "equity" as const,
          currency: "EUR",
          isin: e.isin,
          wkn: e.wkn,
          source: "borse-frankfurt",
        },
      ];
    });
  }

  private md5(input: string): string {
    return createHash("md5").update(input).digest("hex");
  }

  private async getSalt(): Promise<string> {
    if (this.injectedSalt !== undefined) return this.injectedSalt;
    if (this.cachedSalt !== null) return this.cachedSalt;
    try {
      const html = await this.doFetch(BorseFrankfurtProvider.HOMEPAGE).then((r) => r.text());
      const jsMatch = html.match(/src="(\/[^"]*main\.[^"]*\.js)"/);
      if (!jsMatch) { this.cachedSalt = ""; return ""; }
      const jsUrl = `${BorseFrankfurtProvider.HOMEPAGE}${jsMatch[1].replace(/^\//, "")}`;
      const js = await this.doFetch(jsUrl).then((r) => r.text());
      const saltMatch = js.match(/salt:"(\w+)"/);
      this.cachedSalt = saltMatch?.[1] ?? "";
    } catch {
      this.cachedSalt = "";
    }
    return this.cachedSalt ?? "";
  }

  private buildXSecurity(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      String(now.getFullYear()) +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes());
    return this.md5(ts);
  }

  private async signHeaders(urlForSigning: string): Promise<Record<string, string>> {
    const salt = await this.getSalt();
    const clientDate = new Date().toISOString().replace(/(\.\d{3})Z$/, "$1Z");
    const traceId = this.md5(clientDate + urlForSigning + salt);
    return {
      "client-date": clientDate,
      "x-client-traceid": traceId,
      "x-security": this.buildXSecurity(),
      "content-type": "application/json",
      authority: "api.boerse-frankfurt.de",
      origin: "https://www.boerse-frankfurt.de",
      referer: "https://www.boerse-frankfurt.de/",
    };
  }

  private async signedPost(
    url: string,
    body: string,
    retryOnFail = false,
  ): Promise<Response | null> {
    const headers = await this.signHeaders(url);
    const res = await this.doFetch(url, { method: "POST", headers, body });
    if (res.ok) return res;
    if (retryOnFail && res.status === 401) {
      this.cachedSalt = null;
      const headers2 = await this.signHeaders(url);
      const res2 = await this.doFetch(url, { method: "POST", headers: headers2, body });
      return res2.ok ? res2 : null;
    }
    return null;
  }
}
