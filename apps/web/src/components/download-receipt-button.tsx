"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useApiClient } from "@/lib/api";

/**
 * Download-receipt button for the transaction edit page (#231).
 * Opens the signed source-document URL in a new tab.
 */
export function DownloadReceiptButton({
  portfolioId,
  txId,
}: {
  portfolioId: string;
  txId: string;
}) {
  const t = useTranslations("Manage");
  const api = useApiClient();

  async function handleClick() {
    try {
      const { url } = await api.getTransactionDocumentUrl(portfolioId, txId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Silently ignore — document may have been deleted or storage unavailable.
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick}>
      <Download className="size-4" />
      {t("downloadReceipt")}
    </Button>
  );
}
