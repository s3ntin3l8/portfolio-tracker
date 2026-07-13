"use client";

import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AddTransactionForm,
  type AddTransactionInitial,
} from "@/components/add-transaction-form";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import type { TxRow } from "@/components/transactions-table";

/** Build the edit form's prefill from a table row (which carries the full transaction at
 *  runtime, even though `TxRow` only types a subset). */
function toInitial(tx: TxRow): AddTransactionInitial {
  return {
    type: tx.type,
    instrumentId: tx.instrumentId ?? null,
    instrument: tx.instrument
      ? {
          symbol: tx.instrument.symbol ?? "",
          name: tx.instrument.name ?? "",
          assetClass: tx.instrument.assetClass ?? "equity",
          unit: tx.instrument.unit ?? "shares",
        }
      : null,
    quantity: tx.quantity,
    price: tx.price,
    fees: tx.fees,
    tax: tx.tax,
    fxRate: tx.fxRate,
    description: tx.description ?? null,
    tags: tx.tags ?? null,
    currency: tx.currency,
    executedAt: tx.executedAt,
    sources: tx.sources,
    hasFullTaxDetail: tx.hasFullTaxDetail,
    kind: tx.kind ?? null,
    source: tx.source,
    externalId: tx.externalId,
  };
}

/**
 * Edit a transaction inside a bottom sheet (reference: editing reuses the manual-entry
 * sheet titled "Edit transaction"), instead of navigating to the standalone edit page.
 * On save it closes and refreshes the list in place.
 */
export function EditTransactionSheet({
  tx,
  open,
  onOpenChange,
  onSaved,
}: {
  tx: TxRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const api = useApiClient();
  const router = useRouter();
  const tm = useTranslations("Manage.tx");

  return (
    // handleOnly: the form scrolls in a nested container, so drag-to-close is restricted
    // to the handle rather than fighting the form's own scroll (#472).
    <Sheet open={open} onOpenChange={onOpenChange} handleOnly>
      <SheetContent side="bottom" className="p-0">
        <SheetHeader className="px-5 pb-1 pt-1">
          <SheetTitle className="text-[19px]">{tm("editTitle")}</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-5 pb-7 pt-3">
          {tx && (
            <AddTransactionForm
              client={api}
              portfolioId={tx.portfolioId}
              transactionId={tx.id}
              initial={toInitial(tx)}
              stickyFooter
              onSuccess={() => {
                onOpenChange(false);
                onSaved?.();
                router.refresh();
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
