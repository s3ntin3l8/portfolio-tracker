"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ImportRecord } from "@portfolio/api-client";
import { ImportHistory } from "@/components/import-history";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { cn } from "@/lib/utils";

/**
 * Embeds the import history on the Transactions page as a disclosure, collapsed by
 * default so it doesn't crowd the transaction table. Reuses {@link ImportHistory} for
 * the table and its per-row actions; this wrapper only owns the collapse + heading.
 */
export function RecentImportsSection({
  items,
  portfolios = [],
}: {
  items: ImportRecord[];
  portfolios?: PickablePortfolio[];
}) {
  const t = useTranslations("ImportHistory");
  // Open by default when there's an actionable draft to review (a TR sync, a partial
  // confirm, a shared screenshot); a confirmed/discarded-only audit trail stays collapsed.
  const [open, setOpen] = useState(() =>
    items.some((i) => i.status === "draft"),
  );

  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-0.5 text-xs font-bold uppercase tracking-[0.04em] text-text-3 transition-colors hover:text-foreground"
      >
        {t("title")}
        <span className="font-semibold normal-case tracking-normal text-text-3">
          ({items.length})
        </span>
        <ChevronDown
          className={cn("size-[13px] transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <ImportHistory items={items} showTitle={false} portfolios={portfolios} />
      )}
    </div>
  );
}
