"use client";

import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DuplicateConflict, DuplicateMatch } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";

const MAX_SHOWN = 5;

interface DuplicateConflictBannerProps {
  conflict: DuplicateConflict;
  onEnrich: (d: DuplicateMatch) => void;
  onImportAnyway: () => void;
}

/**
 * Warning banner shown when a confirm 409 reports cross-source duplicate transactions
 * (#217/#230). Shared by the live upload flow (import-flow.tsx) and the staged draft
 * review flow (draft-review-client.tsx) so the UX is identical regardless of entry point.
 *
 * - Shows up to 5 duplicate rows with the matched source.
 * - Per-row "Enrich existing" button when a target transaction is known.
 * - Box-level "Import anyway" to re-confirm with acknowledgeDuplicates=true.
 * - "+N more" overflow line when there are more than 5 matches.
 */
export function DuplicateConflictBanner({
  conflict,
  onEnrich,
  onImportAnyway,
}: DuplicateConflictBannerProps) {
  const t = useTranslations("Duplicates");

  const shown = conflict.duplicates.slice(0, MAX_SHOWN);
  const overflow = conflict.duplicates.length - MAX_SHOWN;

  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="flex-1 space-y-1">
          <p>{t("warning", { count: conflict.count })}</p>
          {shown.length > 0 && (
            <ul className="space-y-1.5 pl-4 text-xs">
              {shown.map((d, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="flex-1 text-warning/90">
                    {t("row", {
                      name: d.name ?? "—",
                      action: d.action,
                      date: d.executedAt,
                      source: d.matchedSource ?? "—",
                    })}
                  </span>
                  {d.matchedTransactionId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 shrink-0 text-xs"
                      onClick={() => onEnrich(d)}
                    >
                      {t("enrichExisting")}
                    </Button>
                  )}
                </li>
              ))}
              {overflow > 0 && (
                <li className="text-warning/70">{t("more", { count: overflow })}</li>
              )}
            </ul>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-warning/80 hover:text-warning"
          onClick={onImportAnyway}
        >
          {t("importAnyway")}
        </Button>
      </div>
    </div>
  );
}
