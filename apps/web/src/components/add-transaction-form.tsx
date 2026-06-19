"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, Sparkles, X } from "lucide-react";
import type {
  ApiClient,
  GoldSource,
  Instrument,
  InstrumentSearchResult,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

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
}

const TX_TYPES = ["buy", "sell", "dividend", "coupon", "deposit", "withdrawal", "fee"] as const;
type TxType = (typeof TX_TYPES)[number];
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
}: {
  client: AddTransactionClient;
  portfolioId: string;
  initial?: AddTransactionInitial;
  transactionId?: string;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Manage.tx");
  const tt = useTranslations("TxType");
  const tc = useTranslations("AssetClass");

  const isEdit = Boolean(transactionId);
  const [type, setType] = useState<TxType>(() => (initial?.type as TxType) ?? "buy");
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

  // Cash movements carry no instrument; dividend/coupon are instrument income.
  const isCash = type === "deposit" || type === "withdrawal" || type === "fee";
  const isTrade = type === "buy" || type === "sell";
  // Gold gets a dedicated entry flow (source + label, no symbol/search). For an already
  // selected instrument (edit) trust its own class; otherwise the picked asset kind.
  const isGold = !isCash && (selected ? selected.assetClass : assetClass) === "gold";

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
    if (isCash) return null;
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
    if (!isCash && !selected && assetClass !== "gold" && !symbol.trim()) {
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
        quantity: isTrade ? quantity || "0" : "0",
        price: price || "0",
        fees: isTrade ? fees || "0" : "0",
        tax: isTrade && tax ? tax : null,
        fxRate: fxRate || null,
        description: description.trim() || null,
        tags: parsedTags.length > 0 ? parsedTags : null,
        currency,
        executedAt: new Date(date),
        source: "manual" as const,
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

      <Field label={t("type")} htmlFor="tx-type">
        <Select id="tx-type" value={type} onChange={(e) => setType(e.target.value as TxType)}>
          {TX_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {tt(ty)}
            </option>
          ))}
        </Select>
      </Field>

      {!isCash && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <Label>{t("instrument")}</Label>
          {selected ? (
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span>
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
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
                            >
                              <span className="font-medium">{i.symbol}</span>
                              <span className="text-muted-foreground">{i.name}</span>
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
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                            >
                              <span className="font-medium">{i.symbol}</span>
                              <span className="truncate text-muted-foreground">{i.name}</span>
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
                      <Input id="tx-name" value={name} onChange={(e) => setName(e.target.value)} />
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
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {isTrade && (
          <Field label={isGold ? t("grams") : t("quantity")} htmlFor="tx-qty">
            <Input
              id="tx-qty"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        )}
        <Field
          label={isGold && isTrade ? t("pricePerGram") : isTrade ? t("price") : t("amount")}
          htmlFor="tx-price"
        >
          <Input
            id="tx-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>
        {isTrade && (
          <Field label={t("fees")} htmlFor="tx-fees">
            <Input
              id="tx-fees"
              inputMode="decimal"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
            />
          </Field>
        )}
        {isTrade && (
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
          <Input
            id="tx-date"
            type="date"
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
          className="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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
        </div>
      </details>

      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? t("submitting") : isEdit ? t("save") : t("submit")}
      </Button>
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
