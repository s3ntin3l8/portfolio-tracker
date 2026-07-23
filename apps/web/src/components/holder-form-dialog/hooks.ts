"use client";

import { useState } from "react";
import type { AccountHolder, AccountHolderType } from "@portfolio/api-client";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Extracted from `HolderFormDialog` (unchanged behavior) so the desktop Add Transaction
 * shell's "Account holder" rail destination can render the form body inline instead of
 * nesting another Sheet — see `holder-form-dialog/body.tsx` and
 * `add-transaction-menu/desktop-shell.tsx`.
 */
export function useHolderForm(
  mode: "create" | "edit",
  holder?: AccountHolder,
  onSuccess?: () => void,
) {
  const api = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(holder?.name ?? "");
  const [type, setType] = useState<AccountHolderType>(holder?.type ?? "self");
  const [birthYear, setBirthYear] = useState(
    holder?.birthYear != null ? String(holder.birthYear) : "",
  );
  // German tax profile fields.
  const [taxAllowance, setTaxAllowance] = useState(holder?.taxAllowanceAnnual ?? "");
  const [taxRate, setTaxRate] = useState(holder?.capitalGainsTaxRate ?? "");
  const [churchTax, setChurchTax] = useState(holder?.churchTax ?? false);
  const [taxResidence, setTaxResidence] = useState(holder?.taxResidence ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function onOpenChange(next: boolean) {
    if (next) {
      setName(holder?.name ?? "");
      setType(holder?.type ?? "self");
      setBirthYear(holder?.birthYear != null ? String(holder.birthYear) : "");
      setTaxAllowance(holder?.taxAllowanceAnnual ?? "");
      setTaxRate(holder?.capitalGainsTaxRate ?? "");
      setChurchTax(holder?.churchTax ?? false);
      setTaxResidence(holder?.taxResidence ?? "");
      setError(false);
      setConfirmDelete(false);
    }
    setOpen(next);
  }

  async function onDelete() {
    if (!holder) return;
    setBusy(true);
    setError(false);
    try {
      await api.deleteAccountHolder(holder.id);
      router.refresh();
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(false);
    const by = birthYear.trim() !== "" ? Number(birthYear) : null;
    const input = {
      name: trimmed,
      type,
      birthYear: by,
      taxAllowanceAnnual: taxAllowance.trim() !== "" ? taxAllowance.trim() : null,
      capitalGainsTaxRate: taxRate.trim() !== "" ? taxRate.trim() : null,
      churchTax: churchTax,
      taxResidence: taxResidence.trim().toUpperCase() || null,
    };
    try {
      if (mode === "edit" && holder) {
        await api.updateAccountHolder(holder.id, input);
      } else {
        await api.createAccountHolder(input);
      }
      router.refresh();
      onSuccess?.();
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return {
    api,
    router,
    open,
    setOpen,
    onOpenChange,
    name,
    setName,
    type,
    setType,
    birthYear,
    setBirthYear,
    taxAllowance,
    setTaxAllowance,
    taxRate,
    setTaxRate,
    churchTax,
    setChurchTax,
    taxResidence,
    setTaxResidence,
    busy,
    error,
    confirmDelete,
    setConfirmDelete,
    onDelete,
    submit,
  };
}
