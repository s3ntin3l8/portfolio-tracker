"use client";

import { useTranslations } from "next-intl";
import { Check, ChevronDown, Layers, Users } from "lucide-react";
import type { Portfolio, AccountHolder } from "@portfolio/api-client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  SELECTED_PORTFOLIO_COOKIE,
  HOLDER_SCOPE_PREFIX,
} from "@/lib/portfolio-selection";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Global scope selector shown in the app shell header. Three levels:
 * 1. "All portfolios" — the cross-portfolio aggregate (default).
 * 2. Account holders — an aggregate of all portfolios owned by that holder
 *    (only shown when a holder owns ≥2 portfolios; single-portfolio holders are
 *    equivalent to the portfolio view already covered by section 3).
 * 3. Individual portfolios.
 *
 * Selecting any item writes the `pf` cookie and triggers an RSC refresh so
 * every server-rendered screen re-reads the new scope.
 * - Portfolio: `pf=<portfolioId>`
 * - Holder aggregate: `pf=holder:<holderId>`
 * - All: `pf=all`
 */
export function PortfolioSwitcher({
  portfolios,
  holders = [],
  selectedId,
  selectedHolderId = null,
}: {
  portfolios: Pick<Portfolio, "id" | "name" | "brokerage" | "accountHolder">[];
  /** Holders that qualify for the filter (≥2 portfolios each). Passed from layout. */
  holders?: Pick<AccountHolder, "id" | "name">[];
  selectedId: string | null;
  selectedHolderId?: string | null;
}) {
  const t = useTranslations("PortfolioSwitcher");
  const router = useRouter();

  if (portfolios.length === 0) return null;

  function onSelect(value: string) {
    document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=${value}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    router.refresh();
  }

  const selectedPortfolio = portfolios.find((p) => p.id === selectedId);
  const selectedHolder = holders.find((h) => h.id === selectedHolderId);

  const portfolioLabel = (p: Pick<Portfolio, "name" | "brokerage" | "accountHolder">) => {
    const parts = [p.name];
    if (p.brokerage) parts.push(p.brokerage);
    if (p.accountHolder) parts.push(p.accountHolder);
    return parts.join(" · ");
  };

  // With a single portfolio and no qualifying holders there's nothing to switch
  // between, but a static label still tells the user which portfolio every screen
  // is scoped to (the scope is otherwise invisible). No dropdown — purely an indicator.
  if (portfolios.length === 1 && holders.length === 0) {
    const only = portfolios[0];
    return (
      <div
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground"
        aria-label={t("label")}
      >
        <BrokerageIcon brokerage={only.brokerage} className="size-5" />
        <span className="truncate">{portfolioLabel(only)}</span>
      </div>
    );
  }

  // Determine what to show in the trigger.
  const triggerIcon = selectedHolder ? (
    <Users className="size-4 shrink-0 text-muted-foreground" />
  ) : selectedPortfolio ? (
    <BrokerageIcon brokerage={selectedPortfolio.brokerage} className="size-5" />
  ) : (
    <Layers className="size-4 shrink-0 text-muted-foreground" />
  );
  const triggerLabel = selectedHolder
    ? selectedHolder.name
    : selectedPortfolio
      ? portfolioLabel(selectedPortfolio)
      : t("all");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("label")}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {triggerIcon}
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[16rem]">
        {/* Section 1: All portfolios */}
        <DropdownMenuItem onSelect={() => onSelect("all")}>
          <Layers className="size-5 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("all")}</span>
          <Check
            className={cn(
              "ml-auto size-4 shrink-0",
              !selectedPortfolio && !selectedHolder ? "visible" : "invisible",
            )}
          />
        </DropdownMenuItem>

        {/* Section 2: Account holders (only when qualifying holders exist) */}
        {holders.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("accountHolders")}</DropdownMenuLabel>
            {holders.map((h) => (
              <DropdownMenuItem
                key={h.id}
                onSelect={() => onSelect(`${HOLDER_SCOPE_PREFIX}${h.id}`)}
              >
                <Users className="size-5 shrink-0 text-muted-foreground" />
                <span className="truncate">{h.name}</span>
                <Check
                  className={cn(
                    "ml-auto size-4 shrink-0",
                    h.id === selectedHolderId ? "visible" : "invisible",
                  )}
                />
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* Section 3: Individual portfolios */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("portfolios")}</DropdownMenuLabel>
        {portfolios.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onSelect(p.id)}>
            <BrokerageIcon brokerage={p.brokerage} className="size-5" />
            <span className="truncate">{portfolioLabel(p)}</span>
            <Check
              className={cn(
                "ml-auto size-4 shrink-0",
                p.id === selectedId ? "visible" : "invisible",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
