"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  PortfolioPicker,
  type PickablePortfolio,
} from "@/components/portfolio-picker";
import { AddTransaction } from "@/components/add-transaction";
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
export function NewEntryTabs({
  portfolios,
  initialPortfolioId,
  defaultTab = "transaction",
}: {
  portfolios: PickablePortfolio[];
  initialPortfolioId: string;
  defaultTab?: NewEntryTab;
}) {
  const tt = useTranslations("Manage.tx");
  const tca = useTranslations("CorpAction");
  const tmg = useTranslations("Merger");
  const [portfolioId, setPortfolioId] = useState(initialPortfolioId);

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

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="transaction">{tt("tabTransaction")}</TabsTrigger>
        <TabsTrigger value="corporate-action">{tca("link")}</TabsTrigger>
        <TabsTrigger value="merger">{tmg("link")}</TabsTrigger>
      </TabsList>
      <TabsContent value="transaction" className="space-y-4">
        {picker}
        <AddTransaction portfolioId={portfolioId} />
      </TabsContent>
      <TabsContent value="corporate-action">
        <RecordCorporateAction />
      </TabsContent>
      <TabsContent value="merger" className="space-y-4">
        {picker}
        <RecordMerger portfolioId={portfolioId} />
      </TabsContent>
    </Tabs>
  );
}
