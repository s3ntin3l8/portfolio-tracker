"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toCsv } from "@/lib/csv";

/**
 * Downloads the given rows as a CSV file, built entirely client-side from data
 * already on the page (no API round-trip). Disabled when there's nothing to export.
 *
 * The reference design shows export as a plain icon button (no visible label) in a
 * page's header — `iconOnly` renders that variant; `label` is always kept as the
 * accessible name (tooltip/aria-label) even when hidden visually.
 */
export function ExportCsvButton({
  filename,
  headers,
  rows,
  label,
  iconOnly = false,
}: {
  filename: string;
  headers: string[];
  rows: (string | number)[][];
  label: string;
  iconOnly?: boolean;
}) {
  function download() {
    const blob = new Blob([toCsv(headers, rows)], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (iconOnly) {
    return (
      <Button
        variant="outline"
        size="icon"
        onClick={download}
        disabled={rows.length === 0}
        aria-label={label}
        title={label}
      >
        <Download className="size-4" />
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={download} disabled={rows.length === 0}>
      <Download className="size-4" />
      {label}
    </Button>
  );
}
