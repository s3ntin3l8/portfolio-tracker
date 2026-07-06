import { getTranslations, setRequestLocale } from "next-intl/server";
import { ScrollText } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ReportHeader } from "@/components/report-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TABLE_LABEL, TABLE_VALUE, TABLE_VALUE_STRONG } from "@/components/ui/table";
import { TradesTable } from "@/components/trades-table";
import { TradeMethodToggle } from "@/components/trade-method-toggle";
import { loadTrades, loadPreferences } from "@/lib/server-api";
import { formatMoney, formatPercent, formatSignedMoney, cn } from "@/lib/utils";

type Method = "average" | "fifo";

export default async function TradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ method?: string }>;
}) {
  const { locale } = await params;
  const { method: methodParam } = await searchParams;
  const method: Method = methodParam === "fifo" ? "fifo" : "average";
  setRequestLocale(locale);
  const t = await getTranslations("Trades");
  const te = await getTranslations("Empty");

  // Cost basis is a single global preference (Settings → Investing) — there was
  // never a visible toggle here (only `?costBasis=` reachable by hand-editing the
  // URL), so switching the source has near-zero UX cost.
  const prefs = await loadPreferences();
  const costBasis = prefs?.costBasisMode ?? "purchase_price";

  const result = await loadTrades(method, costBasis);
  const log = result.status === "ok" ? result.data : null;
  const currency = log?.displayCurrency ?? "IDR";
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);

  const Heading = (
    <ReportHeader
      title={t("title")}
      subtitle={t("subtitle")}
      action={
        log ? (
          <TradeMethodToggle
            current={method}
            labelAverage={t("methodAverage")}
            labelFifo={t("methodFifo")}
          />
        ) : undefined
      }
    />
  );

  if (result.status === "unavailable") {
    return (
      <div className="space-y-5">
        {Heading}
        <EmptyState icon={ScrollText} title={te("unavailableTitle")} description={te("unavailableBody")} />
      </div>
    );
  }

  if (!log || log.trades.length === 0) {
    return (
      <div className="space-y-5">
        {Heading}
        <EmptyState
          icon={ScrollText}
          title={result.status === "empty" ? te("noPortfolioTitle") : t("emptyTitle")}
          description={result.status === "empty" ? te("noPortfolioBody") : t("emptyBody")}
        />
      </div>
    );
  }

  const totalReturn = Number(log.totalReturn);
  const returnTone = totalReturn > 0 ? "up" : totalReturn < 0 ? "down" : "neutral";
  // Capital-weighted return across all trades (same formula as per-row totalReturnPct).
  const totalInvested = log.trades.reduce((s, tr) => s + Number(tr.invested), 0);
  const totalReturnPct = totalInvested > 0 ? totalReturn / totalInvested : null;

  // Win/loss split — closed trades only (an open position has no realized outcome yet).
  const closedTrades = log.trades.filter((tr) => tr.status === "closed");
  const winners = closedTrades.filter((tr) => Number(tr.totalReturn) > 0);
  const losers = closedTrades.filter((tr) => Number(tr.totalReturn) < 0);
  const winnersTotal = winners.reduce((s, tr) => s + Number(tr.totalReturn), 0);
  const losersTotal = losers.reduce((s, tr) => s + Number(tr.totalReturn), 0);
  const winLossDenom = winnersTotal + Math.abs(losersTotal);
  const winPct = winLossDenom > 0 ? (winnersTotal / winLossDenom) * 100 : 0;

  const maxAbsYear = Math.max(1, ...log.realizedByYear.map((r) => Math.abs(Number(r.amount))));

  return (
    <div className="space-y-5">
      {Heading}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label={t("totalReturn")}
          value={formatSignedMoney(totalReturn, currency, locale)}
          delta={totalReturnPct !== null ? formatPercent(totalReturnPct, locale) : undefined}
          deltaTone={returnTone}
        />
        <StatCard label={t("totalRealized")} value={money(log.totalRealized)} />
        <StatCard label={t("totalDividends")} value={money(log.totalDividends)} />
        <StatCard
          label={t("winRate")}
          value={log.winRate === null ? "—" : formatPercent(log.winRate, locale).replace("+", "")}
        />
      </div>

      <TradesTable trades={log.trades} currency={currency} />

      {/* ── Realized P&L per year + Win/Loss — reference blocks the tax-lens cards
          below don't replace (kept: real tax-reporting functionality, no mock
          equivalent). ── */}
      {log.realizedByYear.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t("realizedByYearChartTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end justify-around gap-4" style={{ height: 140 }}>
                {log.realizedByYear.map((r) => {
                  const amount = Number(r.amount);
                  const pct = Math.max(4, (Math.abs(amount) / maxAbsYear) * 100);
                  return (
                    <div key={r.year} className="flex h-full flex-1 flex-col items-center gap-1.5">
                      <span
                        className={cn(
                          "tabular text-xs font-bold",
                          amount >= 0 ? "text-success" : "text-destructive",
                        )}
                      >
                        {formatSignedMoney(amount, currency, locale)}
                      </span>
                      <div className="flex w-full flex-1 items-end justify-center">
                        <div
                          className={cn(
                            "w-full max-w-10 rounded-t-[4px]",
                            amount >= 0 ? "bg-success" : "bg-destructive",
                          )}
                          style={{ height: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{r.year}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t("winLossTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="tabular text-3xl font-extrabold">
                {log.winRate === null ? "—" : formatPercent(log.winRate, locale).replace("+", "")}
              </p>
              <p className="text-xs font-medium text-text-2">
                {t("winLossSubtitle", { winners: winners.length, total: closedTrades.length })}
              </p>
              <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-success" style={{ width: `${winPct}%` }} />
                <div className="h-full bg-destructive" style={{ width: `${100 - winPct}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs font-semibold">
                <span className="text-success">
                  {t("winners")} {formatSignedMoney(winnersTotal, currency, locale)}
                </span>
                <span className="text-destructive">
                  {t("losers")} {formatSignedMoney(losersTotal, currency, locale)}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Tax lens ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t("realizedByYear")}</CardTitle>
          </CardHeader>
          <CardContent>
            {log.realizedByYear.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noRealized")}</p>
            ) : (
              <div className="space-y-1">
                {log.realizedByYear.map((r) => (
                  <div key={r.year} className="flex justify-between">
                    <span className={TABLE_LABEL}>{r.year}</span>
                    <span
                      className={cn(
                        TABLE_VALUE_STRONG,
                        Number(r.amount) >= 0 ? "text-success" : "text-destructive",
                      )}
                    >
                      {formatSignedMoney(Number(r.amount), currency, locale)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t("dividendsByYear")}</CardTitle>
          </CardHeader>
          <CardContent>
            {log.dividendsByYear.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noDividends")}</p>
            ) : (
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium text-text-2">
                  <span>{t("year")}</span>
                  <span className="flex gap-6">
                    <span className="w-24 text-right">{t("received")}</span>
                    <span className="w-24 text-right">{t("withholding")}</span>
                  </span>
                </div>
                {log.dividendsByYear.map((d) => (
                  <div key={d.year} className="flex justify-between">
                    <span className={TABLE_LABEL}>{d.year}</span>
                    <span className="flex gap-6">
                      <span className={cn(TABLE_VALUE_STRONG, "w-24")}>{money(d.amount)}</span>
                      <span className={cn(TABLE_VALUE, "w-24 text-text-mute")}>{money(d.tax)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {log.bonusesByYear.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t("bonusesByYear")}</CardTitle>
              <p className="text-xs font-medium text-text-2">{t("bonusesNote")}</p>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {log.bonusesByYear.map((b) => (
                  <div key={b.year} className="flex justify-between">
                    <span className={TABLE_LABEL}>{b.year}</span>
                    <span className={cn(TABLE_VALUE_STRONG, "text-success")}>{money(b.amount)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("taxDisclaimer")}</p>
    </div>
  );
}
