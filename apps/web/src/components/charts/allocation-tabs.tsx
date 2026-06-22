"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AllocationDonut } from "./allocation-donut";
import type { AllocationBreakdown } from "@portfolio/api-client";

/** Convert a decimal-string slice value to a number, clamping negatives to 0. */
function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Tabbed allocation breakdown card: Class | Currency | Region | Sector.
 * Each tab renders an AllocationDonut. The concentration badge sits in the
 * card header, supplied by the parent.
 */
export function AllocationTabs({
  allocation,
  currency,
}: {
  allocation: AllocationBreakdown;
  currency: string;
}) {
  const t = useTranslations("Dashboard");
  const ta = useTranslations("AssetClass");
  const tr = useTranslations("Region");

  const assetClassSlices = allocation.byAssetClass
    .map((s) => ({
      key: s.key,
      label: s.key === "cash" ? ta("cash") : (ta as (k: string) => string)(s.key),
      value: toNumber(s.value),
    }))
    .filter((s) => s.value > 0);

  const currencySlices = allocation.byCurrency
    .map((s) => ({ key: s.key, label: s.key, value: toNumber(s.value) }))
    .filter((s) => s.value > 0);

  const regionSlices = allocation.byRegion
    .map((s) => ({
      key: s.key,
      label: (tr as (k: string) => string)(s.key),
      value: toNumber(s.value),
    }))
    .filter((s) => s.value > 0);

  const sectorSlices = allocation.bySector
    .map((s) => ({ key: s.key, label: s.key, value: toNumber(s.value) }))
    .filter((s) => s.value > 0);

  return (
    <Tabs defaultValue="class">
      <TabsList className="mb-3 flex w-full">
        <TabsTrigger value="class" className="flex-1">
          {t("allocationTabClass")}
        </TabsTrigger>
        <TabsTrigger value="currency" className="flex-1">
          {t("allocationTabCurrency")}
        </TabsTrigger>
        <TabsTrigger value="region" className="flex-1">
          {t("allocationTabRegion")}
        </TabsTrigger>
        <TabsTrigger value="sector" className="flex-1">
          {t("allocationTabSector")}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="class">
        {assetClassSlices.length > 0 ? (
          <AllocationDonut data={assetClassSlices} currency={currency} />
        ) : (
          <p className="text-center text-sm text-muted-foreground py-8">—</p>
        )}
      </TabsContent>

      <TabsContent value="currency">
        {currencySlices.length > 0 ? (
          <AllocationDonut data={currencySlices} currency={currency} />
        ) : (
          <p className="text-center text-sm text-muted-foreground py-8">—</p>
        )}
      </TabsContent>

      <TabsContent value="region">
        {regionSlices.length > 0 ? (
          <AllocationDonut data={regionSlices} currency={currency} />
        ) : (
          <p className="text-center text-sm text-muted-foreground py-8">—</p>
        )}
      </TabsContent>

      <TabsContent value="sector">
        {sectorSlices.length > 0 ? (
          <AllocationDonut data={sectorSlices} currency={currency} />
        ) : (
          <p className="text-center text-sm text-muted-foreground py-8">—</p>
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Concentration badge shown in the card header beside the "Allocation" title. */
export function ConcentrationBadge({
  label,
}: {
  label: "diversified" | "moderate" | "concentrated";
}) {
  const t = useTranslations("Dashboard");
  const variant: Record<string, "success" | "warning" | "destructive"> = {
    diversified: "success",
    moderate: "warning",
    concentrated: "destructive",
  };
  const labelKey = {
    diversified: "concentrationDiversified",
    moderate: "concentrationModerate",
    concentrated: "concentrationConcentrated",
  } as const;

  return (
    <Badge variant={variant[label] ?? "secondary"}>
      {t(labelKey[label])}
    </Badge>
  );
}
