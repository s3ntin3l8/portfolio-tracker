"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ScanLine,
  FileSpreadsheet,
  PencilLine,
  Landmark,
  Pencil,
  Loader2,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteTransactionButton } from "@/components/delete-transaction-button";
import { Link, useRouter } from "@/i18n/navigation";
import { useApiClient } from "@/lib/api";
import { formatMoney } from "@/lib/utils";

const SOURCE_ICON: Record<string, LucideIcon> = {
  screenshot: ScanLine,
  csv: FileSpreadsheet,
  manual: PencilLine,
  pytr: Landmark,
};

const TYPE_VARIANT: Record<string, "success" | "destructive" | "default"> = {
  buy: "success",
  sell: "destructive",
};

export interface TxRow {
  id: string;
  portfolioId: string;
  portfolioName?: string;
  type: string;
  quantity: string;
  price: string;
  executedAt: string;
  source: string;
  instrument: { symbol?: string | null; name?: string | null } | null;
}

/**
 * Transactions table with row selection and batch delete. When `showPortfolio` is set
 * (the aggregate "All portfolios" view) a Portfolio column is shown and a batch delete
 * is fanned out per portfolio, since the delete endpoint is portfolio-scoped.
 */
export function TransactionsTable({
  rows,
  showPortfolio = false,
}: {
  rows: TxRow[];
  showPortfolio?: boolean;
}) {
  const t = useTranslations("Transactions");
  const tt = useTranslations("TxType");
  const tm = useTranslations("Manage");
  const tb = useTranslations("Transactions.batch");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const m = (n: number) => formatMoney(n, "IDR", locale);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function onBatchDelete() {
    setBusy(true);
    try {
      // Group by portfolio — the delete endpoint is scoped to one portfolio.
      const byPortfolio = new Map<string, string[]>();
      for (const r of rows) {
        if (!selected.has(r.id)) continue;
        const ids = byPortfolio.get(r.portfolioId) ?? [];
        ids.push(r.id);
        byPortfolio.set(r.portfolioId, ids);
      }
      await Promise.all(
        [...byPortfolio.entries()].map(([portfolioId, ids]) =>
          api.bulkDeleteTransactions(portfolioId, ids),
        ),
      );
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const colSpan = showPortfolio ? 8 : 7;

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {tb("selected", { count: selected.size })}
          </span>
          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">{tb("confirmPrompt")}</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={onBatchDelete}
                disabled={busy}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {tb("confirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                {tb("cancel")}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
              {tb("delete")}
            </Button>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={tb("selectAll")}
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </TableHead>
              <TableHead>{t("date")}</TableHead>
              <TableHead>{t("type")}</TableHead>
              <TableHead>{t("instrument")}</TableHead>
              {showPortfolio && <TableHead>{t("portfolio")}</TableHead>}
              <TableHead className="text-right">{t("quantity")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
              <TableHead>{t("source")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tm("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((tx) => {
              const Icon = SOURCE_ICON[tx.source] ?? PencilLine;
              const qty = Number(tx.quantity);
              const price = Number(tx.price);
              const amount = qty > 0 ? qty * price : price;
              const isSelected = selected.has(tx.id);
              return (
                <TableRow key={tx.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={tb("selectRow")}
                      checked={isSelected}
                      onChange={() => toggle(tx.id)}
                    />
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {df.format(new Date(tx.executedAt))}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>
                      {tt(tx.type)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{tx.instrument?.symbol ?? "—"}</div>
                    {tx.instrument?.name && (
                      <div className="text-xs text-muted-foreground">
                        {tx.instrument.name}
                      </div>
                    )}
                  </TableCell>
                  {showPortfolio && (
                    <TableCell className="text-muted-foreground">
                      {tx.portfolioName ?? "—"}
                    </TableCell>
                  )}
                  <TableCell className="tabular text-right">{qty || "—"}</TableCell>
                  <TableCell className="tabular text-right">{m(amount)}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className="size-3.5" />
                      {t(`sources.${tx.source}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        asChild
                        aria-label={tm("edit")}
                      >
                        <Link href={`/transactions/${tx.id}/edit`}>
                          <Pencil className="size-4" />
                        </Link>
                      </Button>
                      <DeleteTransactionButton
                        portfolioId={tx.portfolioId}
                        txId={tx.id}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
