"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportReview } from "@/components/import-review";
import { DuplicateConflictBanner } from "@/components/duplicate-conflict-banner";
import { PortfolioPicker } from "@/components/portfolio-picker";
import { Label } from "@/components/ui/label";
import {
  withUid,
  type ImportDraft,
  type ImportIssue,
  type ImportTargetPortfolio,
  type ReviewDraft,
} from "@/components/import-flow";
import { useApiClient } from "@/lib/api";
import { useImportConfirm } from "@/lib/use-import-confirm";
import { useRouter } from "@/i18n/navigation";

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

  // Transient "N transactions imported" banner after a partial confirm.
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const importedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Portfolio selection: use the stored portfolioId if available, otherwise default to
  // the first portfolio in the list. The picker is only shown when there are multiple
  // portfolios and the import doesn't already have a portfolio bound.
  const [portfolioId, setPortfolioId] = useState<string>(
    initialPortfolioId ?? portfolios[0]?.id ?? "",
  );

  function backToImport() {
    router.push("/transactions");
    router.refresh(); // surface the new transactions (and updated history) elsewhere
  }

  const {
    error,
    duplicateConflict,
    accountMismatch,
    pendingSubset,
    pendingAcknowledgeMismatch,
    confirm,
    enrichOneDuplicate,
  } = useImportConfirm({
    importId,
    drafts,
    setDrafts,
    contracts: [],
    getPortfolioId: () => portfolioId || undefined,
    client: api,
    onFullSuccess: () => backToImport(),
    onPartialSuccess: (count) => {
      setImportedCount(count);
      if (importedTimer.current) clearTimeout(importedTimer.current);
      importedTimer.current = setTimeout(() => setImportedCount(null), 5000);
      router.refresh();
    },
    getErrorMessage: () => t("reviewError"),
  });

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

  async function discard() {
    try {
      await api.discardImport(importId);
      backToImport();
    } catch {
      // The error is surfaced by the shared hook state if confirm was in flight;
      // for discard we rely on the global error boundary (discard failure is rare).
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
      {/* Account-mismatch warning (#197): file looks like it belongs to another portfolio. */}
      {accountMismatch && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span className="flex-1">
            {accountMismatch.kind === "other_portfolio"
              ? ti("accountMismatch.otherPortfolio", {
                  portfolio: accountMismatch.matchedName ?? "",
                  account: accountMismatch.detected,
                })
              : ti("accountMismatch.noMatch", { account: accountMismatch.detected })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void confirm(undefined, true)}
          >
            {ti("accountMismatch.importAnyway")}
          </Button>
        </div>
      )}
      {duplicateConflict && (
        <DuplicateConflictBanner
          conflict={duplicateConflict}
          onEnrich={(d) => void enrichOneDuplicate(d)}
          onImportAnyway={() =>
            void confirm(
              pendingSubset.current.map((d) => d.uid),
              pendingAcknowledgeMismatch.current,
              true,
            )
          }
        />
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
