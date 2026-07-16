"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MonogramBadge } from "@/components/monogram-badge";

/**
 * logo.dev ticker suffix per internal market — mirrors `yahooSuffixForMarket` in
 * `packages/market-data/src/instrument-mapping.ts` (kept as a small local copy rather than
 * importing that server-side package into the client bundle). Confirmed empirically against
 * the live API: a bare ticker and its suffixed form can resolve to *different* companies
 * (e.g. `ANTM` = US Anthem vs `ANTM.JK` = Aneka Tambang), so the suffix matters for
 * correctness, not just cosmetics. Markets absent here use the bare symbol (correct for US).
 */
const MARKET_LOGO_SUFFIX: Record<string, string> = {
  IDX: ".JK",
  XETRA: ".DE",
};

/** Asset classes for which a logo.dev lookup is attempted; everything else is a monogram. */
const LOGO_ASSET_CLASSES = new Set(["equity", "etf", "crypto"]);

function logoDevPath(symbol: string, market: string | null | undefined, assetClass: string) {
  if (assetClass === "crypto") return `crypto/${encodeURIComponent(symbol)}`;
  const suffix = (market && MARKET_LOGO_SUFFIX[market]) ?? "";
  return `ticker/${encodeURIComponent(symbol)}${suffix}`;
}

/**
 * Real company/crypto logo (via logo.dev), falling back to the existing colored-initials
 * `MonogramBadge` when no symbol/asset-class is eligible, the token isn't configured, or the
 * image fails to load (`fallback=404` on the logo.dev URL makes a miss a genuine `onError`,
 * not a silent placeholder image). Equity/ETF/crypto only — gold, cash, bonds, mutual funds
 * and derivatives always render the monogram; see `instrument-logo.test.tsx` for the matrix
 * (verified live: US/XETRA/IDX equities resolve, European UCITS ETFs don't).
 */
export function InstrumentLogo({
  label,
  symbol,
  market,
  assetClass,
  className,
}: {
  label: string;
  symbol?: string | null;
  market?: string | null;
  assetClass?: string | null;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const token = process.env.NEXT_PUBLIC_LOGODEV_TOKEN;

  const eligible =
    !errored && !!token && !!symbol && !!assetClass && LOGO_ASSET_CLASSES.has(assetClass);

  if (!eligible) {
    return <MonogramBadge label={label} assetClass={assetClass} className={className} />;
  }

  const path = logoDevPath(symbol, market, assetClass);
  const src = `https://img.logo.dev/${path}?token=${token}&size=128&format=png&fallback=404`;

  return (
    <span
      className={cn(
        "inline-flex size-[38px] shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-muted",
        className,
      )}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- external CDN image, next/image is unused in this app */}
      <img
        src={src}
        alt=""
        className="block size-full object-contain p-1"
        onError={() => setErrored(true)}
      />
    </span>
  );
}
