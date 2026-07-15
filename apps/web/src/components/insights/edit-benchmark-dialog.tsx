"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Search, X, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { benchmarkLabel } from "@/lib/benchmark-labels";
import type { InstrumentSearchResult } from "@portfolio/api-client";

const SUGGESTED = ["^GSPC", "^DJI", "^IXIC", "^GDAXI", "^N225", "^HSI", "^JKSE", "^STOXX50E", "^FTSE"] as const;

export function EditBenchmarkDialog({
  open,
  onOpenChange,
  currentSymbol,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSymbol: string | null;
  onSaved: () => void;
}) {
  const t = useTranslations("Insights.benchmark");
  const api = useApiClient();
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<InstrumentSearchResult | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedSymbol = selected?.symbol ?? currentSymbol;

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await api.lookupInstruments(trimmed);
        setResults(res);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [api]);

  const handleSave = async (symbol: string | null) => {
    setSaving(true);
    try {
      await api.putPreferences({ benchmarkSymbol: symbol, riskFreeRate: null });
      onSaved();
      router.refresh();
      onOpenChange(false);
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  const handleSelect = (r: InstrumentSearchResult) => {
    setSelected(r);
    setQuery("");
    setResults([]);
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) {
      setQuery("");
      setResults([]);
      setSelected(null);
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editBenchmark")}</DialogTitle>
          <DialogDescription>{t("editBenchmarkHint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-3" />
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); runSearch(e.target.value); }}
              placeholder={t("searchBenchmark")}
              className="h-10 pl-9 pr-9 text-sm"
            />
            {loading && (
              <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-text-3" />
            )}
          </div>

          {query.trim() === "" && results.length === 0 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-3">
                <Sparkles className="size-3.5" />
                {t("suggested")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED.map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => {
                      setSelected({ symbol: sym, name: benchmarkLabel(sym), market: "", assetClass: "", currency: "USD", source: "" });
                      setQuery("");
                    }}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      selectedSymbol === sym
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-secondary-foreground hover:bg-accent"
                    }`}
                  >
                    {benchmarkLabel(sym)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border">
              {results.map((r) => (
                <button
                  key={r.symbol}
                  type="button"
                  onClick={() => handleSelect(r)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                    selectedSymbol === r.symbol ? "bg-accent font-medium" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{r.symbol}</span>
                    {r.name && <span className="ml-1.5 text-text-3">{r.name}</span>}
                  </span>
                  {r.currency && <span className="shrink-0 text-xs text-text-3">{r.currency}</span>}
                </button>
              ))}
            </div>
          )}

          {selectedSymbol && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-accent/50 px-3 py-2">
              <span className="flex-1 text-sm font-medium">{benchmarkLabel(selectedSymbol)}</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-full p-0.5 text-text-3 transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {currentSymbol && (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => handleSave(null)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-4" />
                {t("remove")}
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={saving}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                disabled={!selectedSymbol || saving || selectedSymbol === currentSymbol}
                onClick={() => handleSave(selectedSymbol)}
              >
                {saving ? t("saving") : t("save")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
