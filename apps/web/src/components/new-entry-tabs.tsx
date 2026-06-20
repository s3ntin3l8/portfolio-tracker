"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AddTransaction } from "@/components/add-transaction";
import { RecordCorporateAction } from "@/components/record-corporate-action";
import { RecordMerger } from "@/components/record-merger";

export type NewEntryTab = "transaction" | "corporate-action" | "merger";

/**
 * Unifies the two manual-entry forms behind one tabbed page. A transaction is a
 * portfolio-scoped money event; a corporate action is instrument-global reference data —
 * different forms and endpoints, so they stay separate components, just one entry point.
 */
export function NewEntryTabs({
  portfolioId,
  defaultTab = "transaction",
}: {
  portfolioId: string;
  defaultTab?: NewEntryTab;
}) {
  const tt = useTranslations("Manage.tx");
  const tca = useTranslations("CorpAction");
  const tm = useTranslations("Merger");

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="transaction">{tt("tabTransaction")}</TabsTrigger>
        <TabsTrigger value="corporate-action">{tca("link")}</TabsTrigger>
        <TabsTrigger value="merger">{tm("link")}</TabsTrigger>
      </TabsList>
      <TabsContent value="transaction">
        <AddTransaction portfolioId={portfolioId} />
      </TabsContent>
      <TabsContent value="corporate-action">
        <RecordCorporateAction />
      </TabsContent>
      <TabsContent value="merger">
        <RecordMerger portfolioId={portfolioId} />
      </TabsContent>
    </Tabs>
  );
}
