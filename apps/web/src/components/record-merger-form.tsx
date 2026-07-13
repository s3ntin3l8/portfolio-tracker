"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, X } from "lucide-react";
import type { ApiClient, Instrument } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** The slice of the API client this form needs (injectable for tests). */
export type RecordMergerClient = Pick<ApiClient, "searchInstruments" | "createMerger">;

/**
 * Accept German-formatted numbers as typed off a DKB document — `"3.869,77"` → `"3869.77"`,
 * `"48,1464"` → `"48.1464"`. A value with a decimal comma has its dot thousands-separators
 * stripped; a plain `"360.218"` (no comma) is already a valid decimal string and passes through.
 */
function normalizeDecimal(raw: string): string {
  const s = raw.trim();
  return s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
}

/** A reusable search-and-select picker for one instrument. */
function InstrumentPicker({
  label,
  placeholder,
  selected,
  onSelect,
  search,
}: {
  label: string;
  placeholder: string;
  selected: Instrument | null;
  onSelect: (i: Instrument | null) => void;
  search: (q: string) => Promise<Instrument[]>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);

  async function runSearch(q: string) {
    setQuery(q);
    onSelect(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      setResults(await search(q.trim()));
    } catch {
      setResults([]);
    }
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
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
            aria-label={placeholder}
            onClick={() => onSelect(null)}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
          />
          {results.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {results.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(i);
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
        </>
      )}
    </div>
  );
}

export function RecordMergerForm({
  client,
  portfolioId,
  onSuccess,
  stickyFooter = false,
}: {
  client: RecordMergerClient;
  portfolioId: string;
  onSuccess?: () => void;
  /** See `AddTransactionForm` — sheet contexts only. */
  stickyFooter?: boolean;
}) {
  const t = useTranslations("Merger");

  const [from, setFrom] = useState<Instrument | null>(null);
  const [to, setTo] = useState<Instrument | null>(null);
  const [outQty, setOutQty] = useState("");
  const [inQty, setInQty] = useState("");
  const [executedAt, setExecutedAt] = useState("");
  const [taxable, setTaxable] = useState(false);
  const [marketValue, setMarketValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!from || !to) {
      setError(t("needInstruments"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.createMerger(portfolioId, {
        fromInstrumentId: from.id,
        toInstrumentId: to.id,
        outQty: normalizeDecimal(outQty),
        inQty: normalizeDecimal(inQty),
        executedAt: new Date(executedAt),
        taxable,
        marketValue: taxable ? normalizeDecimal(marketValue) : undefined,
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
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <InstrumentPicker
        label={t("from")}
        placeholder={t("search")}
        selected={from}
        onSelect={setFrom}
        search={client.searchInstruments}
      />
      <InstrumentPicker
        label={t("to")}
        placeholder={t("search")}
        selected={to}
        onSelect={setTo}
        search={client.searchInstruments}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="merger-out">{t("outQty")}</Label>
          <Input
            id="merger-out"
            inputMode="decimal"
            value={outQty}
            onChange={(e) => setOutQty(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="merger-in">{t("inQty")}</Label>
          <Input
            id="merger-in"
            inputMode="decimal"
            value={inQty}
            onChange={(e) => setInQty(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="merger-date">{t("date")}</Label>
          <Input
            id="merger-date"
            type="date"
            value={executedAt}
            onChange={(e) => setExecutedAt(e.target.value)}
            required
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={taxable}
          onChange={(e) => setTaxable(e.target.checked)}
          className="size-4"
        />
        {t("taxable")}
      </label>

      {taxable && (
        <div className="space-y-1.5">
          <Label htmlFor="merger-value">{t("marketValue")}</Label>
          <Input
            id="merger-value"
            inputMode="decimal"
            value={marketValue}
            onChange={(e) => setMarketValue(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">{t("marketValueHint")}</p>
        </div>
      )}

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
          {busy ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
