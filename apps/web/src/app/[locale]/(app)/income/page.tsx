import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import {
  loadIncome,
  loadIncomeOutlook,
  type IncomeEvent,
} from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

/** Sum a year's events per currency (income can span currencies). */
function totalsByCurrency(events: IncomeEvent[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of events) {
    totals[e.currency] = (totals[e.currency] ?? 0) + Number(e.amount);
  }
  return totals;
}

export default async function IncomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Income");
  const tt = await getTranslations("TxType");
  const te = await getTranslations("Empty");
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const [result, outlook] = await Promise.all([
    loadIncome(),
    loadIncomeOutlook(),
  ]);
  const upcoming = outlook?.upcoming ?? [];
  const yields = outlook?.yields ?? [];
  const hasOutlook = upcoming.length > 0 || yields.length > 0;

  const heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
    </div>
  );

  if (result.status === "unavailable" || (result.events.length === 0 && !hasOutlook)) {
    const empty = result.status === "empty";
    return (
      <div className="space-y-6">
        {heading}
        <EmptyState
          icon={Coins}
          title={
            result.status === "unavailable"
              ? te("unavailableTitle")
              : empty
                ? te("noPortfolioTitle")
                : t("emptyTitle")
          }
          description={
            result.status === "unavailable"
              ? te("unavailableBody")
              : empty
                ? te("noPortfolioBody")
                : t("emptyBody")
          }
        />
      </div>
    );
  }

  // Group newest-first events by year (events are already sorted desc by date).
  const byYear = new Map<string, IncomeEvent[]>();
  for (const e of result.events) {
    const year = e.date.slice(0, 4);
    let bucket = byYear.get(year);
    if (!bucket) {
      bucket = [];
      byYear.set(year, bucket);
    }
    bucket.push(e);
  }

  return (
    <div className="space-y-8">
      {heading}

      {yields.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("yieldTitle")}</h2>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("instrument")}</TableHead>
                  <TableHead className="text-right">{t("trailing")}</TableHead>
                  <TableHead className="text-right">{t("value")}</TableHead>
                  <TableHead className="text-right">{t("yieldCol")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yields.map((y) => (
                  <TableRow key={y.instrumentId}>
                    <TableCell>
                      <div className="font-medium">{y.symbol}</div>
                      {y.name && (
                        <div className="text-xs text-muted-foreground">
                          {y.name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(Number(y.trailingIncome), y.currency, locale)}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {formatMoney(Number(y.marketValue), y.currency, locale)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {y.yield !== null
                        ? formatPercent(Number(y.yield), locale)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("upcomingTitle")}</h2>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{t("instrument")}</TableHead>
                  <TableHead className="text-right">{t("amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.map((c, i) => (
                  <TableRow key={`${c.instrumentId}-${c.date}-${i}`}>
                    <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                      {df.format(new Date(c.date))}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.symbol}</div>
                      {c.name && (
                        <div className="text-xs text-muted-foreground">
                          {c.name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right text-success">
                      {formatMoney(Number(c.amount), c.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {[...byYear.entries()].map(([year, events]) => {
        const totals = totalsByCurrency(events);
        return (
          <section key={year} className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">{year}</h2>
              <p className="tabular text-sm text-muted-foreground">
                {t("yearTotal")}{" "}
                <span className="font-medium text-foreground">
                  {Object.entries(totals)
                    .map(([currency, amount]) =>
                      formatMoney(amount, currency, locale),
                    )
                    .join(" · ")}
                </span>
              </p>
            </div>

            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("date")}</TableHead>
                    <TableHead>{t("type")}</TableHead>
                    <TableHead>{t("instrument")}</TableHead>
                    <TableHead className="text-right">{t("amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                        {df.format(new Date(e.date))}
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">{tt(e.type)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{e.symbol ?? "—"}</div>
                        {e.name && (
                          <div className="text-xs text-muted-foreground">
                            {e.name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-success">
                        {formatMoney(Number(e.amount), e.currency, locale)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
