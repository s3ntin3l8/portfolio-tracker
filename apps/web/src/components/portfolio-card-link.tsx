"use client";

import { useRouter } from "@/i18n/navigation";

/**
 * Invisible overlay link on a portfolio card. On click, navigates to /holdings
 * with a transient ?portfolio=<id> query param — does NOT write the global
 * selection cookie, so transactions/dashboard keep their existing scope.
 */
export function PortfolioCardLink({ portfolioId, name }: { portfolioId: string; name: string }) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => router.push(`/holdings?portfolio=${portfolioId}`)}
      className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      aria-label={name}
    />
  );
}
