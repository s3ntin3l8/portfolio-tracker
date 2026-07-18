"use client";

import { useId, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TransactionSourcesSection } from "@/components/transaction-sources-section";
import { useFocusScroll } from "@/lib/use-focus-scroll";
import { useSheetFooter } from "@/components/ui/sheet";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { TypeChipPicker } from "./add-transaction-form/type-chip-picker";
import { InstrumentField } from "./add-transaction-form/instrument-field";
import { PricingFields } from "./add-transaction-form/pricing-fields";
import { AdvancedFields } from "./add-transaction-form/advanced-fields";
import { SubmitButton } from "./add-transaction-form/submit-button";
import { SummaryRail } from "./add-transaction-form/summary-rail";
import { Field } from "./add-transaction-form/field";
import { useTransactionForm } from "./add-transaction-form/use-transaction-form";
import type {
  AddTransactionClient,
  AddTransactionInitial,
} from "./add-transaction-form/use-transaction-form";

export type { AddTransactionClient, AddTransactionInitial };

export function AddTransactionForm({
  client,
  portfolioId,
  portfolio,
  initial,
  transactionId,
  onSuccess,
  stickyFooter = false,
  isDesktop = false,
}: {
  client: AddTransactionClient;
  portfolioId: string;
  /** The full selected-portfolio object — desktop Summary rail only (see `AddTransaction`). */
  portfolio?: PickablePortfolio;
  initial?: AddTransactionInitial;
  transactionId?: string;
  onSuccess?: () => void;
  stickyFooter?: boolean;
  /** Desktop modal shell: two-column layout (form + sticky Summary rail), 13px group
   *  spacing instead of mobile's 20px, and compact submit-button styling. Mobile (the
   *  default) is rendered exactly as before — no wrapping grid, no rail. */
  isDesktop?: boolean;
}) {
  const form = useTransactionForm({ client, portfolioId, initial, transactionId, onSuccess });

  const formRef = useRef<HTMLFormElement>(null);
  useFocusScroll(formRef);

  const formId = useId();
  const footerEl = useSheetFooter();

  const formEl = (
    <form
      ref={formRef}
      id={formId}
      onSubmit={form.submit}
      className={isDesktop ? "flex min-w-0 flex-col gap-[13px]" : "max-w-lg space-y-5"}
    >
      {form.error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {form.error}
        </div>
      )}

      <TypeChipPicker
        type={form.type}
        typePickerOpen={form.typePickerOpen}
        typeGroups={form.typeGroups}
        onSelectType={form.handleSelectType}
        onToggle={form.handleToggleTypePicker}
        t={form.t}
        tt={form.tt}
      />

      <InstrumentField
        hasInstrument={form.hasInstrument}
        selected={form.selected}
        setSelected={form.setSelected}
        assetClass={form.assetClass}
        setAssetClass={(v) =>
          form.setAssetClass(v as "equity" | "gold" | "bond" | "mutual_fund" | "etf" | "crypto")
        }
        unit={form.unit}
        setUnit={(v) => form.setUnit(v as "shares" | "grams" | "units")}
        query={form.query}
        runSearch={form.runSearch}
        results={form.results}
        discovered={form.discovered}
        onSelectSaved={form.handleSelectSaved}
        prefillFrom={form.prefillFrom}
        symbol={form.symbol}
        setSymbol={form.setSymbol}
        name={form.name}
        setName={form.setName}
        setIsin={form.setIsin}
        setDiscoveredMarket={form.setDiscoveredMarket}
        goldSourceList={form.goldSourceList}
        goldMarket={form.goldMarket}
        setGoldMarket={form.setGoldMarket}
        t={form.t}
        tc={form.tc}
      />

      <PricingFields
        type={form.type}
        isGold={form.isGold}
        quantity={form.quantity}
        setQuantity={form.setQuantity}
        price={form.price}
        setPrice={form.setPrice}
        fees={form.fees}
        setFees={form.setFees}
        tax={form.tax}
        setTax={form.setTax}
        shares={form.shares}
        setShares={form.setShares}
        perShare={form.perShare}
        setPerShare={form.setPerShare}
        currency={form.currency}
        setCurrency={form.setCurrency}
        date={form.date}
        setDate={form.setDate}
        t={form.t}
        isDesktop={isDesktop}
      />

      <Field label={form.t("notes")} htmlFor="tx-notes">
        <textarea
          id="tx-notes"
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value)}
          placeholder={form.t("notesPlaceholder")}
          rows={2}
          className="flex w-full resize-y rounded-[13px] border border-border bg-card px-3.5 py-[13px] text-base font-medium transition-colors placeholder:text-text-3 focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
        />
      </Field>

      <Field label={form.t("tags")} htmlFor="tx-tags">
        <Input
          id="tx-tags"
          value={form.tags}
          onChange={(e) => form.setTags(e.target.value)}
          placeholder={form.t("tagsPlaceholder")}
        />
      </Field>

      <AdvancedFields
        type={form.type}
        fxRate={form.fxRate}
        setFxRate={form.setFxRate}
        kind={form.kind}
        setKind={form.setKind}
        nativeCurrency={form.nativeCurrency}
        setNativeCurrency={form.setNativeCurrency}
        grossNative={form.grossNative}
        setGrossNative={form.setGrossNative}
        t={form.t}
      />

      {form.isEdit && (initial?.sources?.length ?? 0) > 0 && (
        <TransactionSourcesSection
          portfolioId={portfolioId}
          txId={transactionId!}
          sources={initial?.sources ?? []}
          hasFullTaxDetail={initial?.hasFullTaxDetail ?? false}
        />
      )}
      {form.isEdit && !(initial?.hasFullTaxDetail ?? false) && (
        <p className="text-sm text-muted-foreground">{form.t("enrichHint")}</p>
      )}
    </form>
  );

  return (
    <>
      {isDesktop ? (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-7">
          {formEl}
          <SummaryRail
            portfolio={portfolio}
            type={form.type}
            quantity={form.quantity}
            price={form.price}
            fees={form.fees}
            tax={form.tax}
            currency={form.currency}
            t={form.t}
            tt={form.tt}
          />
        </div>
      ) : (
        formEl
      )}

      <SubmitButton
        busy={form.busy}
        isEdit={form.isEdit}
        formId={formId}
        stickyFooter={stickyFooter}
        footerEl={footerEl}
        t={form.t}
        isDesktop={isDesktop}
      />
    </>
  );
}
