"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ImportReview } from "@/components/import-review";
import { PortfolioPicker } from "@/components/portfolio-picker";
import { Label } from "@/components/ui/label";
import {
  withUid,
  stripUid,
  type ImportDraft,
  type ImportIssue,
  type ImportTargetPortfolio,
  type ReviewDraft,
} from "@/components/import-flow";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { duplicatesFromError, type DuplicateConflict, type DuplicateMatch } from "@portfolio/api-client";
import type { ParsedTransaction } from "@portfolio/schema";
import { Button } from "@/components/ui/button";

/**
 * Review and confirm an already-staged draft import (e.g. a Trade Republic sync, or a
 * parse the user navigated away from). Reuses the same `ImportReview` table as the live
 * upload flow, seeded with the draft's transactions loaded server-side. Confirming writes
 * the transactions; discarding marks the import discarded. Both return to /transactions.
 */
export function DraftReviewClient({
  importId,
  initialPortfolioId,
  drafts: initial,
  issues: initialIssues = [],
  portfolios = [],
}: {
  importId: string;
  /** Portfolio stored on the import record (pytr always has one; CSV/screenshot may not). */
  initialPortfolioId: string | null;
  drafts: ImportDraft[];
  issues?: ImportIssue[];
  portfolios?: ImportTargetPortfolio[];
}) {
  const t = useTranslations("ImportHistory");
  const ti = useTranslations("Import");
  const api = useApiClient();
  const router = useRouter();

  const [drafts, setDrafts] = useState<ReviewDraft[]>(() =>
    initial.map((d) => withUid(d, importId)),
  );
  const [issues, setIssues] = useState<ImportIssue[]>(initialIssues);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const importedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cross-source duplicate warning (#217) from a confirm 409; "Import anyway" re-confirms
  // the same selection with the acknowledge flag.
  const [duplicateConflict, setDuplicateConflict] = useState<DuplicateConflict | null>(null);
  const pendingUids = useRef<string[] | undefined>(undefined);
  // Ordered subset sent to the last confirm — the 409 response's draftIndex references it.
  const pendingSubset = useRef<ReviewDraft[]>([]);

  // Portfolio selection: use the stored portfolioId if available, otherwise default to
  // the first portfolio in the list. The picker is only shown when there are multiple
  // portfolios and the import doesn't already have a portfolio bound.
  const [portfolioId, setPortfolioId] = useState<string>(
    initialPortfolioId ?? portfolios[0]?.id ?? "",
  );

  function updateDraft(uid: string, patch: Partial<ImportDraft>) {
    setDrafts((ds) => ds.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
  }

  // Promote a mapped issue into a draft, then drop it from the issues list.
  function mapIssue(eventId: string, draft: ImportDraft) {
    setDrafts((ds) => [...ds, withUid(draft, importId)]);
    setIssues((is) => is.filter((i) => i.eventId !== eventId));
  }

  function removeDraft(uid: string) {
    setDrafts((ds) => ds.filter((d) => d.uid !== uid));
  }

  function removeMany(uids: string[]) {
    const set = new Set(uids);
    setDrafts((ds) => ds.filter((d) => !set.has(d.uid)));
  }

  function backToImport() {
    router.push("/transactions");
    router.refresh(); // surface the new transactions (and updated history) elsewhere
  }

  // Confirm all drafts, or just the subset whose uids are passed (confirm-selected).
  async function confirm(uids?: string[], acknowledgeDup = false) {
    setError(null);
    pendingUids.current = uids;
    const subset =
      uids && uids.length ? drafts.filter((d) => uids.includes(d.uid)) : drafts;
    // Store ordered subset for the enrich path (draftIndex resolves into this array).
    pendingSubset.current = subset;
    // A partial confirm keeps the import open server-side — stay on the page, drop the
    // confirmed rows, and let the user continue in passes. A full confirm closes it.
    const isPartial = subset.length < drafts.length;
    try {
      await api.confirmImport(
        importId,
        subset.map(stripUid) as unknown as Parameters<typeof api.confirmImport>[1],
        [],
        portfolioId || undefined,
        false,
        acknowledgeDup,
      );
      setDuplicateConflict(null);
      if (isPartial) {
        const confirmed = new Set(subset.map((d) => d.uid));
        setDrafts((ds) => ds.filter((d) => !confirmed.has(d.uid)));
        // Show a brief success banner so the user knows the confirm landed.
        setImportedCount(subset.length);
        if (importedTimer.current) clearTimeout(importedTimer.current);
        importedTimer.current = setTimeout(() => setImportedCount(null), 5000);
        router.refresh(); // surface the new transactions (and updated history) elsewhere
      } else {
        backToImport();
      }
    } catch (err) {
      const duplicates = duplicatesFromError(err);
      if (duplicates) {
        setDuplicateConflict(duplicates);
      } else {
        setError(t("reviewError"));
      }
    }
  }

  /**
   * Enrich a matched confirmed transaction with the corresponding draft (#230).
   * `d.draftIndex` indexes `pendingSubset.current` (the ordered subset sent to the last confirm).
   */
  async function enrichOneDuplicate(d: DuplicateMatch) {
    const draft = pendingSubset.current[d.draftIndex];
    if (!draft) return;
    try {
      await api.enrichImport(
        importId,
        [{ draft: stripUid(draft) as unknown as ParsedTransaction, targetTransactionId: d.matchedTransactionId }],
        portfolioId || undefined,
      );
      // Drop the enriched draft, clear the conflict, re-confirm remaining.
      const remainingUids = pendingSubset.current
        .filter((_, i) => i !== d.draftIndex)
        .map((dr) => dr.uid);
      setDuplicateConflict(null);
      removeMany([draft.uid]);
      if (remainingUids.length > 0) {
        void confirm(remainingUids, false);
      }
    } catch {
      setError(t("reviewError"));
    }
  }

  async function discard() {
    setError(null);
    try {
      await api.discardImport(importId);
      backToImport();
    } catch {
      setError(t("reviewError"));
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}
      {importedCount !== null && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          {t("importedBanner", { count: importedCount })}
        </div>
      )}
      {duplicateConflict && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1 space-y-1">
              <p>{t("duplicates.warning", { count: duplicateConflict.count })}</p>
              {duplicateConflict.duplicates.length > 0 && (
                <ul className="space-y-1.5 pl-4 text-xs">
                  {duplicateConflict.duplicates.slice(0, 5).map((d, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="flex-1 text-warning/90">
                        {d.name ?? "—"} · {d.action} · {d.executedAt}
                      </span>
                      {d.matchedTransactionId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 text-xs"
                          onClick={() => void enrichOneDuplicate(d)}
                        >
                          {t("duplicates.enrichExisting")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void confirm(pendingUids.current, true)}
            >
              {t("duplicates.importAnyway")}
            </Button>
          </div>
        </div>
      )}
      {portfolios.length > 1 && (
        <div className="space-y-1.5">
          <Label>{ti("targetPortfolio")}</Label>
          <PortfolioPicker
            portfolios={portfolios}
            value={portfolioId}
            onChange={setPortfolioId}
            ariaLabel={ti("targetPortfolio")}
            triggerClassName="w-full"
          />
        </div>
      )}
      <ImportReview
        drafts={drafts}
        issues={issues}
        onMapIssue={mapIssue}
        onUpdate={updateDraft}
        onRemove={removeDraft}
        onRemoveMany={removeMany}
        onConfirm={confirm}
        onDiscard={discard}
      />
    </div>
  );
}
