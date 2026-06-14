"use client";

import {
  AddTransactionForm,
  type AddTransactionInitial,
} from "@/components/add-transaction-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: updates the transaction, then returns to the list. */
export function EditTransaction({
  portfolioId,
  txId,
  initial,
}: {
  portfolioId: string;
  txId: string;
  initial: AddTransactionInitial;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AddTransactionForm
      client={api}
      portfolioId={portfolioId}
      transactionId={txId}
      initial={initial}
      onSuccess={() => {
        router.push("/transactions");
        router.refresh();
      }}
    />
  );
}
