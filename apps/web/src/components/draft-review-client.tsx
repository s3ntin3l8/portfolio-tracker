"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { ImportReview } from "@/components/import-review";
import {
  withUid,
  stripUid,
  type ImportDraft,
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
}: {
  importId: string;
  drafts: ImportDraft[];
}) {
  const t = useTranslations("ImportHistory");
  const api = useApiClient();
  const router = useRouter();

  const [drafts, setDrafts] = useState<ReviewDraft[]>(() => initial.map(withUid));
  const [error, setError] = useState<string | null>(null);

  function updateDraft(uid: string, patch: Partial<ImportDraft>) {
    setDrafts((ds) => ds.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
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
    try {
      await api.confirmImport(
        importId,
        subset.map(stripUid) as unknown as Parameters<typeof api.confirmImport>[1],
      );
      backToImport();
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
      <ImportReview
        drafts={drafts}
        onUpdate={updateDraft}
        onRemove={removeDraft}
        onRemoveMany={removeMany}
        onConfirm={confirm}
        onDiscard={discard}
      />
    </div>
  );
}
