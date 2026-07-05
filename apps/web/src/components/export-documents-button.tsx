"use client";

import { useState } from "react";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiClient } from "@/lib/api";

/**
 * Downloads all retained documents for a portfolio as a structured zip archive.
 * Each entry carries a date-first filename that makes its contents immediately
 * identifiable (e.g. `2024-03-15_DKB-Depot_buy_VTI.pdf`).
 *
 * Only shown when a single portfolio is selected (bulk export is per-portfolio).
 */
export function ExportDocumentsButton({
  portfolioId,
  portfolioName,
  label,
  iconOnly = false,
}: {
  portfolioId: string;
  portfolioName: string;
  label: string;
  /** Render as a plain icon button; `label` stays the accessible name + native tooltip. */
  iconOnly?: boolean;
}) {
  const api = useApiClient();
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const blob = await api.exportPortfolioDocuments(portfolioId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${portfolioName.replace(/[^\w-]/g, "-")}_documents.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // No documents — silently ignore (endpoint returns 404 when empty).
    } finally {
      setLoading(false);
    }
  }

  if (iconOnly) {
    return (
      <Button
        variant="outline"
        size="icon"
        onClick={handleExport}
        disabled={loading}
        aria-label={label}
        title={label}
      >
        <Archive className="size-4" />
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={handleExport} disabled={loading}>
      <Archive className="size-4" />
      {label}
    </Button>
  );
}
