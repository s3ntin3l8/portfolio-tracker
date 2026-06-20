"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select } from "@/components/ui/select";
import { AddTransaction } from "@/components/add-transaction";
import { RecordCorporateAction } from "@/components/record-corporate-action";

export type NewEntryTab = "transaction" | "corporate-action";

/**
 * Unifies the two manual-entry forms behind one tabbed page. A transaction is a
 * portfolio-scoped money event; a corporate action is instrument-global reference data —
 * different forms and endpoints, so they stay separate components, just one entry point.
 *
 * The portfolio picker makes the transaction's destination explicit (in the aggregate
 * "All portfolios" scope the page falls back to the first portfolio, which is otherwise
 * invisible). It's hidden with a single portfolio, and absent from the corporate-action
 * tab — corporate actions are instrument-global, not portfolio-scoped.
 */
export function NewEntryTabs({
  portfolios,
  initialPortfolioId,
  defaultTab = "transaction",
}: {
  portfolios: { id: string; name: string }[];
  initialPortfolioId: string;
  defaultTab?: NewEntryTab;
}) {
  const tt = useTranslations("Manage.tx");
  const tca = useTranslations("CorpAction");
  const selectId = useId();
  const [portfolioId, setPortfolioId] = useState(initialPortfolioId);

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="transaction">{tt("tabTransaction")}</TabsTrigger>
        <TabsTrigger value="corporate-action">{tca("link")}</TabsTrigger>
      </TabsList>
      <TabsContent value="transaction" className="space-y-4">
        {portfolios.length > 1 && (
          <div className="space-y-1.5">
            <label htmlFor={selectId} className="text-sm font-medium">
              {tt("portfolioPicker")}
            </label>
            <Select
              id={selectId}
              value={portfolioId}
              onChange={(e) => setPortfolioId(e.target.value)}
              className="sm:max-w-xs"
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <AddTransaction portfolioId={portfolioId} />
      </TabsContent>
      <TabsContent value="corporate-action">
        <RecordCorporateAction />
      </TabsContent>
    </Tabs>
  );
}
