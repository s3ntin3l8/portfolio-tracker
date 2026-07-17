import type { ImportRecord } from "@portfolio/api-client";
import type { ColDef } from "@/lib/table-sort";

export const IH_COLS: ColDef<ImportRecord>[] = [
  { key: "parser", get: (r) => r.parser, type: "text" },
  { key: "status", get: (r) => r.status, type: "text" },
  { key: "count", get: (r) => r.count, type: "numeric" },
  { key: "createdAt", get: (r) => r.createdAt, type: "date" },
];

export const STATUS_VARIANT: Record<ImportRecord["status"], "warning" | "success" | "outline"> = {
  draft: "warning",
  confirmed: "success",
  discarded: "outline",
};
