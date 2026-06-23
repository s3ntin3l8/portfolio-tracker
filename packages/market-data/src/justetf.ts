import type {
  AssetClass,
  InstrumentProfile,
  InstrumentRef,
  MarketDataProvider,
  Quote,
} from "./types.js";

/**
 * JustETF provider for European ETF country allocation.
 * Scrapes JustETF website for country allocation data.
 *
 * Only supports European UCITS ETFs with ISIN codes.
 * Rate limited to 1 request per second.
 */
export class JustEtfProvider implements MarketDataProvider {
  readonly name = "justetf";

  private lastRequestTime = 0;
  private readonly minRequestIntervalMs = 1000; // 1 req/sec

  /**
   * Supports ETFs. The actual ISIN check happens in getProfile.
   */
  supports(_assetClass: AssetClass, _market: string): boolean {
    return _assetClass === "etf";
  }

  /**
   * JustETF doesn't provide quotes - only country allocation data.
   */
  async getQuote(_ref: InstrumentRef): Promise<Quote | null> {
    return null;
  }

  /**
   * Fetch country allocation from JustETF AJAX endpoint.
   * Returns countryWeights map (country name → fraction 0–1).
   */
  async getProfile(ref: InstrumentRef): Promise<InstrumentProfile | null> {
    if (!ref.isin || !this.isValidIsin(ref.isin)) return null;

    try {
      const countries = await this.fetchCountryAllocation(ref.isin);
      if (!countries || Object.keys(countries).length === 0) return null;

      return { countryWeights: countries };
    } catch (err) {
      console.warn(`[justetf] failed to fetch country allocation for ${ref.isin}:`, err);
      return null;
    }
  }

  /**
   * Validate ISIN format (12 characters, uppercase).
   */
  private isValidIsin(isin: string): boolean {
    return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin.trim().toUpperCase());
  }

  /**
   * Rate limit: ensure at least 1 second between requests.
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestIntervalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minRequestIntervalMs - timeSinceLastRequest),
      );
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch country allocation from JustETF AJAX endpoint.
   * Returns country name → fraction (0–1) map.
   *
   * JustETF requires a session cookie (JSESSIONID) from a prior page visit
   * before the AJAX endpoint will return data (otherwise 301 redirect).
   * Two-step approach: fetch profile page for cookies, then AJAX for data.
   */
  private async fetchCountryAllocation(isin: string): Promise<Record<string, number> | null> {
    const userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

    // Step 1: fetch profile page to establish session cookies
    await this.rateLimit();
    const profileUrl = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
    const profileResp = await fetch(profileUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!profileResp.ok) return null;

    const cookies = profileResp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    if (!cookies) return null;

    // Step 2: fetch country allocation via AJAX with session cookies
    await this.rateLimit();
    const ajaxUrl = `https://www.justetf.com/en/etf-profile.html?0-1.0-holdingsSection-countries-loadMoreCountries&isin=${isin}&_wicket=1`;

    const response = await fetch(ajaxUrl, {
      headers: {
        "User-Agent": userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "Wicket-Ajax": "true",
        "Wicket-Ajax-BaseURL": `en/etf-profile.html?isin=${isin}`,
        Accept: "application/xml, text/xml, */*; q=0.01",
        Cookie: cookies,
      },
    });

    if (!response.ok) return null;

    const xml = await response.text();
    return this.parseCountryXml(xml);
  }

  /**
   * Parse JustETF XML response to extract country weights.
   */
  private parseCountryXml(xml: string): Record<string, number> | null {
    const countries: Record<string, number> = {};

    // Match country rows: name and percentage
    // The XML contains rows like:
    // <td data-testid="tl_etf-holdings_countries_value_name">Germany</td>
    // <td data-testid="tl_etf-holdings_countries_value_percentage">39.05%</td>
    const rowRegex =
      /data-testid="etf-holdings_countries_row"[\s\S]*?data-testid="tl_etf-holdings_countries_value_name">([^<]+)<[\s\S]*?data-testid="tl_etf-holdings_countries_value_percentage">([^<]+)</g;

    let match;
    while ((match = rowRegex.exec(xml)) !== null) {
      const name = match[1].trim();
      const pctStr = match[2].trim().replace("%", "");
      const pct = parseFloat(pctStr);

      if (name && !isNaN(pct)) {
        countries[name] = pct / 100; // Convert percentage to fraction
      }
    }

    return Object.keys(countries).length > 0 ? countries : null;
  }
}
