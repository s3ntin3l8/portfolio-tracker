"use client";

import { useTranslations } from "next-intl";
import { ChevronRight, Plus } from "lucide-react";
import type { AccountHolder } from "@portfolio/api-client";
import { MonogramBadge } from "@/components/monogram-badge";
import { Link } from "@/i18n/navigation";

/**
 * Manage the people an investment account can belong to (the user, a child, …).
 * Holders are defined once and linked from portfolios, so birth year + child status
 * live in one place (issue #207). Deleting a holder unassigns it from any portfolios
 * (they revert to "standard"), it never deletes the portfolios.
 *
 * Design (`ProfileSettings.dc.html`): each row is a `›`-chevron link to the inline
 * "Edit account holder" page — no `⋯` menu (edit/delete both live on that page now).
 * Kept as a client component (even though nothing here is interactive anymore) so it
 * stays unit-testable with RTL per this repo's convention — Server Components are
 * excluded from the coverage gate and tested via e2e instead (see CLAUDE.md).
 */
export function AccountHoldersManager({ holders }: { holders: AccountHolder[] }) {
  const t = useTranslations("AccountHolders");
  const tf = useTranslations("PortfolioForm");

  return (
    <div className="rounded-[18px] bg-card p-[18px] shadow-card">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-bold">{t("title")}</h2>
          <p className="mt-0.5 text-xs font-medium text-text-2">{t("subtitle")}</p>
        </div>
        {/* Reference: soft-green pill; icon-only on mobile, icon+label on desktop. */}
        <Link
          href="/settings/portfolios/holder/new"
          aria-label={t("add")}
          className="flex shrink-0 items-center gap-1.5 rounded-[9px] bg-primary/10 px-[11px] py-[7px] text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          <Plus className="size-[15px]" strokeWidth={2.4} />
          <span className="hidden sm:inline">{t("add")}</span>
        </Link>
      </div>

      {holders.length > 0 ? (
        <div className="flex flex-col gap-2">
          {holders.map((h) => (
            <Link
              key={h.id}
              href={`/settings/portfolios/holder/${h.id}`}
              className="flex items-center gap-3 rounded-[12px] bg-card-2 px-[13px] py-[11px] transition-colors hover:bg-card-2/70"
            >
              <MonogramBadge label={h.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{h.name}</p>
                <p className="truncate text-xs font-medium text-text-2">
                  {tf(`holderType${capitalize(h.type)}`)}
                  {h.birthYear != null ? ` · ${h.birthYear}` : ""}
                </p>
              </div>
              <ChevronRight
                aria-hidden
                className="size-[18px] shrink-0 text-[color:var(--chevron,#C3CBC6)]"
              />
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-2">{t("empty")}</p>
      )}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
