"use client";

import { Check, ChevronDown } from "lucide-react";
import type { Portfolio } from "@portfolio/api-client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { cn } from "@/lib/utils";

export type PickablePortfolio = Pick<Portfolio, "id" | "name" | "brokerage" | "accountHolder">;

/** `name · brokerage · accountHolder`, skipping the blanks. Mirrors PortfolioSwitcher. */
export function portfolioLabel(p: Pick<Portfolio, "name" | "brokerage" | "accountHolder">): string {
  const parts = [p.name];
  if (p.brokerage) parts.push(p.brokerage);
  if (p.accountHolder) parts.push(p.accountHolder);
  return parts.join(" · ");
}

/**
 * Controlled portfolio selector with the same rich look as the app-shell
 * {@link PortfolioSwitcher} — a Radix dropdown showing each portfolio's `BrokerageIcon`
 * and `name · brokerage · accountHolder` label, so a plain "Main" vs "Main" is told apart
 * by its logo/broker. Unlike the switcher it's a plain `value`/`onChange` control (no
 * "All" option, no cookie/refresh) for use inside forms such as the import flow.
 */
export function PortfolioPicker({
  portfolios,
  value,
  onChange,
  ariaLabel,
  triggerClassName,
}: {
  portfolios: PickablePortfolio[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  const selected = portfolios.find((p) => p.id === value) ?? portfolios[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-9 max-w-full items-center gap-1.5 rounded-full bg-card py-1.5 pl-1.5 pr-3 text-xs font-semibold text-foreground shadow-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
      >
        {selected && <BrokerageIcon brokerage={selected.brokerage} className="size-5 rounded-md" />}
        <span className="truncate">{selected?.name ?? ""}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[16rem]">
        {portfolios.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onChange(p.id)}>
            <BrokerageIcon brokerage={p.brokerage} className="size-5" />
            <span className="truncate">{portfolioLabel(p)}</span>
            <Check
              className={cn(
                "ml-auto size-4 shrink-0",
                p.id === selected?.id ? "visible" : "invisible",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
