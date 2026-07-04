import { Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The Instrument-detail "Income from this position" card: a lifetime dividends/coupons
 * figure plus a yield-on-cost mini-stat, or an empty message when the position has never
 * paid income. Pure presentation — the page passes already-translated/formatted strings
 * (mirrors how the rest of this server-rendered page composes `StatCard` etc.) so this
 * needs no client boundary of its own.
 */
export function InstrumentIncomeCard({
  title,
  dividendsReceived,
  receivedCaption,
  emptyMessage,
  yieldOnCost,
  yieldTitle,
  yieldCaption,
}: {
  title: string;
  /** Formatted lifetime dividends/coupons received for this instrument, or null when the
   *  position has never paid income (renders `emptyMessage` instead). */
  dividendsReceived: string | null;
  receivedCaption: string;
  emptyMessage: string;
  /** Formatted yield-on-cost, or null when it isn't computable (e.g. zero cost basis). */
  yieldOnCost: string | null;
  yieldTitle: string;
  yieldCaption: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {dividendsReceived !== null ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="tabular text-2xl font-extrabold text-success">
                {dividendsReceived}
              </span>
              <span className="text-xs text-muted-foreground">{receivedCaption}</span>
            </div>
            {yieldOnCost !== null && (
              <div className="mt-3.5 flex items-center gap-2.5 rounded-xl bg-muted/50 px-3.5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <Coins className="size-4.5" />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold">{yieldTitle}</p>
                  <p className="text-[11px] text-muted-foreground">{yieldCaption}</p>
                </div>
                <span className="tabular text-sm font-bold text-success">{yieldOnCost}</span>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        )}
      </CardContent>
    </Card>
  );
}
