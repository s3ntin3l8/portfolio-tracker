"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, Sparkles, X } from "lucide-react";
import type { ApiClient, Instrument, InstrumentSearchResult } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/** The slice of the API client this form needs (injectable for tests). */
export type RecordCorpActionClient = Pick<
  ApiClient,
  "searchInstruments" | "lookupInstruments" | "createCorporateAction"
>;

const TYPES = ["split", "bonus", "rights"] as const;
type CaType = (typeof TYPES)[number];

export function RecordCorporateActionForm({
  client,
  onSuccess,
}: {
  client: RecordCorpActionClient;
  onSuccess?: () => void;
}) {
  const t = useTranslations("CorpAction");
  const tt = useTranslations("TxType");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);
  // Market-data discovery results (not yet in the local DB).
  const [discovered, setDiscovered] = useState<InstrumentSearchResult[]>([]);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selected, setSelected] = useState<Instrument | null>(null);
  const [type, setType] = useState<CaType>("split");
  const [ratio, setRatio] = useState("");
  const [exDate, setExDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Informational notice (not an error) — shown when a market-data hit isn't in any portfolio yet.
  const [info, setInfo] = useState<string | null>(null);

  function runSearch(q: string) {
    setQuery(q);
    setSelected(null);
    setInfo(null);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    const trimmed = q.trim();
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

  /**
   * When a discovered (market-data) result is picked, try to resolve it to a
   * local DB instrument via its ISIN or symbol. If found, auto-select it.
   * If not, populate the search field so the user can refine or browse.
   */
  async function selectDiscovered(found: InstrumentSearchResult) {
    const key = found.isin ?? found.symbol;
    try {
      const matches = await client.searchInstruments(key);
      if (matches.length > 0) {
        setSelected(matches[0]);
        setResults([]);
        setDiscovered([]);
        setQuery("");
      } else {
        // Instrument not in portfolios yet — surface the discovery hit in the
        // query field so the user sees it and can retry with a different term.
        // Show as informational (not destructive) since this isn't an error.
        setQuery(found.symbol);
        setResults([]);
        setDiscovered([]);
        setInfo(t("notInPortfolios", { symbol: found.symbol }));
      }
    } catch {
      setResults([]);
      setDiscovered([]);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!selected) {
      setError(t("needInstrument"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await client.createCorporateAction({
        instrumentId: selected.id,
        type,
        ratio: ratio || "1",
        exDate: new Date(exDate),
      });
      onSuccess?.();
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg space-y-5">
      {info && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground"
        >
          {info}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-2">
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
              aria-label={t("search")}
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
                        onClick={() => void selectDiscovered(i)}
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
          </>
        )}
        {/* A corporate action is instrument-global — recorded once, it adjusts holdings in
            every portfolio that holds the instrument. Spell that out so the absence of a
            portfolio picker doesn't read as a missing field. */}
        <p className="text-xs text-muted-foreground">
          {selected
            ? t("scopeHintFor", { symbol: selected.symbol })
            : t("scopeHint")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ca-type">{t("type")}</Label>
          <Select
            id="ca-type"
            value={type}
            onChange={(e) => setType(e.target.value as CaType)}
          >
            {TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {tt(ty)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-ratio">{t("ratio")}</Label>
          <Input
            id="ca-ratio"
            inputMode="decimal"
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">{t("ratioHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ca-date">{t("exDate")}</Label>
          <Input
            id="ca-date"
            type="date"
            value={exDate}
            onChange={(e) => setExDate(e.target.value)}
            required
          />
        </div>
      </div>

      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {busy ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
