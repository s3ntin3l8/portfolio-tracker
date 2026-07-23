"use client";

import { AddTransactionForm, type AddTransactionInitial } from "@/components/add-transaction-form";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/** Real-client wrapper: records the transaction, then returns to the list. */
export function AddTransaction({
  portfolioId,
  portfolio,
  initial,
  stickyFooter = false,
  isDesktop = false,
}: {
  portfolioId: string;
  /** The full selected-portfolio object (name/brokerage/holder) — only needed for the
   *  desktop Summary rail's portfolio row; the form itself still submits by `portfolioId`. */
  portfolio?: PickablePortfolio;
  /** Prefill (e.g. a harvest-suggestion sell draft, #harvestInstrument). Not an edit —
   *  no `transactionId` is passed, so the form still creates a new transaction. */
  initial?: AddTransactionInitial;
  /** See `AddTransactionForm` — sheet contexts only. */
  stickyFooter?: boolean;
  isDesktop?: boolean;
}) {
  const api = useApiClient();
  const router = useRouter();
  return (
    <AddTransactionForm
      client={api}
      portfolioId={portfolioId}
      portfolio={portfolio}
      initial={initial}
      stickyFooter={stickyFooter}
      isDesktop={isDesktop}
      onSuccess={() => {
        router.push("/transactions");
        router.refresh();
      }}
    />
  );
}
