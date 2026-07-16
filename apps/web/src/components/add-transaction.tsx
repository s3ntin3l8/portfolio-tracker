"use client";

import { AddTransactionForm, type AddTransactionInitial } from "@/components/add-transaction-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the transaction, then returns to the list. */
export function AddTransaction({
  portfolioId,
  initial,
  stickyFooter = false,
}: {
  portfolioId: string;
  /** Prefill (e.g. a harvest-suggestion sell draft, #harvestInstrument). Not an edit —
   *  no `transactionId` is passed, so the form still creates a new transaction. */
  initial?: AddTransactionInitial;
  /** See `AddTransactionForm` — sheet contexts only. */
  stickyFooter?: boolean;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AddTransactionForm
      client={api}
      portfolioId={portfolioId}
      initial={initial}
      stickyFooter={stickyFooter}
      onSuccess={() => {
        router.push("/transactions");
        router.refresh();
      }}
    />
  );
}
