"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import type { GlobalSearchResult, SearchInstrumentResult, SearchTransactionResult } from "@portfolio/api-client";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

export function GlobalSearch({ holderId }: { holderId?: string | null }) {
  const t = useTranslations("Search");
  const client = useApiClient();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<GlobalSearchResult | null>(null);

  // Debounce timer + stale-response guard.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestQueryRef = useRef<string>("");

  // Keyboard shortcut: Cmd/Ctrl-K (always), "/" (only when not in a text field).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !open) {
        const tag = (document.activeElement?.tagName ?? "").toUpperCase();
        const isEditable =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          document.activeElement?.getAttribute("contenteditable") === "true";
        if (!isEditable) {
          e.preventDefault();
          setOpen(true);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Reset state when palette closes.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setResults(null);
      setLoading(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }

  // Debounced search with stale-response guard.
  const runSearch = useCallback(
    (q: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const trimmed = q.trim();
      if (!trimmed) {
        setLoading(false);
        setResults(null);
        return;
      }
      setLoading(true);
      latestQueryRef.current = trimmed;
      timerRef.current = setTimeout(async () => {
        try {
          const data = await client.globalSearch({
            q: trimmed,
            holderId: holderId ?? undefined,
            limit: 10,
          });
          // Drop stale responses.
          if (latestQueryRef.current !== trimmed) return;
          setResults(data);
        } finally {
          if (latestQueryRef.current === trimmed) setLoading(false);
        }
      }, DEBOUNCE_MS);
    },
    [client, holderId],
  );

  function handleQueryChange(value: string) {
    setQuery(value);
    runSearch(value);
  }

  function navigate(path: string) {
    handleOpenChange(false);
    router.push(path);
  }

  function selectInstrument(instr: SearchInstrumentResult) {
    navigate(`/instruments/${instr.id}`);
  }

  function selectTransaction(tx: SearchTransactionResult) {
    navigate(`/transactions/${tx.id}/edit`);
  }

  const instruments = results?.instruments ?? [];
  const transactions = results?.transactions ?? [];
  const hasResults = instruments.length > 0 || transactions.length > 0;
  const trimmedQuery = query.trim();

  // Determine which single empty-state message to show (mutually exclusive).
  let emptyContent: string | null = null;
  if (trimmedQuery === "") emptyContent = t("hint");
  else if (loading && !hasResults) emptyContent = t("searching");
  else if (!loading && !hasResults) emptyContent = t("noResults");

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("triggerLabel")}
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
      </Button>

      <CommandDialog open={open} onOpenChange={handleOpenChange}>
        {/* shouldFilter=false: results come from server ILIKE; cmdk must not re-filter */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("placeholder")}
            value={query}
            onValueChange={handleQueryChange}
          />
          <CommandList>
            {emptyContent !== null && (
              <CommandEmpty>{emptyContent}</CommandEmpty>
            )}

            {instruments.length > 0 && (
              <CommandGroup heading={t("groupInstruments")}>
                {instruments.map((instr) => (
                  <CommandItem
                    key={instr.id}
                    value={`instrument-${instr.id}`}
                    onSelect={() => selectInstrument(instr)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="font-mono text-sm font-medium">{instr.symbol}</span>
                      <span className="min-w-0 truncate text-sm text-muted-foreground">
                        {instr.name}
                      </span>
                    </div>
                    {!instr.owned && (
                      <span
                        className={cn(
                          "ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground",
                        )}
                      >
                        {t("catalogBadge")}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {transactions.length > 0 && (
              <CommandGroup heading={t("groupTransactions")}>
                {transactions.map((tx) => (
                  <CommandItem
                    key={tx.id}
                    value={`transaction-${tx.id}`}
                    onSelect={() => selectTransaction(tx)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize">
                          {tx.type.replace(/_/g, " ")}
                        </span>
                        {tx.instrument && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {tx.instrument.symbol}
                          </span>
                        )}
                      </div>
                      {(tx.description ?? tx.portfolioName) && (
                        <span className="truncate text-xs text-muted-foreground">
                          {tx.description ?? tx.portfolioName}
                        </span>
                      )}
                    </div>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {new Date(tx.executedAt).toLocaleDateString()}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
