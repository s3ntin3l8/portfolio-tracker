"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Archive, ArchiveRestore, CircleSlash, Loader2, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import type { TransactionStatus } from "@portfolio/api-client";

/**
 * Per-row control to set a transaction's visibility status: keep it Active, Archive it
 * (ignored in every derivation — for phantom rows the feed produced), or mark it
 * Cash-neutral (keeps the shares but contributes no cash — for reward-funded buys whose
 * funding leg the feed omits). Persists via the API and refreshes derived figures.
 */
export function TransactionStatusButton({
  portfolioId,
  txId,
  status,
  onChanged,
}: {
  portfolioId: string;
  txId: string;
  status: TransactionStatus;
  onChanged?: () => void;
}) {
  const t = useTranslations("Manage.status");
  const api = useApiClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function set(next: TransactionStatus) {
    if (next === status || busy) return;
    setBusy(true);
    try {
      await api.setTransactionStatus(portfolioId, txId, next);
      router.refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")} disabled={busy}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MoreVertical className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => set("normal")} disabled={status === "normal"}>
          <ArchiveRestore className="size-4" />
          {t("normal")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => set("archived")} disabled={status === "archived"}>
          <Archive className="size-4" />
          {t("archived")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => set("cash_neutral")}
          disabled={status === "cash_neutral"}
        >
          <CircleSlash className="size-4" />
          {t("cashNeutral")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
