"use client";

import { useState } from "react";
import type { ApiClient, Anomaly, TransactionStatus } from "@portfolio/api-client";
import type { TxRow } from "@/components/transactions-table";

export function useTransactionActions(
  api: ApiClient,
  router: { refresh: () => void },
  tx: TxRow | null,
) {
  const [dismissing, setDismissing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  async function dismissAnomaly(anomaly: Anomaly, onOpenChange: (open: boolean) => void) {
    if (!anomaly || !tx) return;
    setDismissing(true);
    try {
      await api.dismissAnomaly(tx.portfolioId, tx.id, anomaly.code);
      onOpenChange(false);
      router.refresh();
    } catch {
      // Leave the sheet open on failure so the user can retry.
    } finally {
      setDismissing(false);
    }
  }

  async function onDelete(onDeleted: () => void, onOpenChange: (open: boolean) => void) {
    if (!tx) return;
    setDeleting(true);
    try {
      await api.deleteTransaction(tx.portfolioId, tx.id);
      router.refresh();
      onDeleted();
      onOpenChange(false);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function downloadReceipt() {
    if (!tx) return;
    try {
      const { url } = await api.getTransactionDocumentUrl(tx.portfolioId, tx.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Signed URL fetch failed — silently ignore.
    }
  }

  async function setStatus(next: TransactionStatus) {
    if (!tx || next === (tx.status ?? "normal") || statusBusy) return;
    setStatusBusy(true);
    try {
      await api.setTransactionStatus(tx.portfolioId, tx.id, next);
      router.refresh();
    } finally {
      setStatusBusy(false);
    }
  }

  return {
    dismissing,
    confirmingDelete,
    deleting,
    statusBusy,
    setConfirmingDelete,
    dismissAnomaly,
    onDelete,
    downloadReceipt,
    setStatus,
  };
}
