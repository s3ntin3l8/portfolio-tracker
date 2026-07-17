"use client";

import { useTranslations } from "next-intl";
import type { AccountHolder, AccountHolderType } from "@portfolio/api-client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { HolderTypeChips } from "@/components/holder-type-chips";
import { NEW_HOLDER } from "../constants";

export function OwnershipSection({
  holders,
  accountHolderId,
  newHolderName,
  newHolderType,
  newHolderBirthYear,
  onAccountHolderChange,
  onNewHolderNameChange,
  onNewHolderTypeChange,
  onNewHolderBirthYearChange,
}: {
  holders: AccountHolder[];
  accountHolderId: string;
  newHolderName: string;
  newHolderType: AccountHolderType;
  newHolderBirthYear: string;
  onAccountHolderChange: (value: string) => void;
  onNewHolderNameChange: (value: string) => void;
  onNewHolderTypeChange: (value: AccountHolderType) => void;
  onNewHolderBirthYearChange: (value: string) => void;
}) {
  const t = useTranslations("PortfolioForm");

  return (
    <div className="space-y-1.5">
      <Label htmlFor="portfolio-account-holder">{t("accountHolder")}</Label>
      <Select
        id="portfolio-account-holder"
        value={accountHolderId}
        onChange={(e) => onAccountHolderChange(e.target.value)}
      >
        <option value="">{t("holderNone")}</option>
        {holders.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
            {h.type === "child" ? ` · ${t("holderTypeChild")}` : ""}
            {h.birthYear != null ? ` (${h.birthYear})` : ""}
          </option>
        ))}
        <option value={NEW_HOLDER}>{t("holderNew")}</option>
      </Select>
      <p className="text-xs text-muted-foreground">{t("accountHolderHint")}</p>

      {accountHolderId === NEW_HOLDER && (
        <div className="mt-2 space-y-3 rounded-md border border-border/60 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-holder-name">{t("holderName")}</Label>
            <Input
              id="new-holder-name"
              value={newHolderName}
              onChange={(e) => onNewHolderNameChange(e.target.value)}
              placeholder={t("accountHolderPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label id="new-holder-type-label">{t("holderType")}</Label>
            <HolderTypeChips
              value={newHolderType}
              onChange={onNewHolderTypeChange}
              labelledBy="new-holder-type-label"
            />
          </div>
          {newHolderType === "child" && (
            <div className="space-y-1.5">
              <Label htmlFor="new-holder-birth-year">{t("birthYear")}</Label>
              <Input
                id="new-holder-birth-year"
                type="number"
                inputMode="numeric"
                placeholder={t("birthYearPlaceholder")}
                value={newHolderBirthYear}
                onChange={(e) => onNewHolderBirthYearChange(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("birthYearHint")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
