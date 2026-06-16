// A desktop browser UA + language headers shared by the gold/NAV scrapers: aggregators
// (and the official Antam / Galeri24 pages) reject obvious bots, so present like a real
// browser with an Indonesian-first Accept-Language.
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "id,en;q=0.8",
};
