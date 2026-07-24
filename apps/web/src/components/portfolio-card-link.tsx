"use client";

import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";

/**
 * The portfolio card's click target and trailing affordance (design: `›` chevron, whole
 * card opens the inline edit page — no `⋯` menu). An overlay link, not a wrapping `<a>`,
 * so `PortfolioSyncWatcher`'s absence of interactive children keeps the card's own hover/
 * focus ring on the whole surface while still allowing future interactive elements to be
 * layered above it at a higher z-index if needed.
 */
export function PortfolioCardLink({ portfolioId, name }: { portfolioId: string; name: string }) {
  return (
    <Link
      href={`/settings/portfolios/${portfolioId}`}
      className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      aria-label={name}
    />
  );
}

/** Trailing `›` chevron — the design's sole affordance on a portfolio card (replaces the
 *  old `⋯` overflow menu). Purely decorative; the whole card is the click target via
 *  {@link PortfolioCardLink} above. */
export function PortfolioCardChevron() {
  return (
    <ChevronRight
      aria-hidden
      className="mt-0.5 size-[18px] shrink-0 text-[color:var(--chevron,#C3CBC6)]"
    />
  );
}
