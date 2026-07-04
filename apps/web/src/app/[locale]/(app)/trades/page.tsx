import { getTranslations, setRequestLocale } from "next-intl/server";
import { ScrollText } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent } from "@/components/ui/card";
import { TradesTable } from "@/components/trades-table";
import { TradeMethodToggle } from "@/components/trade-method-toggle";
import { loadTrades, loadPreferences } from "@/lib/server-api";
import { formatMoney, formatPercent, formatSignedMoney } from "@/lib/utils";

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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {log && (
        <TradeMethodToggle
          current={method}
          labelAverage={t("methodAverage")}
          labelFifo={t("methodFifo")}
        />
      )}
    </div>
  );

  if (result.status === "unavailable") {
    return (
      <div className="space-y-6">
        {Heading}
        <EmptyState icon={ScrollText} title={te("unavailableTitle")} description={te("unavailableBody")} />
      </div>
    );
  }

  if (!log || log.trades.length === 0) {
    return (
      <div className="space-y-6">
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

  return (
    <div className="space-y-6">
      {Heading}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      {/* ── Tax lens ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-5">
            <h2 className="text-sm font-semibold">{t("realizedByYear")}</h2>
            {log.realizedByYear.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noRealized")}</p>
            ) : (
              <div className="space-y-1">
                {log.realizedByYear.map((r) => (
                  <div key={r.year} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{r.year}</span>
                    <span className={Number(r.amount) >= 0 ? "tabular text-success" : "tabular text-destructive"}>
                      {formatSignedMoney(Number(r.amount), currency, locale)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <h2 className="text-sm font-semibold">{t("dividendsByYear")}</h2>
            {log.dividendsByYear.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noDividends")}</p>
            ) : (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{t("year")}</span>
                  <span className="flex gap-6">
                    <span className="w-24 text-right">{t("received")}</span>
                    <span className="w-24 text-right">{t("withholding")}</span>
                  </span>
                </div>
                {log.dividendsByYear.map((d) => (
                  <div key={d.year} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{d.year}</span>
                    <span className="flex gap-6 tabular">
                      <span className="w-24 text-right">{money(d.amount)}</span>
                      <span className="w-24 text-right text-muted-foreground">{money(d.tax)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {log.bonusesByYear.length > 0 && (
          <Card>
            <CardContent className="space-y-3 p-5">
              <h2 className="text-sm font-semibold">{t("bonusesByYear")}</h2>
              <p className="text-xs text-muted-foreground">{t("bonusesNote")}</p>
              <div className="space-y-1">
                {log.bonusesByYear.map((b) => (
                  <div key={b.year} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{b.year}</span>
                    <span className="tabular text-success">{money(b.amount)}</span>
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
