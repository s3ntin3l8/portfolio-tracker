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
};

const COLS: ColDef<IncomeEventRow>[] = [
  { key: "date", get: (e) => e.date, type: "date" },
  { key: "type", get: (e) => e.status ?? e.type, type: "text" },
  { key: "instrument", get: (e) => e.symbol ?? "", type: "text" },
  { key: "amount", get: (e) => e.amount, type: "numeric" },
];

const STATUS_VARIANT: Record<string, "default" | "warning" | "success" | "outline"> = {
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
          <SortableTableHead colKey="amount" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="text-right">{t("amount")}</SortableTableHead>
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
                <Badge variant={STATUS_VARIANT[e.status] ?? "outline"}>
                  {t(e.status)}
                </Badge>
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
            <TableCell className="tabular text-right text-success">
              {formatMoney(Number(e.amount), e.currency, locale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
