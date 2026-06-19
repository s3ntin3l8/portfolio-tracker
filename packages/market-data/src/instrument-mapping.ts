import { CRYPTO_MARKET } from "./coingecko.js";
import type { AssetClass } from "./types.js";

/** Our internal market + the currency instruments on it trade in. */
export interface MarketInfo {
  market: string;
  currency: string;
}

/**
 * Map a provider's exchange identifier (TwelveData `exchange`/`mic_code`, Yahoo
 * `exchange`, OpenFIGI `exchCode`) to our internal market + its trading currency.
 * Indonesia (the primary market) is covered exhaustively; common US/EU venues are
 * included for ISIN lookups. Returns `undefined` for anything unrecognised so callers
 * can fall back to the provider's own currency or skip the result.
 */
const EXCHANGE_MAP: Record<string, MarketInfo> = {
  // Indonesia — IDX (IDR). TwelveData: IDX/XIDX; Yahoo: JKT; OpenFIGI: IJ.
  IDX: { market: "IDX", currency: "IDR" },
  XIDX: { market: "IDX", currency: "IDR" },
  JK: { market: "IDX", currency: "IDR" },
  JKT: { market: "IDX", currency: "IDR" },
  IJ: { market: "IDX", currency: "IDR" },
  JAKARTA: { market: "IDX", currency: "IDR" },
  // United States (USD).
  US: { market: "US", currency: "USD" },
  USA: { market: "US", currency: "USD" },
  NASDAQ: { market: "US", currency: "USD" },
  XNAS: { market: "US", currency: "USD" },
  NMS: { market: "US", currency: "USD" },
  NGM: { market: "US", currency: "USD" },
  NCM: { market: "US", currency: "USD" },
  NYSE: { market: "US", currency: "USD" },
  XNYS: { market: "US", currency: "USD" },
  NYQ: { market: "US", currency: "USD" },
  PCX: { market: "US", currency: "USD" },
  UN: { market: "US", currency: "USD" },
  UW: { market: "US", currency: "USD" },
  UQ: { market: "US", currency: "USD" },
  // Germany / Xetra (EUR).
  XETR: { market: "XETRA", currency: "EUR" },
  XETRA: { market: "XETRA", currency: "EUR" },
  GER: { market: "XETRA", currency: "EUR" },
  GR: { market: "XETRA", currency: "EUR" },
  GY: { market: "XETRA", currency: "EUR" },
  FRA: { market: "XETRA", currency: "EUR" },
  // Other EU/EEA venues. Yahoo prices these in their local currency, and a UCITS ETF or
  // EU equity ISIN frequently cross-lists here (e.g. a fund's Stuttgart or Euronext line).
  // Mapping the currency lets ISIN resolution prefer the listing that matches the holding's
  // currency and reject wrong-currency cross-listings — notably a USD London (LSE) line for
  // a EUR holding. LSE is deliberately left unmapped: its listings mix USD/GBP/GBp, so we
  // can't pin a reliable currency, and leaving it unmapped keeps it out of EUR resolution.
  AMS: { market: "AMS", currency: "EUR" }, // Euronext Amsterdam
  PAR: { market: "PAR", currency: "EUR" }, // Euronext Paris
  MIL: { market: "MIL", currency: "EUR" }, // Borsa Italiana (Milan)
  MCE: { market: "MCE", currency: "EUR" }, // BME (Madrid)
  STU: { market: "STU", currency: "EUR" }, // Börse Stuttgart
  EBS: { market: "SWX", currency: "CHF" }, // SIX Swiss Exchange
  // Singapore (SGD).
  SGX: { market: "SGX", currency: "SGD" },
  XSES: { market: "SGX", currency: "SGD" },
  SES: { market: "SGX", currency: "SGD" },
  SI: { market: "SGX", currency: "SGD" },
};

export function mapExchange(exchange: string | undefined | null): MarketInfo | undefined {
  if (!exchange) return undefined;
  return EXCHANGE_MAP[exchange.trim().toUpperCase()];
}

/**
 * Internal markets whose instruments a price provider can quote directly *and* that differ
 * from the EU-broker default (Xetra/EUR). When ISIN resolution at import lands on one of
 * these, the resolved market/currency should override the broker's Xetra/EUR pin: a US stock
 * or a crypto held on Trade Republic is bought in EUR but priced on its real venue (US in USD
 * via Twelve Data; crypto in EUR via CoinGecko). EU venues are deliberately absent — PR #130
 * keeps real EUR funds pinned to Xetra, where the broker executes them.
 */
export const PRICEABLE_FOREIGN_MARKETS: ReadonlySet<string> = new Set(["US", CRYPTO_MARKET]);

/**
 * Trade Republic books crypto under synthetic ISINs (`XF000<TICKER>…`, e.g. `XF000BTC0017`,
 * `XF000ETH0019`) that no ISIN registry — including OpenFIGI — resolves. Recognise the format
 * and extract the embedded ticker so the holding routes to CoinGecko, which resolves a ticker
 * → coin id (`BTC` → `bitcoin`). Returns `undefined` for any non-crypto ISIN.
 */
const TR_CRYPTO_ISIN = /^XF000([A-Z]{2,5})\d+$/;

/** Override only when CoinGecko's market-cap-ranked ticker search picks the wrong coin. */
const TR_CRYPTO_SYMBOL_OVERRIDES: Record<string, string> = {};

export function resolveCryptoIsin(
  isin: string | undefined | null,
): { symbol: string; market: string; assetClass: AssetClass } | undefined {
  const match = TR_CRYPTO_ISIN.exec((isin ?? "").trim().toUpperCase());
  if (!match) return undefined;
  const ticker = match[1];
  return {
    symbol: TR_CRYPTO_SYMBOL_OVERRIDES[ticker] ?? ticker,
    market: CRYPTO_MARKET,
    assetClass: "crypto",
  };
}

/**
 * Yahoo Finance ticker suffix per internal market (e.g. `BBCA` → `BBCA.JK` on IDX,
 * `AEMD` → `AEMD.DE` on Xetra). Markets absent here use the bare symbol.
 */
const MARKET_YAHOO_SUFFIX: Record<string, string> = {
  IDX: ".JK",
  XETRA: ".DE",
};

export function yahooSuffixForMarket(market: string): string | undefined {
  return MARKET_YAHOO_SUFFIX[market];
}

/**
 * EODHD exchange code per internal market — EODHD tickers are `<code>.<exchange>`
 * (e.g. `AEMD.XETRA`, `AAPL.US`). Markets absent here aren't priced by EODHD.
 */
const MARKET_EODHD_EXCHANGE: Record<string, string> = {
  XETRA: "XETRA",
  US: "US",
};

export function eodhdExchangeForMarket(market: string): string | undefined {
  return MARKET_EODHD_EXCHANGE[market];
}

/**
 * IDX KIK ETFs (exchange-traded reksa dana) carry a "Reksa Dana" type with no ETF token,
 * but their tickers follow IDX's ETF convention: an "R-" prefix (e.g. R-LQ45X) or an
 * "X"-prefixed 4-char code (XIIT, XIJI, XIIC, XISC, XNVE). Open-end reksa dana are
 * NAV-keyed by fund code/name and never carry an IDX exchange ticker, so this predicate
 * stays clear of them. Encodes Premier/IPIM's convention — an ETF from an issuer not
 * following it would be missed (a known-symbol list would be more precise but
 * higher-maintenance).
 */
export function isIdxEtfSymbol(symbol: string | undefined | null): boolean {
  const s = (symbol ?? "").trim().toUpperCase();
  return /^R-/.test(s) || /^X[A-Z]{3}$/.test(s);
}

/**
 * Normalise a provider's instrument-type/security-type string to our `AssetClass`.
 * Falls back to `equity` (the dominant case) when the type is missing or unknown.
 *
 * Pass `opts.symbol` + `opts.market` to activate the IDX KIK ETF heuristic: when the type
 * resolves to `mutual_fund` but the symbol matches the IDX ETF ticker convention on the IDX
 * market, the result is upgraded to `etf`.
 */
export function assetClassFromType(
  type: string | undefined | null,
  opts?: { symbol?: string | null; market?: string | null },
): AssetClass {
  const t = (type ?? "").toLowerCase();
  // "etf"/"etp"/"exchange traded" must be checked before "mutual"/"reksa": a UCITS ETF
  // reports OpenFIGI securityType "ETP" (with securityType2 "Mutual Fund"), and an
  // Indonesian exchange-traded reksa dana reads "exchange traded" — both are ETFs.
  let base: AssetClass;
  if (
    t.includes("etf") ||
    t.includes("etp") ||
    t.includes("fund of") ||
    t.includes("exchange traded") ||
    t.includes("exchange-traded")
  ) {
    base = "etf";
  } else if (t.includes("mutual") || t.includes("reksa")) {
    base = "mutual_fund";
  } else if (
    t.includes("bond") ||
    t.includes("note") ||
    t.includes("govt") ||
    t.includes("corp")
  ) {
    base = "bond";
  } else if (t.includes("crypto") || t.includes("digital currency")) {
    base = "crypto";
  } else if (
    t.includes("future") ||
    t.includes("option") ||
    t.includes("warrant") ||
    t.includes("derivative")
  ) {
    base = "derivative";
  } else {
    base = "equity";
  }
  // IDX KIK ETF upgrade: a reksa-dana-typed symbol whose ticker matches the IDX ETF
  // convention is an exchange-traded fund, not an open-end fund. Gated on market === "IDX"
  // so a foreign mutual_fund whose symbol happens to match the pattern (e.g. NYSE "X") is
  // never reclassified. (#120)
  if (base === "mutual_fund" && opts?.market === "IDX" && isIdxEtfSymbol(opts.symbol))
    return "etf";
  return base;
}
