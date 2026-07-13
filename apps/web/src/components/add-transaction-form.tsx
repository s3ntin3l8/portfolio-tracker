"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, ChevronDown, Loader2, Sparkles, X } from "lucide-react";
import type {
  ApiClient,
  GoldSource,
  Instrument,
  InstrumentSearchResult,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { MonogramBadge } from "@/components/monogram-badge";
import { TransactionSourcesSection } from "@/components/transaction-sources-section";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The slice of the API client this form needs (injectable for tests). */
export type AddTransactionClient = Pick<
  ApiClient,
  | "searchInstruments"
  | "lookupInstruments"
  | "createInstrument"
  | "createTransaction"
  | "updateTransaction"
  | "getGoldSources"
>;

/** Prefill values when editing an existing transaction. */
export interface AddTransactionInitial {
  type: string;
  instrumentId: string | null;
  instrument: {
    symbol: string;
    name: string;
    assetClass: string;
    unit: string;
  } | null;
  quantity: string;
  price: string;
  fees: string;
  tax?: string | null;
  fxRate?: string | null;
  description?: string | null;
  tags?: string[] | null;
  currency: string;
  executedAt: string;
  /** Source-provenance rows for this transaction (#230). Present only when editing. */
  sources?: import("@portfolio/api-client").SourceSummary[];
  /** True when at least one source has per-component taxComponents (#230). */
  hasFullTaxDetail?: boolean;
  /** Sub-type (saveback / roundup / transfer_in / merger); null when not set. */
  kind?: string | null;
  /** Original import source (pytr / csv / pdf / screenshot); null = manual. Preserved on edit. */
  source?: string | null;
  /** Import dedup key; null for manual transactions. Preserved on edit. */
  externalId?: string | null;
}

/**
 * Types offered in the dropdown, grouped by behaviour:
 *   Acquisition  — carry instrument + quantity + price/unit + fees + tax
 *   ShareReceipt — carry instrument + quantity + price/unit (not required); no fees/tax
 *   Income       — carry instrument + amount; no quantity/fees; tax retained
 *   Cash         — amount only; no instrument, quantity, fees
 *
 * loan_drawdown / loan_repayment are intentionally excluded: they require a loanId the
 * form cannot set; orphaned legs break loanBalances in core.
 */
const ACQUISITION_TYPES = ["buy", "sell", "savings_plan"] as const;
const SHARE_RECEIPT_TYPES = ["bonus", "split", "rights"] as const;
const INCOME_TYPES = ["dividend", "coupon"] as const;
const CASH_TYPES = [
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "interest",
  "bonus_cash",
  // Manual signed cash true-up — unlike every other cash type, the sign comes from the
  // user's input (not derived from `type`), so it needs its own amount hint below.
  "adjustment",
] as const;
// First-class transfer types (depot-to-depot, PR #309). Cash-neutral; price = carried basis.
const TRANSFER_TYPES = ["transfer_in", "transfer_out"] as const;

/** Types the user can freely select (the chip palette groups). Loan types are excluded. */
type SelectableType =
  | (typeof ACQUISITION_TYPES)[number]
  | (typeof SHARE_RECEIPT_TYPES)[number]
  | (typeof TRANSFER_TYPES)[number]
  | (typeof INCOME_TYPES)[number]
  | (typeof CASH_TYPES)[number];

/** All recognised types (superset; covers loan rows already in the DB). */
type TxType = SelectableType | "loan_drawdown" | "loan_repayment";
const ASSET_CLASSES = ["equity", "gold", "bond", "mutual_fund", "etf", "crypto"] as const;
const UNITS = ["shares", "grams", "units"] as const;
const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

/** Gold → buyback market, crypto → CRYPTO, everything else IDX (mirrors the API). */
function marketForAssetClass(assetClass: string): string {
  if (assetClass === "gold") return "ANTAM";
  if (assetClass === "crypto") return "CRYPTO";
  return "IDX";
}

/** Narrow a discovered asset class to one the form's picker offers (else equity). */
function clampAssetClass(value: string): (typeof ASSET_CLASSES)[number] {
  return (ASSET_CLASSES as readonly string[]).includes(value)
    ? (value as (typeof ASSET_CLASSES)[number])
    : "equity";
}

/** Default the unit from the asset class (gold by the gram, funds/crypto by the unit). */
function unitForClass(assetClass: string): (typeof UNITS)[number] {
  if (assetClass === "gold") return "grams";
  if (assetClass === "mutual_fund" || assetClass === "crypto") return "units";
  return "shares";
}

/**
 * Derive a grouping symbol for a gold position from its label. Gold has no ticker — the
 * label (e.g. "Antam 5g bar") plus the source's market identify the holding, so a labelled
 * position gets its own instrument. Falls back to "GOLD" when no label is given.
 */
function goldSymbolFromLabel(label: string): string {
  const slug = label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "GOLD";
}

export function AddTransactionForm({
  client,
  portfolioId,
  initial,
  transactionId,
  onSuccess,
  stickyFooter = false,
}: {
  client: AddTransactionClient;
  portfolioId: string;
  initial?: AddTransactionInitial;
  transactionId?: string;
  onSuccess?: () => void;
  /** Pin the submit button in a sticky footer bar so it stays visible without scrolling
   *  (#472 — buried below ~10 fields, worse with the mobile keyboard open). Sheet contexts
   *  only: full pages leave this off since a bottom-pinned bar would sit under the fixed
   *  bottom-nav. */
  stickyFooter?: boolean;
}) {
  const t = useTranslations("Manage.tx");
  const tt = useTranslations("TxType");
  const tc = useTranslations("AssetClass");

  const isEdit = Boolean(transactionId);
  const [type, setType] = useState<TxType>(() => (initial?.type as TxType) ?? "buy");
  // Type is chosen from a grouped chip palette (reference), collapsed behind a trigger.
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [kind, setKind] = useState(() => initial?.kind ?? "");
  const [currency, setCurrency] = useState(() => initial?.currency ?? "IDR");
  const [date, setDate] = useState(() => initial?.executedAt?.slice(0, 10) ?? "");
  const [quantity, setQuantity] = useState(() => initial?.quantity ?? "");
  const [price, setPrice] = useState(() => initial?.price ?? "");
  const [fees, setFees] = useState(() => initial?.fees ?? "");
  const [tax, setTax] = useState(() => initial?.tax ?? "");
  const [fxRate, setFxRate] = useState(() => initial?.fxRate ?? "");
  const [description, setDescription] = useState(() => initial?.description ?? "");
  // Tags stored as a comma-separated string in the UI; parsed to string[] on submit.
  const [tags, setTags] = useState(() => initial?.tags?.join(", ") ?? "");

  // Instrument selection (non-cash types). Prefilled from the edited row.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);
  const [discovered, setDiscovered] = useState<InstrumentSearchResult[]>([]);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = useState<Instrument | null>(() =>
    initial?.instrument && initial.instrumentId
      ? {
          id: initial.instrumentId,
          isin: null,
          wkn: null,
          symbol: initial.instrument.symbol,
          market: marketForAssetClass(initial.instrument.assetClass),
          assetClass: initial.instrument.assetClass,
          unit: initial.instrument.unit,
          currency: initial.currency,
          name: initial.instrument.name,
        }
      : null,
  );
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState<(typeof ASSET_CLASSES)[number]>("equity");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("shares");
  // Set when fields were auto-filled from a discovery match: carries the ISIN + WKN +
  // resolved market so they persist on create. Cleared once the user edits the symbol.
  const [isin, setIsin] = useState<string | null>(null);
  const [wkn, setWkn] = useState<string | null>(null);
  const [discoveredMarket, setDiscoveredMarket] = useState<string | null>(null);

  // Gold buyback sources (registry-driven), with the currently selected source's market.
  const [goldSourceList, setGoldSourceList] = useState<GoldSource[]>([]);
  const [goldMarket, setGoldMarket] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Grouped type chips for the picker palette (reference: Trade / Share receipt /
  // Transfer / Income / Cash). Loan types stay excluded (not offered in any group).
  const typeGroups: { label: string; items: readonly string[] }[] = [
    { label: t("groupTrade"), items: ACQUISITION_TYPES },
    { label: t("groupShareReceipt"), items: SHARE_RECEIPT_TYPES },
    { label: t("groupTransfer"), items: TRANSFER_TYPES },
    { label: t("groupIncome"), items: INCOME_TYPES },
    { label: t("groupCash"), items: CASH_TYPES },
  ];

  // Per-type field groups — drive which fields are shown and validated.
  const isAcquisition = (ACQUISITION_TYPES as readonly string[]).includes(type);
  const isShareReceipt = (SHARE_RECEIPT_TYPES as readonly string[]).includes(type);
  // Transfers: instrument + quantity + carried-cost-basis price. Cash-neutral, no fees/tax.
  const isTransfer = (TRANSFER_TYPES as readonly string[]).includes(type);
  const isIncome = (INCOME_TYPES as readonly string[]).includes(type);
  const isCash =
    (CASH_TYPES as readonly string[]).includes(type) ||
    type === "loan_drawdown" ||
    type === "loan_repayment";
  // Every other cash type's sign is derived from `type` (e.g. withdrawal is always an
  // outflow); `adjustment` is the one exception — the user's entered amount IS the
  // signed cash delta, so it gets its own hint instead of an unsigned "Amount" label.
  const isAdjustment = type === "adjustment";

  /** Shows the instrument picker. */
  const hasInstrument = !isCash;
  /** Shows the quantity field. */
  const showQuantity = isAcquisition || isShareReceipt || isTransfer;
  /** Shows fees (acquisitions only — transfers are typically fee-free). */
  const showFees = isAcquisition;
  /** Shows tax withheld (acquisitions + income). */
  const showTax = isAcquisition || isIncome;
  /** Price is mandatory except for share receipts (bonus shares are commonly price 0).
   *  Transfers show the price field as "Carried cost basis" — not required (0 = unknown). */
  const priceRequired = !isShareReceipt && !isTransfer;
  // Gold gets a dedicated entry flow (source + label, no symbol/search). For an already
  // selected instrument (edit) trust its own class; otherwise the picked asset kind.
  const isGold = hasInstrument && (selected ? selected.assetClass : assetClass) === "gold";

  // Load the selectable gold sources once; default to the first (highest-priority) one.
  useEffect(() => {
    let active = true;
    void client
      .getGoldSources()
      .then((sources) => {
        if (!active) return;
        setGoldSourceList(sources);
        if (sources[0]) setGoldMarket((m) => m || sources[0].market);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);

  function runSearch(q: string) {
    setQuery(q);
    setSelected(null);
    const trimmed = q.trim();
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (!trimmed) {
      setResults([]);
      setDiscovered([]);
      return;
    }
    // Local reference data is fast; query it immediately.
    void client
      .searchInstruments(trimmed)
      .then(setResults)
      .catch(() => setResults([]));
    // Market-data discovery hits the network — debounce it.
    lookupTimer.current = setTimeout(() => {
      void client
        .lookupInstruments(trimmed)
        .then(setDiscovered)
        .catch(() => setDiscovered([]));
    }, 300);
  }

  /** Auto-fill the create fields from a market-data match (user can still edit). */
  function prefillFrom(match: InstrumentSearchResult) {
    const ac = clampAssetClass(match.assetClass);
    setSymbol(match.symbol.toUpperCase());
    setName(match.name);
    setAssetClass(ac);
    setUnit(unitForClass(ac));
    setCurrency(match.currency);
    setIsin(match.isin ?? null);
    setWkn(match.wkn ?? null);
    setDiscoveredMarket(match.market || null);
    setQuery("");
    setResults([]);
    setDiscovered([]);
  }

  async function resolveInstrumentId(): Promise<string | null> {
    if (!hasInstrument) return null;
    if (selected) return selected.id;
    if (assetClass === "gold") {
      const label = name.trim();
      const market = goldMarket || goldSourceList[0]?.market || "ANTAM";
      const sourceLabel = goldSourceList.find((s) => s.market === market)?.label;
      const created = await client.createInstrument({
        symbol: goldSymbolFromLabel(label),
        market,
        assetClass: "gold",
        unit: "grams",
        currency,
        name: label || sourceLabel || "Gold",
      });
      return created.id;
    }
    const created = await client.createInstrument({
      symbol: symbol.trim(),
      market: discoveredMarket ?? marketForAssetClass(assetClass),
      assetClass,
      unit,
      currency,
      name: name.trim() || symbol.trim(),
      isin: isin ?? undefined,
      wkn: wkn ?? undefined,
    });
    return created.id;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // A new non-gold instrument needs a symbol (gold derives one from its label). Catch the
    // empty case here with a clear message instead of letting the API reject it generically.
    if (hasInstrument && !selected && assetClass !== "gold" && !symbol.trim()) {
      setError(t("symbolRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const instrumentId = await resolveInstrumentId();
      const parsedTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const payload = {
        type,
        instrumentId,
        quantity: showQuantity ? quantity || "0" : "0",
        price: price || "0",
        fees: showFees ? fees || "0" : "0",
        tax: showTax && tax ? tax : null,
        fxRate: fxRate || null,
        kind: kind || null,
        description: description.trim() || null,
        tags: parsedTags.length > 0 ? parsedTags : null,
        currency,
        executedAt: new Date(date),
        // Preserve import provenance on edit; new manual rows default to "manual".
        source: (isEdit ? (initial?.source ?? "manual") : "manual") as
          "manual" | "screenshot" | "csv" | "pytr",
        externalId: isEdit ? (initial?.externalId ?? undefined) : undefined,
      };
      if (transactionId) {
        await client.updateTransaction(portfolioId, transactionId, payload);
      } else {
        await client.createTransaction(portfolioId, payload);
      }
      onSuccess?.();
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg space-y-5">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Type — reference grouped chip palette, collapsed behind an input-styled trigger. */}
      <div className="space-y-1.5">
        <Label>{t("type")}</Label>
        <button
          type="button"
          aria-label={t("type")}
          aria-expanded={typePickerOpen}
          onClick={() => setTypePickerOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-[13px] border border-border bg-card px-3.5 py-[13px] text-sm font-semibold text-foreground transition-colors focus-visible:border-primary focus-visible:outline-none"
        >
          <span>{tt(type)}</span>
          <ChevronDown
            className={cn(
              "size-4 text-chevron transition-transform",
              typePickerOpen && "rotate-180",
            )}
          />
        </button>
        {typePickerOpen && (
          <div className="mt-2.5 flex flex-col gap-3.5 rounded-[14px] border border-border bg-card p-[15px]">
            {typeGroups.map((g) => (
              <div key={g.label}>
                <p className="mb-2 ml-0.5 text-[10px] font-bold uppercase tracking-[.06em] text-text-3">
                  {g.label}
                </p>
                <div className="flex flex-wrap gap-[7px]">
                  {g.items.map((ty) => (
                    <button
                      key={ty}
                      type="button"
                      onClick={() => {
                        setType(ty as TxType);
                        setTypePickerOpen(false);
                      }}
                      className={cn(
                        "rounded-[10px] px-[13px] py-[9px] text-[12px] transition-colors",
                        ty === type
                          ? "bg-primary font-bold text-primary-foreground"
                          : "border border-border bg-card-2 font-semibold text-foreground hover:bg-secondary",
                      )}
                    >
                      {tt(ty)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {hasInstrument && (
        <Field label={t("instrument")}>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            {selected ? (
              <div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-sm">
                <MonogramBadge
                  label={selected.symbol}
                  assetClass={selected.assetClass}
                  className="size-8 rounded-[9px]"
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{selected.symbol}</span>
                  <span className="ml-2 text-muted-foreground">{selected.name}</span>
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
                <Field label={t("kind")} htmlFor="tx-kind">
                  <Select
                    id="tx-kind"
                    value={assetClass}
                    onChange={(e) => {
                      const ac = e.target.value as (typeof ASSET_CLASSES)[number];
                      setAssetClass(ac);
                      setUnit(unitForClass(ac));
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
                  <div className="grid gap-3 sm:grid-cols-2">
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
                    <p className="text-xs text-muted-foreground sm:col-span-2">{t("goldNote")}</p>
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
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          {t("savedResults")}
                        </p>
                        <ul className="divide-y divide-border rounded-md border border-border">
                          {results.map((i) => (
                            <li key={i.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelected(i);
                                  setResults([]);
                                  setDiscovered([]);
                                }}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent"
                              >
                                <MonogramBadge
                                  label={i.symbol}
                                  assetClass={i.assetClass}
                                  className="size-8 rounded-[9px]"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  <span className="font-medium">{i.symbol}</span>
                                  <span className="ml-2 text-muted-foreground">{i.name}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {discovered.length > 0 && (
                      <div className="space-y-1">
                        <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                          <Sparkles className="size-3" />
                          {t("discoveredResults")}
                        </p>
                        <ul className="divide-y divide-border rounded-md border border-border">
                          {discovered.map((i) => (
                            <li key={`${i.market}:${i.symbol}:${i.source}`}>
                              <button
                                type="button"
                                onClick={() => prefillFrom(i)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent"
                              >
                                <MonogramBadge
                                  label={i.symbol}
                                  assetClass={i.assetClass}
                                  className="size-8 rounded-[9px]"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  <span className="font-medium">{i.symbol}</span>
                                  <span className="ml-2 text-muted-foreground">{i.name}</span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {i.currency}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <p className="pt-1 text-xs font-medium text-muted-foreground">
                      {t("newInstrument")}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t("symbol")} htmlFor="tx-symbol">
                        <Input
                          id="tx-symbol"
                          value={symbol}
                          onChange={(e) => {
                            setSymbol(e.target.value.toUpperCase());
                            // Manual edits override a discovered identity.
                            setIsin(null);
                            setDiscoveredMarket(null);
                          }}
                        />
                      </Field>
                      <Field label={t("name")} htmlFor="tx-name">
                        <Input
                          id="tx-name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </Field>
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
                  </>
                )}
              </>
            )}
          </div>
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {showQuantity && (
          <Field label={isGold ? t("grams") : t("quantity")} htmlFor="tx-qty">
            <Input
              id="tx-qty"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              min="0.000001"
            />
          </Field>
        )}
        <Field
          label={
            isTransfer
              ? t("transferBasis")
              : isGold && showQuantity
                ? t("pricePerGram")
                : showQuantity
                  ? t("price")
                  : t("amount")
          }
          htmlFor="tx-price"
        >
          <Input
            id="tx-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required={priceRequired}
            placeholder={isTransfer ? t("transferBasisPlaceholder") : undefined}
          />
          {isTransfer && (
            <p className="mt-1 text-xs text-muted-foreground">{t("transferBasisHint")}</p>
          )}
          {isAdjustment && (
            <p className="mt-1 text-xs text-muted-foreground">{t("adjustmentHint")}</p>
          )}
        </Field>
        {showFees && (
          <Field label={t("fees")} htmlFor="tx-fees">
            <Input
              id="tx-fees"
              inputMode="decimal"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
            />
          </Field>
        )}
        {showTax && (
          <Field label={t("tax")} htmlFor="tx-tax">
            <Input
              id="tx-tax"
              inputMode="decimal"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              placeholder="0"
            />
          </Field>
        )}
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
      </div>

      <Field label={t("notes")} htmlFor="tx-notes">
        <textarea
          id="tx-notes"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("notesPlaceholder")}
          rows={2}
          // text-base (16px) on mobile avoids iOS/Android zoom-on-focus; text-sm from sm: up.
          className="flex w-full resize-y rounded-[13px] border border-border bg-card px-3.5 py-[13px] text-base font-medium transition-colors placeholder:text-text-3 focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
        />
      </Field>

      <Field label={t("tags")} htmlFor="tx-tags">
        <Input
          id="tx-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("tagsPlaceholder")}
        />
      </Field>

      <details className="group">
        <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground">
          {t("advanced")}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
        </div>
      </details>

      {isEdit && (initial?.sources?.length ?? 0) > 0 && (
        <TransactionSourcesSection
          portfolioId={portfolioId}
          txId={transactionId!}
          sources={initial?.sources ?? []}
          hasFullTaxDetail={initial?.hasFullTaxDetail ?? false}
        />
      )}
      {isEdit && !(initial?.hasFullTaxDetail ?? false) && (
        <p className="text-sm text-muted-foreground">{t("enrichHint")}</p>
      )}

      {/* Reference primary button: full-width green, rounded-15, 15px padding, 700/15px.
          `stickyFooter` pins it above the fold instead of leaving it buried at the bottom
          of the scrolling sheet (#472). */}
      <div
        className={cn(
          stickyFooter &&
            "sticky bottom-0 -mx-5 border-t border-border bg-background px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]",
        )}
      >
        <Button
          type="submit"
          disabled={busy}
          className="h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? t("submitting") : isEdit ? t("save") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

// TransactionSourcesSection is now in ./transaction-sources-section.tsx
