"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  ApiClient,
  GoldSource,
  Instrument,
  InstrumentSearchResult,
} from "@portfolio/api-client";
import { isTradeType, isShareReceiptType, isTransferType } from "@portfolio/core";
import {
  INCOME_TYPES,
  CASH_TYPES,
  ASSET_CLASSES,
  BUCKET_DEFAULT_TYPE,
  BUCKET_TYPES,
  BUCKET_SUBTYPE_LABEL_KEY,
  bucketForType,
  type Bucket,
  type SelectableType,
  type TxType,
  marketForAssetClass,
  clampAssetClass,
  unitForClass,
  goldSymbolFromLabel,
} from "./constants";

export type { SelectableType, TxType };

export type AddTransactionClient = Pick<
  ApiClient,
  | "searchInstruments"
  | "lookupInstruments"
  | "createInstrument"
  | "createTransaction"
  | "updateTransaction"
  | "getGoldSources"
>;

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
  perShare?: string | null;
  shares?: string | null;
  nativeCurrency?: string | null;
  grossNative?: string | null;
  description?: string | null;
  tags?: string[] | null;
  currency: string;
  executedAt: string;
  sources?: import("@portfolio/api-client").SourceSummary[];
  hasFullTaxDetail?: boolean;
  kind?: string | null;
  source?: string | null;
  externalId?: string | null;
}

export function useTransactionForm({
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
  // The bucket switcher's active pill. A legacy share-receipt type (bonus/split/rights —
  // no longer creatable here, see `SHARE_RECEIPT_TYPES`) maps to no bucket; the switcher
  // then shows none active, but the amount/details fields still render correctly for
  // editing that existing transaction (`showQuantity` etc. don't depend on `bucket`).
  const [bucket, setBucketState] = useState<Bucket | null>(() =>
    // A fresh form defaults to Trade/Buy; an edit of an existing legacy share-receipt
    // type (no longer creatable — see `SHARE_RECEIPT_TYPES`) maps to no bucket at all.
    initial ? bucketForType(initial.type) : "trade",
  );
  const [kind, setKind] = useState(() => initial?.kind ?? "");
  const [currency, setCurrency] = useState(() => initial?.currency ?? "IDR");
  const [date, setDate] = useState(() => initial?.executedAt?.slice(0, 10) ?? "");
  const [quantity, setQuantity] = useState(() => initial?.quantity ?? "");
  const [price, setPrice] = useState(() => initial?.price ?? "");
  const [fees, setFees] = useState(() => initial?.fees ?? "");
  const [tax, setTax] = useState(() => initial?.tax ?? "");
  const [fxRate, setFxRate] = useState(() => initial?.fxRate ?? "");
  const [shares, setShares] = useState(() => initial?.shares ?? "");
  const [perShare, setPerShare] = useState(() => initial?.perShare ?? "");
  const [nativeCurrency, setNativeCurrency] = useState(() => initial?.nativeCurrency ?? "");
  const [grossNative, setGrossNative] = useState(() => initial?.grossNative ?? "");
  const [description, setDescription] = useState(() => initial?.description ?? "");
  const [tags, setTags] = useState(() => initial?.tags?.join(", ") ?? "");

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
  const [unit, setUnit] = useState<"shares" | "grams" | "units">("shares");
  const [isin, setIsin] = useState<string | null>(null);
  const [wkn, setWkn] = useState<string | null>(null);
  const [discoveredMarket, setDiscoveredMarket] = useState<string | null>(null);

  const [goldSourceList, setGoldSourceList] = useState<GoldSource[]>([]);
  const [goldMarket, setGoldMarket] = useState("");

  // "Can't find it? Add a custom instrument" collapsible (instrument-field.tsx) — closed
  // by default, per the v2 design; opened automatically when editing an existing
  // transaction whose instrument was never resolved to a saved/discovered match.
  const [customOpen, setCustomOpen] = useState(() => Boolean(!initial?.instrumentId && initial));
  // "Add fees / tax" collapsible (pricing-fields.tsx) — closed by default, opened
  // automatically in edit mode when the transaction already carries a nonzero fee or tax
  // so editing doesn't hide already-filled data behind a click.
  const [extrasOpen, setExtrasOpen] = useState(
    () =>
      Boolean(initial?.fees && initial.fees !== "0") ||
      Boolean(initial?.tax && initial.tax !== "0"),
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      Boolean(initial?.fxRate) ||
      Boolean(initial?.kind) ||
      Boolean(initial?.shares) ||
      Boolean(initial?.perShare) ||
      Boolean(initial?.nativeCurrency) ||
      Boolean(initial?.grossNative),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAcquisition = isTradeType(type);
  const isShareReceipt = isShareReceiptType(type);
  const isTransfer = isTransferType(type);
  const isIncome = (INCOME_TYPES as readonly string[]).includes(type);
  const isCash =
    (CASH_TYPES as readonly string[]).includes(type) ||
    type === "loan_drawdown" ||
    type === "loan_repayment";

  const hasInstrument = !isCash;
  const showQuantity = isAcquisition || isShareReceipt || isTransfer;
  const showFees = isAcquisition;
  // Only a sale or an income event ever withholds tax — a buy never does (v2 design).
  const showTax = type === "sell" || isIncome;
  const isGold = hasInstrument && (selected ? selected.assetClass : assetClass) === "gold";

  // Income tax sits inline in the Amount group; an acquisition's fees/tax sit behind the
  // "Add fees / tax" collapsible (only relevant — i.e. rendered at all — for a trade).
  const showInlineTax = isIncome;
  const relevantExtras = isAcquisition;
  const showExtrasFields = relevantExtras && extrasOpen;
  const showExtrasBtn = relevantExtras && !extrasOpen;
  const extrasLabelKey = showTax ? "extrasFeesTax" : "extrasFees";

  const subTypeLabelKey = bucket ? BUCKET_SUBTYPE_LABEL_KEY[bucket] : "bucketSubtypeAction";
  const subTypes = bucket ? BUCKET_TYPES[bucket] : [];

  function setBucket(next: Bucket) {
    setBucketState(next);
    setType(BUCKET_DEFAULT_TYPE[next]);
  }

  const priceLabel = isTransfer
    ? "transferBasis"
    : isGold && showQuantity
      ? "pricePerGram"
      : showQuantity
        ? "price"
        : "amount";
  const priceHint = isTransfer
    ? "transferBasisHint"
    : type === "adjustment"
      ? "adjustmentHint"
      : null;
  const priceRequired = !isShareReceipt && !isTransfer;

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
    void client
      .searchInstruments(trimmed)
      .then(setResults)
      .catch(() => setResults([]));
    lookupTimer.current = setTimeout(() => {
      void client
        .lookupInstruments(trimmed)
        .then(setDiscovered)
        .catch(() => setDiscovered([]));
    }, 300);
  }

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
    // Deliberate deviation from the v2 design's own demo state machine (which leaves this
    // collapsed): the prefilled symbol/name/currency fields live behind it, so leaving it
    // closed would silently hide what was just auto-filled.
    setCustomOpen(true);
  }

  function handleSelectSaved(instrument: Instrument) {
    setSelected(instrument);
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
        perShare: isIncome && perShare ? perShare : null,
        shares: isIncome && shares ? shares : null,
        nativeCurrency: isIncome && nativeCurrency ? nativeCurrency : null,
        grossNative: isIncome && grossNative ? grossNative : null,
        kind: kind || null,
        description: description.trim() || null,
        tags: parsedTags.length > 0 ? parsedTags : null,
        currency,
        executedAt: new Date(date),
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

  return {
    t,
    tt,
    tc,
    isEdit,
    type,
    setType,
    bucket,
    setBucket,
    subTypeLabelKey,
    subTypes,
    kind,
    setKind,
    currency,
    setCurrency,
    date,
    setDate,
    quantity,
    setQuantity,
    price,
    setPrice,
    fees,
    setFees,
    tax,
    setTax,
    fxRate,
    setFxRate,
    shares,
    setShares,
    perShare,
    setPerShare,
    nativeCurrency,
    setNativeCurrency,
    grossNative,
    setGrossNative,
    description,
    setDescription,
    tags,
    setTags,
    query,
    results,
    discovered,
    selected,
    setSelected,
    symbol,
    setSymbol,
    name,
    setName,
    assetClass,
    setAssetClass,
    unit,
    setUnit,
    isin,
    setIsin,
    discoveredMarket,
    setDiscoveredMarket,
    goldSourceList,
    goldMarket,
    setGoldMarket,
    busy,
    error,
    isAcquisition,
    isShareReceipt,
    isTransfer,
    isIncome,
    isCash,
    hasInstrument,
    showQuantity,
    showFees,
    showTax,
    isGold,
    showInlineTax,
    showExtrasFields,
    showExtrasBtn,
    extrasLabelKey,
    extrasOpen,
    setExtrasOpen,
    customOpen,
    setCustomOpen,
    advancedOpen,
    setAdvancedOpen,
    priceLabel,
    priceHint,
    priceRequired,
    runSearch,
    prefillFrom,
    handleSelectSaved,
    submit,
  };
}
