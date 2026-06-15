"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, X } from "lucide-react";
import type { ApiClient, Instrument } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/** The slice of the API client this form needs (injectable for tests). */
export type RecordCorpActionClient = Pick<
  ApiClient,
  "searchInstruments" | "createCorporateAction"
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
  const [selected, setSelected] = useState<Instrument | null>(null);
  const [type, setType] = useState<CaType>("split");
  const [ratio, setRatio] = useState("");
  const [exDate, setExDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!selected) {
      setError(t("needInstrument"));
      return;
    }
    setBusy(true);
    setError(null);
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
          </>
        )}
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
