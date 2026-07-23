"use client";

import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Field } from "./field";

// Form-specific: narrower than isIncomeType (excludes interest/bonus_cash shown as Cash)
const INCOME_TYPES = ["dividend", "coupon"] as const;
const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

interface AdvancedFieldsProps {
  type: string;
  fxRate: string;
  setFxRate: (v: string) => void;
  kind: string;
  setKind: (v: string) => void;
  shares: string;
  setShares: (v: string) => void;
  perShare: string;
  setPerShare: (v: string) => void;
  nativeCurrency: string;
  setNativeCurrency: (v: string) => void;
  grossNative: string;
  setGrossNative: (v: string) => void;
  open: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}

/** The v2 design's "Advanced" collapsible — FX rate + sub-type for every type, plus
 *  (income only) the four native-currency/gross-up fields: Shares paid on, Per share,
 *  Native currency, Gross (native). Controlled (not a native `<details>`) so the chevron
 *  can share the same open/close affordance the rest of the form's collapsibles use. */
export function AdvancedFields({
  type,
  fxRate,
  setFxRate,
  kind,
  setKind,
  shares,
  setShares,
  perShare,
  setPerShare,
  nativeCurrency,
  setNativeCurrency,
  grossNative,
  setGrossNative,
  open,
  onToggle,
  t,
}: AdvancedFieldsProps) {
  const isIncome = (INCOME_TYPES as readonly string[]).includes(type);

  return (
    <div className="border-t border-border pt-3.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[13px] font-semibold text-text-2"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={2.2}
        />
        {t("advanced")}
      </button>
      {open && (
        <div className="mt-[13px] grid gap-3 grid-cols-2">
          <Field label={t("fxRate")} htmlFor="tx-fx-rate">
            <Input
              id="tx-fx-rate"
              inputMode="decimal"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              placeholder={t("fxRatePlaceholder")}
            />
          </Field>
          <Field label={t("subType")} htmlFor="tx-sub-type">
            <Select id="tx-sub-type" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t("subTypeNone")}</option>
              <option value="saveback">{t("subTypeSaveback")}</option>
              <option value="roundup">{t("subTypeRoundup")}</option>
              <option value="merger">{t("subTypeMerger")}</option>
            </Select>
          </Field>
          {isIncome && (
            <Field label={t("shares")} htmlFor="tx-shares">
              <Input
                id="tx-shares"
                inputMode="decimal"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                placeholder={t("sharesPlaceholder")}
              />
            </Field>
          )}
          {isIncome && (
            <Field label={t("perShare")} htmlFor="tx-per-share">
              <Input
                id="tx-per-share"
                inputMode="decimal"
                value={perShare}
                onChange={(e) => setPerShare(e.target.value)}
                placeholder={t("perSharePlaceholder")}
              />
            </Field>
          )}
          {isIncome && (
            <Field label={t("nativeCurrency")} htmlFor="tx-native-currency">
              <Select
                id="tx-native-currency"
                value={nativeCurrency}
                onChange={(e) => setNativeCurrency(e.target.value)}
              >
                <option value="">{t("subTypeNone")}</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {isIncome && (
            <Field label={t("grossNative")} htmlFor="tx-gross-native">
              <Input
                id="tx-gross-native"
                inputMode="decimal"
                value={grossNative}
                onChange={(e) => setGrossNative(e.target.value)}
                placeholder={t("grossNativePlaceholder")}
              />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}
