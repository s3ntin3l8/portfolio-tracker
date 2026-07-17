"use client";

import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CURRENCIES } from "../constants";

export function AccountSection({
  accountNumber,
  iban,
  currency,
  taxAllowanceAnnual,
  showFsaHelper,
  fsaOverAllocated,
  totalAllocated,
  holderAllowanceCap,
  fsaRemainingForHolder,
  selectedHolderName,
  onAccountNumberChange,
  onIbanChange,
  onCurrencyChange,
  onTaxAllowanceChange,
}: {
  accountNumber: string;
  iban: string;
  currency: string;
  taxAllowanceAnnual: string;
  showFsaHelper: boolean;
  fsaOverAllocated: boolean;
  totalAllocated: number;
  holderAllowanceCap: number;
  fsaRemainingForHolder: number;
  selectedHolderName: string | null;
  onAccountNumberChange: (value: string) => void;
  onIbanChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
  onTaxAllowanceChange: (value: string) => void;
}) {
  const t = useTranslations("PortfolioForm");

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="portfolio-account-number">{t("accountNumber")}</Label>
        <Input
          id="portfolio-account-number"
          value={accountNumber}
          onChange={(e) => onAccountNumberChange(e.target.value)}
          placeholder={t("accountNumberPlaceholder")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="portfolio-iban">{t("iban")}</Label>
        <Input
          id="portfolio-iban"
          value={iban}
          onChange={(e) => onIbanChange(e.target.value)}
          placeholder={t("ibanPlaceholder")}
        />
      </div>

      <div className="flex items-start gap-3">
        <div className="w-[130px] shrink-0 space-y-1.5">
          <Label htmlFor="portfolio-currency">{t("currency")}</Label>
          <Select
            id="portfolio-currency"
            value={currency}
            onChange={(e) => onCurrencyChange(e.target.value)}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex-1 space-y-1.5">
          <Label htmlFor="portfolio-fsa">{t("taxAllowanceAnnual")}</Label>
          <Input
            id="portfolio-fsa"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={taxAllowanceAnnual}
            onChange={(e) => onTaxAllowanceChange(e.target.value)}
            placeholder={t("taxAllowanceAnnualPlaceholder")}
          />
          {showFsaHelper && !fsaOverAllocated && (
            <p className="text-xs text-muted-foreground">
              {t("taxAllowanceHelper", {
                allocated: totalAllocated.toFixed(0),
                cap: holderAllowanceCap.toFixed(0),
                remaining: fsaRemainingForHolder.toFixed(0),
                holder: selectedHolderName ?? "",
              })}
            </p>
          )}
          {showFsaHelper && fsaOverAllocated && (
            <div className="flex items-start gap-1.5 text-xs text-yellow-700 dark:text-yellow-300">
              <TriangleAlert className="size-3.5 mt-0.5 shrink-0" />
              <span>{t("taxAllowanceOverAllocated", { cap: holderAllowanceCap.toFixed(0) })}</span>
            </div>
          )}
          {!showFsaHelper && (
            <p className="text-xs text-muted-foreground">{t("taxAllowanceAnnualHint")}</p>
          )}
        </div>
      </div>
    </>
  );
}
