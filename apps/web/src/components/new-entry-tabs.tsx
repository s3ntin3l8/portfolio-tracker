"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PortfolioPicker, type PickablePortfolio } from "@/components/portfolio-picker";
import { AddTransaction } from "@/components/add-transaction";
import type { AddTransactionInitial } from "@/components/add-transaction-form";
import { RecordCorporateAction } from "@/components/record-corporate-action";
import { RecordMerger } from "@/components/record-merger";

export type NewEntryTab = "transaction" | "corporate-action" | "merger";

/**
 * Unifies the manual-entry forms behind one tabbed page. A transaction and a merger are
 * portfolio-scoped money events; a corporate action is instrument-global reference data —
 * different forms and endpoints, so they stay separate components, just one entry point.
 *
 * The portfolio picker makes the destination explicit (in the aggregate "All portfolios"
 * scope the page falls back to the first portfolio, which is otherwise invisible). It's the
 * same rich {@link PortfolioPicker} as the app-shell switcher — brokerage icon plus
 * `name · brokerage · accountHolder` — so a plain "Main" vs "Main" is told apart by its
 * broker. Shared by the two portfolio-scoped tabs (transaction, merger), hidden with a
 * single portfolio, and absent from the corporate-action tab (an action is instrument-global).
 */
const ALL_TABS: NewEntryTab[] = ["transaction", "corporate-action", "merger"];

export function NewEntryTabs({
  portfolios,
  initialPortfolioId,
  defaultTab = "transaction",
  initialTransaction,
  stickyFooter = false,
  isAdmin = false,
  isDesktop = false,
  value,
  onValueChange,
  hideTabList = false,
  visibleTabs = ALL_TABS,
}: {
  portfolios: PickablePortfolio[];
  initialPortfolioId: string;
  defaultTab?: NewEntryTab;
  /** Prefill for the Transaction tab (e.g. a harvest-suggestion sell draft from
   *  `/tax`, threaded in via `?harvestInstrument=<id>`). */
  initialTransaction?: AddTransactionInitial;
  /** Pin each tab's submit button in a sticky footer (#472) — the sheet caller
   *  (`add-transaction-menu.tsx`) turns this on; the full `/transactions/new` page leaves
   *  it off (a bottom-pinned bar there would sit under the fixed bottom-nav). */
  stickyFooter?: boolean;
  isAdmin?: boolean;
  /** Desktop modal shell — see `AddTransactionForm`'s `isDesktop`. Threaded through to every
   *  sub-form so their submit buttons/layout match the desktop chrome. */
  isDesktop?: boolean;
  /** Controlled active tab — the desktop nav rail drives this directly instead of the
   *  in-sheet `TabsList` (which is hidden via `hideTabList` on desktop). Uncontrolled
   *  (`defaultTab`) when omitted — mobile's existing behavior. */
  value?: NewEntryTab;
  onValueChange?: (tab: NewEntryTab) => void;
  /** Suppress the in-body segmented tab control — the desktop rail's "Instrument event"
   *  destination hosts corporate-action/merger as a 2-way switch of its own instead. */
  hideTabList?: boolean;
  /** Restrict which tabs are mounted — e.g. the desktop rail's "Add transaction" destination
   *  only ever shows the transaction tab. Defaults to all three (mobile's existing set). */
  visibleTabs?: NewEntryTab[];
}) {
  const tt = useTranslations("Manage.tx");
  const tca = useTranslations("CorpAction");
  const tmg = useTranslations("Merger");
  const [portfolioId, setPortfolioId] = useState(initialPortfolioId);
  const activePortfolio = portfolios.find((p) => p.id === portfolioId) ?? portfolios[0];

  const picker =
    portfolios.length > 1 ? (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium">{tt("portfolioPicker")}</span>
        <PortfolioPicker
          portfolios={portfolios}
          value={portfolioId}
          onChange={setPortfolioId}
          ariaLabel={tt("portfolioPicker")}
          triggerClassName="w-full sm:max-w-xs"
        />
      </div>
    ) : null;

  const tabsProps = value
    ? { value, onValueChange: (v: string) => onValueChange?.(v as NewEntryTab) }
    : { defaultValue: defaultTab };

  return (
    <Tabs {...tabsProps}>
      {/* Full-width, evenly-distributed segmented control (#472 — was left-clustered under
          the shared TabsList's `inline-flex` default). Hidden on desktop, where the nav rail
          (or the events step's own 2-way switch) replaces it. */}
      {!hideTabList && (
        <TabsList className="flex w-full">
          {visibleTabs.includes("transaction") && (
            <TabsTrigger value="transaction" className="flex-1">
              {tt("tabTransaction")}
            </TabsTrigger>
          )}
          {visibleTabs.includes("corporate-action") && (
            <TabsTrigger value="corporate-action" className="flex-1">
              {tca("link")}
            </TabsTrigger>
          )}
          {visibleTabs.includes("merger") && (
            <TabsTrigger value="merger" className="flex-1">
              {tmg("link")}
            </TabsTrigger>
          )}
        </TabsList>
      )}
      {visibleTabs.includes("transaction") && (
        <TabsContent value="transaction" className="space-y-4">
          {picker}
          <AddTransaction
            portfolioId={portfolioId}
            portfolio={activePortfolio}
            initial={initialTransaction}
            stickyFooter={stickyFooter}
            isDesktop={isDesktop}
          />
        </TabsContent>
      )}
      {visibleTabs.includes("corporate-action") && (
        <TabsContent value="corporate-action">
          <RecordCorporateAction
            stickyFooter={stickyFooter}
            isAdmin={isAdmin}
            isDesktop={isDesktop}
          />
        </TabsContent>
      )}
      {visibleTabs.includes("merger") && (
        <TabsContent value="merger" className="space-y-4">
          {picker}
          <RecordMerger
            portfolioId={portfolioId}
            stickyFooter={stickyFooter}
            isDesktop={isDesktop}
          />
        </TabsContent>
      )}
    </Tabs>
  );
}
