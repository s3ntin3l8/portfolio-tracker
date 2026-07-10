"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X, ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatMoney, cn } from "@/lib/utils";
import {
  IncomeEventsTable,
  TimelineColumnHeader,
  type IncomeEventRow,
} from "@/components/income/income-events-table";

/** Sum a year's events per currency (income can span currencies). */
function totalsByCurrency(events: IncomeEventRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of events) {
    totals[e.currency] = (totals[e.currency] ?? 0) + Number(e.amount);
  }
  return totals;
}

type StatusFilter = "all" | "received" | "forecast";

/**
 * "Payments timeline" card — year dropdown + received/forecast chips + search over
 * the merged historical/upcoming rows, grouped by year (newest first, next-year
 * forecasts split into their own section) after filtering. Filters are local,
 * ephemeral `useState` (matches the Activity/transactions and Trades pages — not
 * URL-persisted).
 */
export function IncomeTimeline({
  rows,
  locale,
}: {
  rows: IncomeEventRow[];
  locale: string;
}) {
  const t = useTranslations("Income");
  const [yearFilter, setYearFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const yearOptions = useMemo(
    () => [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (yearFilter !== "all" && r.date.slice(0, 4) !== yearFilter) return false;
      const forecast = Boolean(r.status);
      if (statusFilter === "received" && forecast) return false;
      if (statusFilter === "forecast" && !forecast) return false;
      if (!q) return true;
      const symbol = r.symbol?.toLowerCase() ?? "";
      const name = r.name?.toLowerCase() ?? "";
      return symbol.includes(q) || name.includes(q);
    });
  }, [rows, yearFilter, statusFilter, query]);

  // Group + sort (newest-first) — same logic the page used to run unfiltered.
  const byYear = new Map<string, IncomeEventRow[]>();
  for (const r of filteredRows) {
    const year = r.date.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(r);
    byYear.set(year, bucket);
  }
  for (const bucket of byYear.values()) {
    bucket.sort((a, b) => b.date.localeCompare(a.date));
  }

  // Split off next-year projected rows into a dedicated section to avoid mixing
  // them with historical/current-year rows and to surface their assumptions clearly.
  const nextYearStr = String(new Date().getUTCFullYear() + 1);
  const nextYearRows = byYear.get(nextYearStr) ?? [];
  byYear.delete(nextYearStr);

  const hasGrowth = nextYearRows.some((r) => r.status === "grown");
  const hasContributions = nextYearRows.some((r) => r.assumesContributions);

  const yearSubtitle = (yearRows: IncomeEventRow[]): string => {
    const anyForecast = yearRows.some((r) => r.status);
    const anyReceived = yearRows.some((r) => !r.status);
    return anyForecast
      ? anyReceived
        ? t("yearReceivedForecast")
        : t("yearForecast")
      : t("yearReceived");
  };
  const subtotalOf = (yearRows: IncomeEventRow[]): string =>
    Object.entries(totalsByCurrency(yearRows))
      .map(([cur, amount]) => formatMoney(amount, cur, locale))
      .join(" · ");

  const timelineGroups: {
    year: string;
    rows: IncomeEventRow[];
    subtitle: string;
    subtotal: string;
    assumptions?: ReactNode;
  }[] = [];
  if (nextYearRows.length > 0) {
    timelineGroups.push({
      year: nextYearStr,
      rows: nextYearRows,
      subtitle: yearSubtitle(nextYearRows),
      subtotal: subtotalOf(nextYearRows),
      assumptions: (
        <>
          {t("assumptionsBase")}
          {hasGrowth && <> {t("assumptionsGrowth")}</>}
          {hasContributions && <> {t("assumptionsContributions")}</>}
        </>
      ),
    });
  }
  for (const [year, yearRows] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    timelineGroups.push({
      year,
      rows: yearRows,
      subtitle: yearSubtitle(yearRows),
      subtotal: subtotalOf(yearRows),
    });
  }

  return (
    <div className="rounded-[20px] bg-card p-[22px] shadow-card">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold">{t("paymentsTimelineTitle")}</h2>
          <p className="mt-0.5 text-xs font-medium text-text-2">{t("paymentsTimelineSubtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3.5 text-[11px] font-semibold text-text-2">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-success" />
            {t("legendReceived")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: "rgba(16,163,114,.12)", border: "1.5px dashed #0E9F6E" }}
            />
            {t("legendForecast")}
          </span>
        </div>
      </div>

      {/* Filters — chips + year dropdown + search (same reference pattern as the
          Activity/transactions and Trades pages). */}
      <div className="mt-3 flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {(
            [
              ["all", t("filter_all")],
              ["received", t("legendReceived")],
              ["forecast", t("legendForecast")],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              className={cn(
                "whitespace-nowrap rounded-full px-3.5 py-[7px] text-xs",
                statusFilter === key
                  ? "bg-pill font-bold text-white"
                  : "border border-border bg-card font-semibold text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          {yearOptions.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("filterYear")}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card pl-3 pr-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {yearFilter === "all" ? t("allYears") : yearFilter}
                  <ChevronDown className="size-3.5 shrink-0 text-text-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[9rem]">
                {["all", ...yearOptions].map((y) => (
                  <DropdownMenuItem
                    key={y}
                    onSelect={() => setYearFilter(y)}
                    className="justify-between gap-3"
                  >
                    {y === "all" ? t("allYears") : y}
                    {yearFilter === y && <Check className="size-4 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="relative flex items-center sm:ml-auto">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full pl-7 pr-7 text-xs sm:w-44"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("searchClear")}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {timelineGroups.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <>
          <TimelineColumnHeader />

          {timelineGroups.map((g) => (
            <div key={g.year} className="mt-3.5">
              <div className="sticky top-0 z-[2] flex items-baseline justify-between border-b border-border bg-card/95 py-2 backdrop-blur-sm">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-[15px] font-extrabold">{g.year}</span>
                  <span className="text-[11px] font-semibold text-text-3">{g.subtitle}</span>
                </div>
                <span className="tabular text-[13px] font-bold text-text-mute">{g.subtotal}</span>
              </div>
              {g.assumptions && <p className="pt-2 text-xs text-text-2">{g.assumptions}</p>}
              <IncomeEventsTable rows={g.rows} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
