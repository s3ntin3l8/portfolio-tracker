"use client";

import { useTranslations } from "next-intl";
import type { Portfolio } from "@portfolio/api-client";
import { Select } from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Global portfolio scope selector shown in the app shell. The first option is the
 * "All portfolios" aggregate (the default); choosing one writes the `pf` cookie and
 * refreshes so the RSC screens (holdings, transactions, import) re-read the scope.
 * Hidden until the user actually has more than one portfolio to switch between.
 */
export function PortfolioSwitcher({
  portfolios,
  selectedId,
}: {
  portfolios: Pick<Portfolio, "id" | "name">[];
  selectedId: string | null;
}) {
  const t = useTranslations("PortfolioSwitcher");
  const router = useRouter();

  if (portfolios.length < 2) return null;

  function onChange(value: string) {
    document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=${value}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    router.refresh();
  }

  return (
    <Select
      aria-label={t("label")}
      value={selectedId ?? "all"}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="all">{t("all")}</option>
      {portfolios.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}
