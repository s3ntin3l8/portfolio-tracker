"use client";

import { useTranslations, useLocale } from "next-intl";
import type { IncomeEvent, UpcomingPayment } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

/** Unified row type: historical events + upcoming payments merged into one table. */
export type IncomeEventRow = IncomeEvent & {
  status?: UpcomingPayment["status"];
  growthApplied?: number;
  assumesContributions?: boolean;
  perShare?: string;
  quantity?: string;
};

const COLS: ColDef<IncomeEventRow>[] = [
  { key: "date", get: (e) => e.date, type: "date" },
  { key: "type", get: (e) => e.status ?? e.type, type: "text" },
  { key: "instrument", get: (e) => e.symbol ?? "", type: "text" },
  { key: "perShare", get: (e) => e.perShare ?? "", type: "numeric" },
  { key: "quantity", get: (e) => e.quantity ?? "", type: "numeric" },
  { key: "amount", get: (e) => e.amount, type: "numeric" },
];

// Certainty order: projected (estimate) → grown (growth-adjusted estimate)
//   → announced (declared) → paid (settled).
const STATUS_VARIANT: Record<string, "default" | "warning" | "success" | "outline"> = {
  projected: "outline",
  grown: "outline",
  scheduled: "default",
  announced: "warning",
  paid: "success",
};

export function IncomeEventsTable({ rows }: { rows: IncomeEventRow[] }) {
  const t = useTranslations("Income");
  const tt = useTranslations("TxType");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const { sortKey, sortDir, toggle, sort } = useTableSort<IncomeEventRow>(COLS);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="date" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("date")}</SortableTableHead>
          <SortableTableHead colKey="type" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("type")}</SortableTableHead>
          <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("instrument")}</SortableTableHead>
          <SortableTableHead colKey="perShare" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="hidden sm:table-cell">{t("perShare")}</SortableTableHead>
          <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="hidden sm:table-cell">{t("shares")}</SortableTableHead>
          <SortableTableHead colKey="amount" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("amount")}</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sort(rows).map((e, i) => (
          <TableRow
            key={`${e.instrumentId}-${e.date}-${i}`}
            className={e.status ? "text-muted-foreground" : undefined}
          >
            <TableCell className="tabular whitespace-nowrap text-muted-foreground">
              {df.format(new Date(e.date))}
            </TableCell>
            <TableCell>
              {e.status ? (
                <div className="flex flex-col gap-1">
                  <Badge variant={STATUS_VARIANT[e.status] ?? "outline"}>
                    {t(e.status)}
                  </Badge>
                  {e.growthApplied !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {t("growthHint", {
                        pct: `${e.growthApplied >= 1 ? "+" : ""}${((e.growthApplied - 1) * 100).toFixed(1)}%`,
                      })}
                    </span>
                  )}
                  {e.assumesContributions && (
                    <span className="text-xs text-muted-foreground">
                      {t("contributionsHint")}
                    </span>
                  )}
                </div>
              ) : (
                <Badge variant="default">{tt(e.type)}</Badge>
              )}
            </TableCell>
            <TableCell>
              <div className="font-medium">{e.symbol ?? "—"}</div>
              {e.name && (
                <div className="text-xs text-muted-foreground">{e.name}</div>
              )}
            </TableCell>
            <TableCell className="hidden sm:table-cell tabular text-right text-muted-foreground">
              {e.perShare != null
                ? formatMoney(Number(e.perShare), e.currency, locale)
                : "—"}
            </TableCell>
            <TableCell className="hidden sm:table-cell tabular text-right text-muted-foreground">
              {e.quantity != null
                ? Number(e.quantity).toLocaleString(locale, { maximumFractionDigits: 4 })
                : "—"}
            </TableCell>
            <TableCell className={`tabular text-right ${Number(e.amount) >= 0 ? "text-success" : "text-destructive"}`}>
              {formatMoney(Number(e.amount), e.currency, locale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
