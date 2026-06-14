import { getTranslations, setRequestLocale } from "next-intl/server";
import { ScanLine, FileSpreadsheet, PencilLine } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import { transactions } from "@/lib/mock-data";

const SOURCE_ICON = {
  screenshot: ScanLine,
  csv: FileSpreadsheet,
  manual: PencilLine,
} as const;

const TYPE_VARIANT = {
  buy: "success",
  sell: "destructive",
  dividend: "default",
  deposit: "default",
} as const;

export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Transactions");
  const tt = await getTranslations("TxType");
  const m = (n: number) => formatMoney(n, "IDR", locale);
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

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
              const Icon = SOURCE_ICON[tx.source];
              const amount = tx.quantity > 0 ? tx.quantity * tx.price : tx.price;
              return (
                <TableRow key={tx.id}>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {df.format(new Date(tx.date))}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANT[tx.type]}>{tt(tx.type)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{tx.symbol}</div>
                    <div className="text-xs text-muted-foreground">{tx.name}</div>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {tx.quantity || "—"}
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
