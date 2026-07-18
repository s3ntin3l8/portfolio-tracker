"use client";

import { ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import type { TaxDisposalLot, TaxDisposalRow } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import type { TaxTranslator } from "./tax-cards";

/** The "Disposal" cell for an aggregate row — symbol + sell date, plus (when the
 *  disposal spans more than one FIFO lot) a muted "avg buy → sell · N lots" sub-line
 *  and a chevron affordance. Single-lot disposals render exactly as before. */
export function DisposalCell({
  row,
  money,
  t,
  isOpen,
}: {
  row: TaxDisposalRow;
  money: (n: string | number) => string;
  t: TaxTranslator;
  isOpen: boolean;
}) {
  const hasLots = row.lots.length > 1;
  return (
    <TableCell>
      <div className={cn("relative", hasLots && "pl-4")}>
        {hasLots && (
          <ChevronRight
            className={cn(
              "absolute -left-0.5 top-0.5 size-3.5 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />
        )}
        <span className="font-medium">{row.symbol}</span>{" "}
        <span className="text-xs text-muted-foreground">{row.when}</span>
        {hasLots && (
          <div className="text-xs text-muted-foreground">
            {t("disposals.lotsLine", {
              buy: money(row.avgBuyPrice),
              sell: money(row.sellPrice),
              count: row.lots.length,
            })}
          </div>
        )}
      </div>
    </TableCell>
  );
}

/** One consumed FIFO lot, rendered under its expanded aggregate row. `secondaryValue`
 *  is already money-formatted — the German table passes the lot's gain, the
 *  Indonesian table passes the lot's proceeds-based 0.1% tax share. */
export function LotRow({
  lot,
  money,
  secondaryValue,
  secondaryClassName,
}: {
  lot: TaxDisposalLot;
  money: (n: string | number) => string;
  secondaryValue: string;
  secondaryClassName?: string;
}) {
  return (
    <TableRow className="bg-muted/40 text-xs hover:bg-muted/40">
      <TableCell className="pl-9 text-muted-foreground">
        {lot.acqDate} · {lot.quantity} @ {money(lot.buyPrice)} → {money(lot.sellPrice)}
      </TableCell>
      <TableCell className="tabular text-right text-muted-foreground">
        {money(lot.proceeds)}
      </TableCell>
      <TableCell className={cn("tabular text-right", secondaryClassName)}>
        {secondaryValue}
      </TableCell>
    </TableRow>
  );
}
