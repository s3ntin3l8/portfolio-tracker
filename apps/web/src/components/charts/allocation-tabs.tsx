"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AllocationDonut } from "./allocation-donut";
import { TargetDialog, type TargetSlice } from "@/components/allocation/target-dialog";
import { getDrillDownInstruments, type DrillDownDimension } from "@/lib/sector-drilldown";
import type { AllocationBreakdown, DriftRow, HoldingValuation } from "@portfolio/api-client";

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
  onSliceClick?: (key: string) => void;
}

function TabBody({
  slices,
  dimension,
  dimensionLabel,
  currency,
  total,
  drift,
  portfolioId,
  onSliceClick,
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
        <AllocationDonut data={slices} currency={currency} total={total} onSliceClick={onSliceClick} />
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
// DimensionDrillDown
// ---------------------------------------------------------------------------

function DimensionDrillDown({
  dimension,
  selectedKey,
  selectedKeyLabel,
  holdings,
  currency,
  onBack,
}: {
  dimension: DrillDownDimension;
  selectedKey: string;
  selectedKeyLabel: string;
  holdings: HoldingValuation[];
  currency: string;
  onBack: () => void;
}) {
  const instruments = getDrillDownInstruments(holdings, dimension, selectedKey);
  const total = instruments.reduce((sum, i) => sum + i.value, 0);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3 transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>
      {instruments.length > 0 ? (
        <AllocationDonut
          data={instruments.map((i) => ({ key: i.key, label: i.name, value: i.value }))}
          currency={currency}
          total={total}
          label={selectedKeyLabel}
        />
      ) : (
        <p className="text-center text-sm text-muted-foreground py-8">—</p>
      )}
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
 *
 * When `holdings` is provided, clicking a donut slice drills into a sub-donut
 * showing the instruments that contribute to that bucket.
 */
export function AllocationTabs({
  allocation,
  currency,
  drift,
  portfolioId,
  holdings,
}: {
  allocation: AllocationBreakdown;
  currency: string;
  drift?: Record<string, DriftRow[]>;
  portfolioId?: string;
  holdings?: HoldingValuation[];
}) {
  const t = useTranslations("Dashboard");
  const ta = useTranslations("AssetClass");
  const tr = useTranslations("Region");

  const [selectedDimension, setSelectedDimension] = useState<DrillDownDimension | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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

  const handleSliceClick = (dimension: DrillDownDimension) => (key: string) => {
    if (!holdings) return;
    setSelectedDimension(dimension);
    setSelectedKey(key);
  };

  const handleBack = () => {
    setSelectedDimension(null);
    setSelectedKey(null);
  };

  const handleTabChange = () => {
    setSelectedDimension(null);
    setSelectedKey(null);
  };

  const renderDimension = (
    dimension: DrillDownDimension,
    slices: Array<{ key: string; label: string; value: number; actualPct: number }>,
    dimensionLabel: string,
  ) => {
    if (selectedDimension === dimension && selectedKey && holdings) {
      const selectedKeyLabel = slices.find((s) => s.key === selectedKey)?.label ?? selectedKey;
      return (
        <DimensionDrillDown
          dimension={dimension}
          selectedKey={selectedKey}
          selectedKeyLabel={selectedKeyLabel}
          holdings={holdings}
          currency={currency}
          onBack={handleBack}
        />
      );
    }
    return (
      <TabBody
        slices={slices}
        dimension={dimension}
        dimensionLabel={dimensionLabel}
        currency={currency}
        total={total}
        drift={drift}
        portfolioId={portfolioId}
        onSliceClick={holdings ? handleSliceClick(dimension) : undefined}
      />
    );
  };

  return (
    <Tabs defaultValue="class" onValueChange={handleTabChange}>
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
        {renderDimension("asset_class", assetClassSlices, t("allocationTabClass"))}
      </TabsContent>

      <TabsContent value="currency">
        {renderDimension("currency", currencySlices, t("allocationTabCurrency"))}
      </TabsContent>

      <TabsContent value="region">
        {renderDimension("region", regionSlices, t("allocationTabRegion"))}
      </TabsContent>

      <TabsContent value="sector">
        {renderDimension("sector", sectorSlices, t("allocationTabSector"))}
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
