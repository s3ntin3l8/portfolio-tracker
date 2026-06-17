"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ImportReview } from "@/components/import-review";
import {
  withUid,
  stripUid,
  type ImportDraft,
  type ImportIssue,
  type ReviewDraft,
} from "@/components/import-flow";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Review and confirm an already-staged draft import (e.g. a Trade Republic sync, or a
 * parse the user navigated away from). Reuses the same `ImportReview` table as the live
 * upload flow, seeded with the draft's transactions loaded server-side. Confirming writes
 * the transactions; discarding marks the import discarded. Both return to /import.
 */
export function DraftReviewClient({
  importId,
  drafts: initial,
  issues: initialIssues = [],
}: {
  importId: string;
  drafts: ImportDraft[];
  issues?: ImportIssue[];
}) {
  const t = useTranslations("ImportHistory");
  const api = useApiClient();
  const router = useRouter();

  const [drafts, setDrafts] = useState<ReviewDraft[]>(() =>
    initial.map((d) => withUid(d, importId)),
  );
  const [issues, setIssues] = useState<ImportIssue[]>(initialIssues);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const importedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    router.push("/import");
    router.refresh(); // surface the new transactions (and updated history) elsewhere
  }

  // Confirm all drafts, or just the subset whose uids are passed (confirm-selected).
  async function confirm(uids?: string[]) {
    setError(null);
    const subset =
      uids && uids.length ? drafts.filter((d) => uids.includes(d.uid)) : drafts;
    // A partial confirm keeps the import open server-side — stay on the page, drop the
    // confirmed rows, and let the user continue in passes. A full confirm closes it.
    const isPartial = subset.length < drafts.length;
    try {
      await api.confirmImport(
        importId,
        subset.map(stripUid) as unknown as Parameters<typeof api.confirmImport>[1],
      );
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
