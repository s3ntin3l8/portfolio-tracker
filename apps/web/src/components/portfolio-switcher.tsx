"use client";

import { useTranslations } from "next-intl";
import { Check, ChevronDown, Layers } from "lucide-react";
import type { Portfolio } from "@portfolio/api-client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Global portfolio scope selector shown in the app shell header. The first option is the
 * "All portfolios" aggregate (the default); choosing one writes the `pf` cookie and
 * refreshes so the RSC screens (holdings, transactions, import) re-read the scope.
 * Hidden until the user actually has more than one portfolio to switch between.
 *
 * Built on a Radix dropdown (not a native <select>) so each row — and the trigger — can
 * render the brokerage logo/monogram via `BrokerageIcon`.
 */
export function PortfolioSwitcher({
  portfolios,
  selectedId,
}: {
  portfolios: Pick<Portfolio, "id" | "name" | "brokerage" | "accountHolder">[];
  selectedId: string | null;
}) {
  const t = useTranslations("PortfolioSwitcher");
  const router = useRouter();

  if (portfolios.length === 0) return null;

  function onSelect(value: string) {
    document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=${value}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    router.refresh();
  }

  const selected = portfolios.find((p) => p.id === selectedId);
  const label = (p: Pick<Portfolio, "name" | "brokerage" | "accountHolder">) => {
    const parts = [p.name];
    if (p.brokerage) parts.push(p.brokerage);
    if (p.accountHolder) parts.push(p.accountHolder);
    return parts.join(" · ");
  };

  // With a single portfolio there's nothing to switch between, but a static label still
  // tells the user which portfolio every screen is scoped to (the scope is otherwise
  // invisible). No dropdown — it's purely an indicator.
  if (portfolios.length === 1) {
    const only = portfolios[0];
    return (
      <div
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground"
        aria-label={t("label")}
      >
        <BrokerageIcon brokerage={only.brokerage} className="size-5" />
        <span className="truncate">{label(only)}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("label")}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {selected ? (
          <BrokerageIcon brokerage={selected.brokerage} className="size-5" />
        ) : (
          <Layers className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{selected ? label(selected) : t("all")}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[16rem]">
        <DropdownMenuItem onSelect={() => onSelect("all")}>
          <Layers className="size-5 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("all")}</span>
          <Check
            className={cn(
              "ml-auto size-4 shrink-0",
              selected ? "invisible" : "visible",
            )}
          />
        </DropdownMenuItem>
        {portfolios.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onSelect(p.id)}>
            <BrokerageIcon brokerage={p.brokerage} className="size-5" />
            <span className="truncate">{label(p)}</span>
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
