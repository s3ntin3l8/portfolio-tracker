import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  ScanLine,
  FileSpreadsheet,
  PencilLine,
  Landmark,
  Receipt,
  Plus,
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
import { EmptyState } from "@/components/empty-state";
import { Link } from "@/i18n/navigation";
import { loadPortfolio } from "@/lib/server-api";
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

export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Transactions");
  const tt = await getTranslations("TxType");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");
  const m = (n: number) => formatMoney(n, "IDR", locale);
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const result = await loadPortfolio((api, portfolio) =>
    api.listTransactions(portfolio.id),
  );

  const addButton = (
    <Button asChild>
      <Link href="/transactions/new">
        <Plus className="size-4" />
        {tm("addTransaction")}
      </Link>
    </Button>
  );

  const heading = (action?: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {action}
    </div>
  );

  if (result.status === "unavailable") {
    return (
      <div className="space-y-6">
        {heading()}
        <EmptyState
          icon={Receipt}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      </div>
    );
  }

  // Newest first.
  const transactions =
    result.status === "ok"
      ? [...result.data].sort((a, b) => b.executedAt.localeCompare(a.executedAt))
      : [];

  if (transactions.length === 0) {
    const isEmptyPortfolio = result.status === "empty";
    return (
      <div className="space-y-6">
        {heading()}
        <EmptyState
          icon={Receipt}
          title={isEmptyPortfolio ? te("noPortfolioTitle") : te("noTransactionsTitle")}
          description={
            isEmptyPortfolio ? te("noPortfolioBody") : te("noTransactionsBody")
          }
          action={
            <Button asChild>
              <Link href="/transactions/new">
                <Plus className="size-4" />
                {isEmptyPortfolio ? tm("createPortfolio") : tm("addTransaction")}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {heading(addButton)}

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("date")}</TableHead>
              <TableHead>{t("type")}</TableHead>
              <TableHead>{t("instrument")}</TableHead>
              <TableHead className="text-right">{t("quantity")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
              <TableHead>{t("source")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((tx) => {
              const Icon = SOURCE_ICON[tx.source] ?? PencilLine;
              const qty = Number(tx.quantity);
              const price = Number(tx.price);
              const amount = qty > 0 ? qty * price : price;
              return (
                <TableRow key={tx.id}>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {df.format(new Date(tx.executedAt))}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANT[tx.type] ?? "default"}>
                      {tt(tx.type)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {tx.instrument?.symbol ?? "—"}
                    </div>
                    {tx.instrument?.name && (
                      <div className="text-xs text-muted-foreground">
                        {tx.instrument.name}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {qty || "—"}
                  </TableCell>
                  <TableCell className="tabular text-right">{m(amount)}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className="size-3.5" />
                      {t(`sources.${tx.source}`)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
