"use client";

import { ChevronDown, Sparkles, X } from "lucide-react";
import type { GoldSource, Instrument, InstrumentSearchResult } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InstrumentLogo } from "@/components/instrument-logo";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Field } from "./field";

const ASSET_CLASSES = ["equity", "gold", "bond", "mutual_fund", "etf", "crypto"] as const;
const UNITS = ["shares", "grams", "units"] as const;

interface InstrumentFieldProps {
  hasInstrument: boolean;
  selected: Instrument | null;
  setSelected: (i: Instrument | null) => void;
  assetClass: string;
  setAssetClass: (v: string) => void;
  unit: string;
  setUnit: (v: string) => void;
  query: string;
  runSearch: (q: string) => void;
  results: Instrument[];
  discovered: InstrumentSearchResult[];
  onSelectSaved: (instrument: Instrument) => void;
  prefillFrom: (match: InstrumentSearchResult) => void;
  symbol: string;
  setSymbol: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  setIsin: (v: string | null) => void;
  setDiscoveredMarket: (v: string | null) => void;
  goldSourceList: GoldSource[];
  goldMarket: string;
  setGoldMarket: (v: string) => void;
  customOpen: boolean;
  onToggleCustom: () => void;
  t: (key: string) => string;
  tc: (key: string) => string;
}

/** The v2 design's "Instrument" section — no enclosing card (just a border-top
 *  separator, matching every other form section); the custom-entry fields (Kind/Source/
 *  Symbol/Name/Unit) sit behind a "Can't find it? Add a custom instrument" collapsible
 *  instead of always showing once nothing is selected. */
export function InstrumentField({
  hasInstrument,
  selected,
  setSelected,
  assetClass,
  setAssetClass,
  unit,
  setUnit,
  query,
  runSearch,
  results,
  discovered,
  onSelectSaved,
  prefillFrom,
  symbol,
  setSymbol,
  name,
  setName,
  setIsin,
  setDiscoveredMarket,
  goldSourceList,
  goldMarket,
  setGoldMarket,
  customOpen,
  onToggleCustom,
  t,
  tc,
}: InstrumentFieldProps) {
  if (!hasInstrument) return null;

  return (
    <div className="border-t border-line pt-[18px]">
      <Label>{t("instrument")}</Label>
      <div className="mt-1.5 flex flex-col gap-[13px]">
        {selected ? (
          <div className="flex items-center gap-2.5 rounded-[12px] border border-border bg-card px-[11px] py-[9px] text-sm">
            <InstrumentLogo
              label={selected.symbol}
              symbol={selected.symbol}
              market={selected.market}
              assetClass={selected.assetClass}
              className="size-[34px] shrink-0 rounded-[10px]"
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-bold">{selected.symbol}</span>
              <span className="ml-2 text-text-2">{selected.name}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("back")}
              onClick={() => setSelected(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <>
            <Input
              value={query}
              onChange={(e) => runSearch(e.target.value)}
              placeholder={t("search")}
              aria-label={t("search")}
            />
            {results.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold text-text-3">{t("savedResults")}</p>
                <ul className="divide-y divide-line rounded-[12px] border border-border bg-card">
                  {results.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => onSelectSaved(i)}
                        className="flex w-full items-center gap-2.5 px-[11px] py-[9px] text-left text-sm hover:bg-accent"
                      >
                        <InstrumentLogo
                          label={i.symbol}
                          symbol={i.symbol}
                          market={i.market}
                          assetClass={i.assetClass}
                          className="size-8 rounded-[9px]"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-bold">{i.symbol}</span>
                          <span className="ml-2 text-text-2">{i.name}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {discovered.length > 0 && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-text-3">
                  <Sparkles className="size-3" />
                  {t("discoveredResults")}
                </p>
                <ul className="divide-y divide-line rounded-[12px] border border-border bg-card">
                  {discovered.map((i) => (
                    <li key={`${i.market}:${i.symbol}:${i.source}`}>
                      <button
                        type="button"
                        onClick={() => prefillFrom(i)}
                        className="flex w-full items-center gap-2.5 px-[11px] py-[9px] text-left text-sm hover:bg-accent"
                      >
                        <InstrumentLogo
                          label={i.symbol}
                          symbol={i.symbol}
                          market={i.market}
                          assetClass={i.assetClass}
                          className="size-8 rounded-[9px]"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-bold">{i.symbol}</span>
                          <span className="ml-2 text-text-2">{i.name}</span>
                        </span>
                        <span className="shrink-0 text-xs text-text-3">{i.currency}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              onClick={onToggleCustom}
              className="flex items-center gap-1.5 self-start text-xs font-semibold text-primary"
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", customOpen && "rotate-180")}
                strokeWidth={2.2}
              />
              {t("customInstrumentToggle")}
            </button>

            {customOpen && (
              <div className="flex flex-col gap-[13px] border-t border-line pt-[13px]">
                <Field label={t("kind")} htmlFor="tx-kind">
                  <Select
                    id="tx-kind"
                    value={assetClass}
                    onChange={(e) => {
                      const ac = e.target.value as (typeof ASSET_CLASSES)[number];
                      setAssetClass(ac);
                      setUnit(
                        ac === "gold"
                          ? "grams"
                          : ac === "mutual_fund" || ac === "crypto"
                            ? "units"
                            : "shares",
                      );
                    }}
                  >
                    {ASSET_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {tc(c)}
                      </option>
                    ))}
                  </Select>
                </Field>

                {assetClass === "gold" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("goldSource")} htmlFor="tx-gold-source">
                      <Select
                        id="tx-gold-source"
                        value={goldMarket}
                        onChange={(e) => setGoldMarket(e.target.value)}
                      >
                        {goldSourceList.map((s) => (
                          <option key={s.market} value={s.market}>
                            {s.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("goldLabel")} htmlFor="tx-gold-label">
                      <Input
                        id="tx-gold-label"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t("goldLabelPlaceholder")}
                      />
                    </Field>
                    <p className="col-span-2 text-xs text-text-3">{t("goldNote")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("symbol")} htmlFor="tx-symbol">
                      <Input
                        id="tx-symbol"
                        value={symbol}
                        onChange={(e) => {
                          setSymbol(e.target.value.toUpperCase());
                          setIsin(null);
                          setDiscoveredMarket(null);
                        }}
                      />
                    </Field>
                    <Field label={t("name")} htmlFor="tx-name">
                      <Input id="tx-name" value={name} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <div className="col-span-2">
                      <Field label={t("unit")} htmlFor="tx-unit">
                        <Select
                          id="tx-unit"
                          value={unit}
                          onChange={(e) => setUnit(e.target.value as (typeof UNITS)[number])}
                        >
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {t(`units.${u}`)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
