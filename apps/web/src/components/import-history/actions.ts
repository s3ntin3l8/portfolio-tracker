"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ApiClient } from "@portfolio/api-client";

export function useImportActions(api: ApiClient, router: { refresh: () => void }) {
  const t = useTranslations("ImportHistory");
  const trx = useTranslations("Transactions.reassign");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reassignId, setReassignId] = useState<string | null>(null);

  async function discard(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.discardImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
    }
  }

  async function undo(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.deleteImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  async function clear(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.clearImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
    }
  }

  async function doReassignImport(targetPortfolioId: string) {
    if (!reassignId) return;
    try {
      const r = await api.reassignImport(reassignId, targetPortfolioId);
      const skipped = r.skippedConflicts + r.skippedLoans;
      if (r.moved === 0) toast.info(trx("none"));
      else if (skipped > 0) toast.success(trx("successWithSkips", { moved: r.moved, skipped }));
      else toast.success(trx("success", { count: r.moved }));
      setReassignId(null);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    }
  }

  async function downloadDocument(id: string) {
    try {
      const { url } = await api.getImportDocumentUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setActionError(t("downloadError"));
    }
  }

  return {
    busyId,
    confirmId,
    clearingAll,
    actionError,
    reassignId,
    setConfirmId,
    setReassignId,
    setClearingAll,
    setActionError,
    discard,
    undo,
    clear,
    doReassignImport,
    downloadDocument,
  };
}
