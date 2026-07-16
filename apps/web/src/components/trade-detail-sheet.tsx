"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Trade } from "@portfolio/api-client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { monogram, tintFor } from "@/lib/brokerages";
import { formatMoney, formatPercent, formatSignedMoney, formatQuantity, cn } from "@/lib/utils";

interface TradeDetailSheetProps {
  /** The closed trade to show detail for; null renders nothing. Only closed trades are
   *  expected here — open positions have no exit date/price and keep the table's inline
   *  leg-expansion instead (see `TradesTable`). */
  trade: Trade | null;
  /** Display currency — matches every money field on `Trade` except avgEntryPrice/
   *  avgExitPrice, which are in the trade's own (cost) currency. */
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Row({
  label,
  value,
  divider,
  bold,
  tone,
}: {
  label: string;
  value: string;
  divider?: boolean;
  bold?: boolean;
  tone?: "up" | "down" | "neutral";
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3",
        divider && "border-t border-border",
      )}
    >
      <span
        className={cn("text-sm", bold ? "font-semibold text-foreground" : "text-muted-foreground")}
      >
        {label}
      </span>
      <span
        className={cn(
          "tabular text-sm",
          bold ? "font-extrabold" : "font-semibold",
          tone === "up" && "text-success",
          tone === "down" && "text-destructive",
          !tone && !bold && "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Trade detail bottom sheet — mirrors `TransactionDetailSheet`'s `Sheet` pattern
 * (same primitive, same bottom-sheet-on-mobile/side-sheet-on-desktop chrome). Content
 * transcribed from `TradesScreen.dc.html`'s `td` object: header, a Realized P&L hero,
 * a Breakdown card, a Trade details card, and an optional Income-while-held card.
 *
 * Deviation from the design: the mock's Breakdown has a 4th "Fees" row (Proceeds − Cost
 * − Fees = Realized). `Trade`/`TradeLeg` don't carry a currency-safe standalone fee
 * figure — fees are already netted into `TradeLeg.cost` (buy side) and `TradeLeg.proceeds`
 * (sell side), and `avgEntryPrice`/`avgExitPrice` are in the trade's own currency rather
 * than the display currency used everywhere else, so back-deriving a fee amount for
 * cross-currency trades would be a currency-unsafe guess. Rendered as 3 rows instead
 * (Proceeds, Cost basis, Realized P&L) — still exact (Proceeds − Cost = Realized).
 *
 * Also: every colored field in the sheet (hero, breakdown P&L, Return, Annualized, Total
 * return incl. income) shares ONE tone derived from the sign of `realizedPnL` — matching
 * the design's own `td.color`/`td.totalColor` reuse — rather than each field coloring by
 * its own sign.
 */
export function TradeDetailSheet({ trade, currency, open, onOpenChange }: TradeDetailSheetProps) {
  const t = useTranslations("Trades");
  const locale = useLocale();

  if (!trade) return null;

  const symbol = trade.instrument?.symbol ?? trade.instrumentId.slice(0, 8);
  const name = trade.instrument?.name ?? "";

  const realized = Number(trade.realizedPnL);
  const tone: "up" | "down" = realized >= 0 ? "up" : "down";
  const invested = Number(trade.invested);
  const realizedPct = invested > 0 ? realized / invested : null;

  const proceedsTotal = trade.legs.reduce((s, l) => s + Number(l.proceeds), 0);
  const costTotal = trade.legs.reduce((s, l) => s + Number(l.cost), 0);

  const heldLabel = (days: number) =>
    days >= 365 ? `${(days / 365).toFixed(1)}${t("yearsAbbr")}` : `${days}${t("daysAbbr")}`;

  const money = (n: number) => formatMoney(n, currency, locale);
  const signed = (n: number) => formatSignedMoney(n, currency, locale);
  const pct = (n: number | null) => (n !== null ? formatPercent(n, locale) : "—");

  const hasDividends = Number(trade.dividends) > 0;

  // handleOnly: see transaction-detail-sheet.tsx — same nested-scroll-container fix (#472).
  return (
    <Sheet open={open} onOpenChange={onOpenChange} handleOnly>
      <SheetContent className="p-0" side="bottom">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="flex items-center gap-3">
            <span
              className="flex size-11 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold text-white"
              style={{ backgroundColor: tintFor(symbol) }}
              aria-hidden
            >
              {monogram(symbol)}
            </span>
            <span>{symbol}</span>
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            {name ? `${name} · ` : ""}
            {t("detail.closed", { date: trade.exitDate ?? "—" })}
          </p>
        </SheetHeader>

        <div className="overflow-y-auto px-6 pb-6 pt-2">
          {/* Hero */}
          <div className="py-4 text-center">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {t("detail.realizedPnl")}
            </p>
            <p
              className={cn(
                "tabular mt-1 text-4xl font-extrabold",
                tone === "up" ? "text-success" : "text-destructive",
              )}
            >
              {signed(realized)}
            </p>
            <p className="mt-2">
              <span
                className={cn(
                  "tabular inline-block rounded-full bg-muted px-3 py-1 text-xs font-bold",
                  tone === "up" ? "text-success" : "text-destructive",
                )}
              >
                {pct(realizedPct)} · {heldLabel(trade.holdingDays)} {t("detail.held")}
              </span>
            </p>
          </div>

          {/* Breakdown */}
          <h3 className="mb-2 mt-2 px-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {t("detail.breakdown")}
          </h3>
          <div className="overflow-hidden rounded-2xl border border-border">
            <Row label={t("detail.proceeds")} value={money(proceedsTotal)} />
            <Row label={t("detail.costBasis")} value={`− ${money(costTotal)}`} divider />
            <Row
              label={t("detail.realizedPnlRow")}
              value={signed(realized)}
              bold
              tone={tone}
              divider
            />
          </div>

          {/* Trade details */}
          <h3 className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {t("detail.tradeDetails")}
          </h3>
          <div className="overflow-hidden rounded-2xl border border-border">
            <Row
              label={t("detail.quantity")}
              value={formatQuantity(Number(trade.quantity), trade.instrument?.unit, locale)}
            />
            <Row
              label={t("detail.avgBuyPrice")}
              value={formatMoney(Number(trade.avgEntryPrice), trade.currency, locale)}
              divider
            />
            <Row
              label={t("detail.avgSellPrice")}
              value={
                trade.avgExitPrice !== null
                  ? formatMoney(Number(trade.avgExitPrice), trade.currency, locale)
                  : "—"
              }
              divider
            />
            <Row label={t("detail.bought")} value={trade.entryDate} divider />
            <Row label={t("detail.sold")} value={trade.exitDate ?? "—"} divider />
            <Row label={t("detail.holdingPeriod")} value={heldLabel(trade.holdingDays)} divider />
            <Row label={t("detail.return")} value={pct(realizedPct)} tone={tone} divider />
            <Row label={t("annualized")} value={pct(trade.annualizedPct)} tone={tone} divider />
          </div>

          {/* Income while held — only when the trade collected a dividend */}
          {hasDividends && (
            <>
              <h3 className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                {t("detail.incomeWhileHeld")}
              </h3>
              <div className="overflow-hidden rounded-2xl border border-border">
                <Row
                  label={t("detail.dividendsCollected")}
                  value={money(Number(trade.dividends))}
                  tone="up"
                />
                <Row
                  label={t("detail.totalReturnIncome")}
                  value={`${signed(Number(trade.totalReturn))} · ${pct(trade.totalReturnPct)}`}
                  bold
                  tone={tone}
                  divider
                />
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
