"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AllocationDonut } from "./allocation-donut";
import { TargetDialog, type TargetSlice } from "@/components/allocation/target-dialog";
import type { AllocationBreakdown, DriftRow } from "@portfolio/api-client";

/** Convert a decimal-string slice value to a number, clamping negatives to 0. */
function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compact inline drift hint: "+8pp over target · −5pp under target".
 * Shown below the allocation chart when the user has saved targets for the dimension.
 */
function DriftHint({
  drift,
  dimensionLabel,
}: {
  drift: DriftRow[];
  dimensionLabel: string;
}) {
  const t = useTranslations("DriftBadge");
  const overs = drift.filter((d) => d.status === "over");
  const unders = drift.filter((d) => d.status === "under");

  if (overs.length === 0 && unders.length === 0) {
    return (
      <p className="text-xs text-center text-success mt-2">
        {dimensionLabel} · {t("onTarget")}
      </p>
    );
  }

  const parts: string[] = [];
  const topOver = [...overs].sort((a, b) => b.driftPct - a.driftPct)[0];
  const topUnder = [...unders].sort((a, b) => a.driftPct - b.driftPct)[0];
  if (topOver) parts.push(t("over", { pct: Math.abs(topOver.driftPct).toFixed(1) }));
  if (topUnder) parts.push(t("under", { pct: Math.abs(topUnder.driftPct).toFixed(1) }));

  return (
    <p className="text-xs text-center text-muted-foreground mt-2">{parts.join(" · ")}</p>
  );
}

// ---------------------------------------------------------------------------
// TabBody — extracted at module level to satisfy react/no-unstable-nested-components
// ---------------------------------------------------------------------------

interface TabBodyProps {
  slices: Array<{ key: string; label: string; value: number; actualPct: number }>;
  dimension: string;
  dimensionLabel: string;
  currency: string;
  total: number;
  drift?: Record<string, DriftRow[]>;
  portfolioId?: string;
}

function TabBody({
  slices,
  dimension,
  dimensionLabel,
  currency,
  total,
  drift,
  portfolioId,
}: TabBodyProps) {
  const dimDrift = drift?.[dimension];
  const targetSlices: TargetSlice[] = slices.map((s) => ({
    key: s.key,
    label: s.label,
    actualPct: s.actualPct,
  }));

  return (
    <div>
      {slices.length > 0 ? (
        <AllocationDonut data={slices} currency={currency} total={total} />
      ) : (
        <p className="text-center text-sm text-muted-foreground py-8">—</p>
      )}
      {dimDrift && dimDrift.length > 0 && (
        <DriftHint drift={dimDrift} dimensionLabel={dimensionLabel} />
      )}
      <div className="flex justify-end mt-2">
        <TargetDialog
          portfolioId={portfolioId}
          dimension={dimension}
          dimensionLabel={dimensionLabel}
          slices={targetSlices}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AllocationTabs
// ---------------------------------------------------------------------------

/**
 * Tabbed allocation breakdown card: Class | Currency | Region | Sector.
 * Each tab renders an AllocationDonut. The concentration badge sits in the
 * card header, supplied by the parent.
 *
 * When `drift` is provided (user has saved targets), each tab shows a compact
 * drift hint and a "Set targets" trigger button.
 * When `portfolioId` is provided, targets are portfolio-scoped; otherwise aggregate.
 */
export function AllocationTabs({
  allocation,
  currency,
  drift,
  portfolioId,
}: {
  allocation: AllocationBreakdown;
  currency: string;
  drift?: Record<string, DriftRow[]>;
  portfolioId?: string;
}) {
  const t = useTranslations("Dashboard");
  const ta = useTranslations("AssetClass");
  const tr = useTranslations("Region");

  const assetClassSlices = allocation.byAssetClass
    .map((s) => ({
      key: s.key,
      label: s.key === "cash" ? ta("cash") : (ta as (k: string) => string)(s.key),
      value: toNumber(s.value),
      actualPct: s.pct,
    }))
    .filter((s) => s.value > 0);

  const total = assetClassSlices.reduce((sum, s) => sum + s.value, 0);

  const currencySlices = allocation.byCurrency
    .map((s) => ({ key: s.key, label: s.key, value: toNumber(s.value), actualPct: s.pct }))
    .filter((s) => s.value > 0);

  const regionSlices = allocation.byRegion
    .map((s) => ({
      key: s.key,
      label: (tr as (k: string) => string)(s.key),
      value: toNumber(s.value),
      actualPct: s.pct,
    }))
    .filter((s) => s.value > 0);

  const sectorSlices = allocation.bySector
    .map((s) => ({ key: s.key, label: s.key, value: toNumber(s.value), actualPct: s.pct }))
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
        <TabBody
          slices={assetClassSlices}
          dimension="asset_class"
          dimensionLabel={t("allocationTabClass")}
          currency={currency}
          total={total}
          drift={drift}
          portfolioId={portfolioId}
        />
      </TabsContent>

      <TabsContent value="currency">
        <TabBody
          slices={currencySlices}
          dimension="currency"
          dimensionLabel={t("allocationTabCurrency")}
          currency={currency}
          total={total}
          drift={drift}
          portfolioId={portfolioId}
        />
      </TabsContent>

      <TabsContent value="region">
        <TabBody
          slices={regionSlices}
          dimension="region"
          dimensionLabel={t("allocationTabRegion")}
          currency={currency}
          total={total}
          drift={drift}
          portfolioId={portfolioId}
        />
      </TabsContent>

      <TabsContent value="sector">
        <TabBody
          slices={sectorSlices}
          dimension="sector"
          dimensionLabel={t("allocationTabSector")}
          currency={currency}
          total={total}
          drift={drift}
          portfolioId={portfolioId}
        />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// ConcentrationBadge
// ---------------------------------------------------------------------------

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
    <Badge variant={variant[label] ?? "secondary"}>{t(labelKey[label])}</Badge>
  );
}
