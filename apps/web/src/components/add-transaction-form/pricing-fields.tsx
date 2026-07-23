"use client";

import { ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Field } from "./field";
import { NumberField } from "./number-field";
import { computeTxTotal, formatMoney, totalLabelKey } from "./totals";

const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

interface PricingFieldsProps {
  type: string;
  isGold: boolean;
  showQuantity: boolean;
  showInlineTax: boolean;
  showExtrasFields: boolean;
  showExtrasBtn: boolean;
  extrasLabelKey: string;
  onOpenExtras: () => void;
  showFees: boolean;
  showTax: boolean;
  priceLabelKey: string;
  priceHintKey: string | null;
  priceRequired: boolean;
  quantity: string;
  setQuantity: (v: string) => void;
  price: string;
  setPrice: (v: string) => void;
  fees: string;
  setFees: (v: string) => void;
  tax: string;
  setTax: (v: string) => void;
  currency: string;
  t: (key: string) => string;
  /** Suppresses the inline total card — the desktop Summary rail (`summary-rail.tsx`)
   *  shows the same figure instead. Defaults to showing it (mobile). */
  isDesktop?: boolean;
}

/** The v2 design's "Amount" section — quantity/price (+ inline tax for income), with an
 *  acquisition's fees/tax collapsed behind an "Add fees / tax" disclosure and, on mobile,
 *  a live running total. Currency/date/notes/tags live in the sibling `DetailsFields`. */
export function PricingFields({
  type,
  isGold,
  showQuantity,
  showInlineTax,
  showExtrasFields,
  showExtrasBtn,
  extrasLabelKey,
  onOpenExtras,
  showFees,
  showTax,
  priceLabelKey,
  priceHintKey,
  priceRequired,
  quantity,
  setQuantity,
  price,
  setPrice,
  fees,
  setFees,
  tax,
  setTax,
  currency,
  t,
  isDesktop = false,
}: PricingFieldsProps) {
  const total = computeTxTotal(type, quantity, price, fees, tax);

  return (
    <div className="border-t border-line pt-[18px]">
      <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-text-3">
        {t("amount")}
      </p>
      <div className="grid grid-cols-2 gap-3">
        {showQuantity && (
          <Field label={isGold ? t("grams") : t("quantity")} htmlFor="tx-qty">
            <NumberField
              id="tx-qty"
              value={quantity}
              onValueChange={setQuantity}
              required
              min="0.000001"
            />
          </Field>
        )}
        <Field label={t(priceLabelKey)} htmlFor="tx-price">
          <NumberField
            id="tx-price"
            value={price}
            onValueChange={setPrice}
            required={priceRequired}
            placeholder={
              priceLabelKey === "transferBasis" ? t("transferBasisPlaceholder") : undefined
            }
          />
          {priceHintKey && <p className="mt-1 text-xs text-muted-foreground">{t(priceHintKey)}</p>}
        </Field>
        {showInlineTax && (
          <Field label={t("tax")} htmlFor="tx-tax">
            <NumberField id="tx-tax" value={tax} onValueChange={setTax} placeholder="0" />
          </Field>
        )}
      </div>

      {showExtrasFields && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {showFees && (
            <Field label={t("fees")} htmlFor="tx-fees">
              <NumberField id="tx-fees" value={fees} onValueChange={setFees} />
            </Field>
          )}
          {showTax && (
            <Field label={t("tax")} htmlFor="tx-tax-extra">
              <NumberField id="tx-tax-extra" value={tax} onValueChange={setTax} placeholder="0" />
            </Field>
          )}
        </div>
      )}
      {showExtrasBtn && (
        <button
          type="button"
          onClick={onOpenExtras}
          className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-primary"
        >
          <ChevronRight className="size-3.5 rotate-90" strokeWidth={2.2} />
          {t(extrasLabelKey)}
        </button>
      )}

      {/* Live estimated-total line — suppressed on desktop, where the Summary rail
          (`summary-rail.tsx`) shows the same figure alongside the rest of the form. */}
      {total && !isDesktop && (
        <div className="mt-3 flex items-center justify-between rounded-[14px] border border-border bg-card-2 px-4 py-3.5">
          <span className="text-[13px] font-semibold text-text-2">
            {t(totalLabelKey(total.kind))}
          </span>
          <span className="text-[18px] font-extrabold text-foreground">
            {formatMoney(total.total, currency)}
          </span>
        </div>
      )}
    </div>
  );
}

interface DetailsFieldsProps {
  currency: string;
  setCurrency: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  tags: string;
  setTags: (v: string) => void;
  t: (key: string) => string;
}

/** The v2 design's "Details" section — currency, date, notes and tags grouped together
 *  (previously scattered: currency/date lived in the Amount grid, notes/tags were bare
 *  top-level fields). */
export function DetailsFields({
  currency,
  setCurrency,
  date,
  setDate,
  description,
  setDescription,
  tags,
  setTags,
  t,
}: DetailsFieldsProps) {
  return (
    <div className="border-t border-line pt-[18px]">
      <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-text-3">
        {t("details")}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("currency")} htmlFor="tx-currency">
          <Select id="tx-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("date")} htmlFor="tx-date">
          <DatePicker
            id="tx-date"
            label={t("date")}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <div className="col-span-2">
          <Field label={t("notes")} htmlFor="tx-notes">
            <textarea
              id="tx-notes"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("notesPlaceholder")}
              rows={2}
              className="flex w-full resize-y rounded-[13px] border border-border bg-card px-3.5 py-[13px] text-base font-medium transition-colors placeholder:text-text-3 focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
            />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={t("tags")} htmlFor="tx-tags">
            <Input
              id="tx-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("tagsPlaceholder")}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
