"use client";

import { AddTransactionForm } from "@/components/add-transaction-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the transaction, then returns to the list. */
export function AddTransaction({ portfolioId }: { portfolioId: string }) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AddTransactionForm
      client={api}
      portfolioId={portfolioId}
      onSuccess={() => {
        router.push("/transactions");
        router.refresh();
      }}
    />
  );
}
