"use client";

import { useTranslations } from "next-intl";
import { Check, ChevronDown, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface FilterableHolder {
  id: string;
  name: string;
}

interface Props {
  holders: FilterableHolder[];
  /** The currently selected holder id (from a validated `?holder=` param). */
  selectedId: string | null;
}

/**
 * Dropdown that narrows the income / savings aggregate to a single account holder's
 * portfolios by appending `?holder=<id>` to the current URL. Only shown when the
 * global scope is "all portfolios" and there is at least one qualifying holder
 * (a holder owning ≥2 portfolios — single-portfolio holders equal the portfolio view).
 *
 * Mirrors `CostBasisToggle` (Link + useSearchParams, no cookie) so the selection is
 * page-local and doesn't affect other screens. Wrapping in <Suspense> at the call site
 * is required by Next.js (useSearchParams needs a Suspense boundary).
 */
export function HolderFilter({ holders, selectedId }: Props) {
  const t = useTranslations("HolderFilter");
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const href = (holderId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (holderId) {
      params.set("holder", holderId);
    } else {
      params.delete("holder");
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const selected = holders.find((h) => h.id === selectedId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("label")}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Users className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{selected ? selected.name : t("all")}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[16rem]">
        <DropdownMenuItem asChild>
          <Link href={href(null)}>
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{t("all")}</span>
            <Check
              className={cn(
                "ml-auto size-4 shrink-0",
                selected === null ? "visible" : "invisible",
              )}
            />
          </Link>
        </DropdownMenuItem>
        {holders.map((h) => (
          <DropdownMenuItem key={h.id} asChild>
            <Link href={href(h.id)}>
              <Users className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{h.name}</span>
              <Check
                className={cn(
                  "ml-auto size-4 shrink-0",
                  h.id === selectedId ? "visible" : "invisible",
                )}
              />
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
