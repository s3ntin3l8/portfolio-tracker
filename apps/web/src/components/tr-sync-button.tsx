"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Icon button that triggers a Trade Republic sync and refreshes the page on completion.
 * Errors are silenced on the card; the user can open the portfolio dialog for details.
 * Only render this component when the TR connection status is `connected`.
 */
export function TrSyncButton() {
  const t = useTranslations("TradeRepublic");
  const api = useApiClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSync() {
    if (busy) return;
    setBusy(true);
    try {
      await api.syncTr();
      router.refresh();
    } catch {
      // Sync errors are surfaced in the portfolio dialog (TrConnectFlow); silenced here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={t("syncNow")}
      onClick={handleSync}
      disabled={busy}
    >
      <RefreshCw className={`size-4${busy ? " animate-spin" : ""}`} />
    </Button>
  );
}
