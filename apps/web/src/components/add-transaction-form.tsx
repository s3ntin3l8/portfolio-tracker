"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, X } from "lucide-react";
import type { ApiClient, Instrument } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The slice of the API client this form needs (injectable for tests). */
export type AddTransactionClient = Pick<
  ApiClient,
  | "searchInstruments"
  | "createInstrument"
  | "createTransaction"
  | "updateTransaction"
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
  currency: string;
  executedAt: string;
}

const TX_TYPES = [
  "buy",
  "sell",
  "dividend",
  "coupon",
  "deposit",
  "withdrawal",
  "fee",
] as const;
type TxType = (typeof TX_TYPES)[number];
const ASSET_CLASSES = ["equity", "gold", "bond", "mutual_fund", "etf"] as const;
const UNITS = ["shares", "grams", "units"] as const;
const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Gold holdings use the Antam buyback market; everything else IDX (mirrors the API). */
function marketForAssetClass(assetClass: string): string {
  return assetClass === "gold" ? "ANTAM" : "IDX";
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
  const [type, setType] = useState<TxType>(
    () => (initial?.type as TxType) ?? "buy",
  );
  const [currency, setCurrency] = useState(() => initial?.currency ?? "IDR");
  const [date, setDate] = useState(() => initial?.executedAt?.slice(0, 10) ?? "");
  const [quantity, setQuantity] = useState(() => initial?.quantity ?? "");
  const [price, setPrice] = useState(() => initial?.price ?? "");
  const [fees, setFees] = useState(() => initial?.fees ?? "");

  // Instrument selection (non-cash types). Prefilled from the edited row.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);
  const [selected, setSelected] = useState<Instrument | null>(() =>
    initial?.instrument && initial.instrumentId
      ? {
          id: initial.instrumentId,
          isin: null,
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
  const [assetClass, setAssetClass] =
    useState<(typeof ASSET_CLASSES)[number]>("equity");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("shares");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // Cash movements carry no instrument; dividend/coupon are instrument income.
  const isCash = type === "deposit" || type === "withdrawal" || type === "fee";
  const isTrade = type === "buy" || type === "sell";

  async function runSearch(q: string) {
    setQuery(q);
    setSelected(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      setResults(await client.searchInstruments(q.trim()));
    } catch {
      setResults([]);
    }
  }

  async function resolveInstrumentId(): Promise<string | null> {
    if (isCash) return null;
    if (selected) return selected.id;
    const created = await client.createInstrument({
      symbol: symbol.trim(),
      market: marketForAssetClass(assetClass),
      assetClass,
      unit,
      currency,
      name: name.trim() || symbol.trim(),
    });
    return created.id;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const instrumentId = await resolveInstrumentId();
      const payload = {
        type,
        instrumentId,
        quantity: isTrade ? quantity || "0" : "0",
        price: price || "0",
        fees: isTrade ? fees || "0" : "0",
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
      setError(true);
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
          {t("error")}
        </div>
      )}

      <Field label={t("type")} htmlFor="tx-type">
        <select
          id="tx-type"
          value={type}
          onChange={(e) => setType(e.target.value as TxType)}
          className={selectClass}
        >
          {TX_TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {tt(ty)}
            </option>
          ))}
        </select>
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
              <Input
                value={query}
                onChange={(e) => runSearch(e.target.value)}
                placeholder={t("search")}
                aria-label={t("search")}
              />
              {results.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {results.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(i);
                          setResults([]);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                        <span className="font-medium">{i.symbol}</span>
                        <span className="text-muted-foreground">{i.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <p className="pt-1 text-xs font-medium text-muted-foreground">
                {t("newInstrument")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("symbol")} htmlFor="tx-symbol">
                  <Input
                    id="tx-symbol"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  />
                </Field>
                <Field label={t("name")} htmlFor="tx-name">
                  <Input
                    id="tx-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label={t("assetClass")} htmlFor="tx-class">
                  <select
                    id="tx-class"
                    value={assetClass}
                    onChange={(e) =>
                      setAssetClass(e.target.value as (typeof ASSET_CLASSES)[number])
                    }
                    className={selectClass}
                  >
                    {ASSET_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {tc(c)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("unit")} htmlFor="tx-unit">
                  <select
                    id="tx-unit"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as (typeof UNITS)[number])}
                    className={selectClass}
                  >
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {t(`units.${u}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {isTrade && (
          <Field label={t("quantity")} htmlFor="tx-qty">
            <Input
              id="tx-qty"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        )}
        <Field label={isTrade ? t("price") : t("amount")} htmlFor="tx-price">
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
        <Field label={t("currency")} htmlFor="tx-currency">
          <select
            id="tx-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={selectClass}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
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
