"use client";

import { createContext, useContext, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { getSession } from "next-auth/react";
import { accountMismatchFromError } from "@portfolio/api-client";
import { useRouter } from "@/i18n/navigation";
import { useImportClient } from "@/lib/use-import-client";
import { classifyImportError, importErrorDetail } from "@/lib/import-errors";
import { mapPool, IMPORT_CONCURRENCY } from "@/lib/promise-pool";
import type { ImportClient, ImportTask } from "@/components/import-flow";

export interface ImportTasksContextValue {
  /** Fire-and-forget: run an import's write in the background, driving a status toast. */
  run(task: ImportTask): void;
}

const ImportTasksContext = createContext<ImportTasksContextValue | null>(null);

/**
 * Access the shell-level import runner. Throws if used outside `ImportTasksProvider`
 * (i.e. the provider isn't mounted in the app layout).
 */
export function useImportTasks(): ImportTasksContextValue {
  const ctx = useContext(ImportTasksContext);
  if (!ctx) throw new Error("useImportTasks must be used within an ImportTasksProvider");
  return ctx;
}

/** Progress carried across a retry so it resumes from the failure instead of re-running unit 0. */
interface WriteProgress {
  /** importIds already written OK — skipped on the next attempt. */
  doneImportIds: string[];
  /** Rows written so far (carried into the final "imported X of Y" total). */
  count: number;
  /** Cash movements excluded so far (boundary), carried into the toast description. */
  excluded: number;
  /** Drafts that matched an existing transaction and had their detail folded in (source
   *  provenance + tax/fee/venue rollup) rather than being dropped — carried so the toast
   *  can say "merged" instead of implying they were discarded. */
  enriched: number;
}

const emptyProgress = (): WriteProgress => ({
  doneImportIds: [],
  count: 0,
  excluded: 0,
  enriched: 0,
});

/** Monotonic toast-id source so concurrent imports get independent toasts (no throwaway paint). */
let toastSeq = 0;

/**
 * Thrown when some — but not all — materialize units failed. Carries the partial progress so the
 * Retry action can resume from the un-written units, plus the first underlying error for
 * classification (e.g. a 401 session-expiry or a 409 account-mismatch backstop).
 */
class PartialWriteError extends Error {
  constructor(
    readonly underlying: unknown,
    readonly progress: WriteProgress,
  ) {
    super("partial_write");
    this.name = "PartialWriteError";
  }
}

/**
 * Materialize the given units with bounded concurrency. Each unit catches its own error (so one
 * failure doesn't abort the others), and after the pool drains: if every unit succeeded, returns
 * the summed counts; otherwise throws a {@link PartialWriteError} carrying which units DID land so
 * a retry can resume. `onProgress(totalDone, addedThisPass)` fires as each unit lands —
 * `addedThisPass` is the running row count written so far in this pass (drives the live toast).
 */
async function materializeUnits(
  client: ImportClient,
  units: { importId: string; portfolioId: string }[],
  acknowledge: boolean,
  startedDone: number,
  onProgress: (totalDone: number, addedThisPass: number) => void,
) {
  let completed = 0;
  let added = 0;
  const outcomes = await mapPool(units, IMPORT_CONCURRENCY, async (unit) => {
    try {
      const r = await client.materializeImport(unit.importId, unit.portfolioId, acknowledge);
      completed++;
      added += r.materializedCount;
      onProgress(startedDone + completed, added);
      return {
        ok: true as const,
        importId: unit.importId,
        count: r.materializedCount,
        excluded: r.excludedCashMovements,
        enriched: r.enrichedCount,
      };
    } catch (err) {
      return { ok: false as const, importId: unit.importId, err };
    }
  });

  const ok = outcomes.filter((o) => o.ok);
  const count = ok.reduce((s, o) => s + (o.ok ? o.count : 0), 0);
  const excluded = ok.reduce((s, o) => s + (o.ok ? o.excluded : 0), 0);
  const enriched = ok.reduce((s, o) => s + (o.ok ? o.enriched : 0), 0);
  const doneImportIds = ok.map((o) => o.importId);
  const failed = outcomes.find((o) => !o.ok);
  if (failed && !failed.ok) {
    throw new PartialWriteError(failed.err, { doneImportIds, count, excluded, enriched });
  }
  return { count, excluded, enriched, doneImportIds };
}

/**
 * Owns the background import write so it survives the import modal closing and page
 * navigation. The modal hands off a plain-data {@link ImportTask} via `run()`, closes
 * immediately, and this provider — mounted once in the app shell next to `<Toaster>` —
 * executes the materialize/confirm calls and drives a single status toast through
 * loading → success / error.
 *
 * Because each `run()` mints its own toast id, concurrent imports get independent toasts.
 * On a 409 account-mismatch the error toast carries an "Import anyway" action that replays
 * the same task with `acknowledge: true`. On any other failure (e.g. a session-expiry 401)
 * the Retry action resumes from the un-written units — the client reads a fresh token, so the
 * retry succeeds rather than replaying the same stale request.
 */
export function ImportTasksProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Import");
  const router = useRouter();
  const client = useImportClient();

  const value = useMemo<ImportTasksContextValue>(() => {
    async function execute(task: ImportTask, id: string | number, carry: WriteProgress) {
      toast.loading(t("toast.importing", { label: task.label }), { id });
      try {
        let count = carry.count;
        let excluded = carry.excluded;
        let enriched = carry.enriched;

        if (task.kind === "materialize") {
          const allUnits = task.units ?? [];
          const remaining = allUnits.filter((u) => !carry.doneImportIds.includes(u.importId));
          const r = await materializeUnits(
            client,
            remaining,
            task.acknowledge,
            carry.doneImportIds.length,
            (totalDone, addedThisPass) => {
              // Live per-file progress only makes sense for a multi-file import.
              if (allUnits.length > 1) {
                // Rows added so far = carried-over (from a prior partial attempt) + this pass.
                const addedSoFar = carry.count + addedThisPass;
                toast.loading(
                  t("toast.importingProgress", { current: totalDone, total: allUnits.length }),
                  {
                    id,
                    description:
                      addedSoFar > 0 ? t("toast.addedSoFar", { count: addedSoFar }) : undefined,
                  },
                );
              }
            },
          );
          count += r.count;
          excluded += r.excluded;
          enriched += r.enriched;
        } else {
          const r = await client.confirmImport(
            task.importId ?? "",
            task.drafts ?? [],
            task.contracts,
            task.portfolioId,
            task.acknowledge,
          );
          count += r.confirmed;
          excluded += r.excludedCashMovements ?? 0;
          enriched += r.enriched ?? 0;
        }
        router.refresh(); // surface the new transactions on whatever screen is open

        // "Imported X of Y" when some drafts didn't land; split the gap into cash (excluded
        // by the portfolio's boundary), matches that got merged into an existing transaction
        // (not dropped — the server already tells us this count, see `enriched`), and only
        // whatever's left over as genuine duplicates.
        const expected = task.expectedCount;
        const shortfall = expected != null ? Math.max(0, expected - count) : 0;
        const cash = excluded;
        const merged = Math.min(Math.max(0, shortfall - cash), enriched);
        const dups = Math.max(0, shortfall - cash - merged);
        const message =
          shortfall > 0
            ? t("toast.successOfTotal", { count, total: expected! })
            : t("toast.success", { count });
        const description =
          [
            cash > 0 ? t("toast.excluded", { count: cash }) : null,
            merged > 0 ? t("toast.enriched", { count: merged }) : null,
            dups > 0 ? t("toast.skipped", { count: dups }) : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined;

        toast.success(message, {
          id,
          description,
          action: {
            label: t("toast.viewTransactions"),
            onClick: () => router.push("/transactions"),
          },
        });
      } catch (err) {
        // Unwrap a partial-write so the retry resumes from the units that didn't land, and so
        // the underlying error (401 / 409 / …) is classified rather than our wrapper.
        const partial = err instanceof PartialWriteError ? err : null;
        const underlying = partial ? partial.underlying : err;
        const nextCarry: WriteProgress = partial
          ? {
              doneImportIds: [...carry.doneImportIds, ...partial.progress.doneImportIds],
              count: carry.count + partial.progress.count,
              excluded: carry.excluded + partial.progress.excluded,
              enriched: carry.enriched + partial.progress.enriched,
            }
          : carry;

        const mismatch = accountMismatchFromError(underlying);
        if (mismatch) {
          const description =
            mismatch.kind === "other_portfolio"
              ? t("accountMismatch.otherPortfolio", {
                  portfolio: mismatch.matchedName ?? "",
                  account: mismatch.detected,
                })
              : t("accountMismatch.noMatch", { account: mismatch.detected });
          toast.error(t("toast.error"), {
            id,
            description,
            duration: Infinity, // keep it up until the user decides
            action: {
              label: t("accountMismatch.importAnyway"),
              onClick: () => void execute({ ...task, acknowledge: true }, id, nextCarry),
            },
          });
        } else {
          // The modal is gone, so the only way back is a toast action. Drafts are still staged
          // server-side, so Retry replays the remaining units (with a fresh token).
          const info = classifyImportError(underlying);
          const detail = info.reason === "generic" ? importErrorDetail(info) : null;
          const description = detail
            ? t("errors.genericDetailed", { detail })
            : t(`errors.${info.reason}`, { provider: info.provider ?? "" });
          const retry = async () => {
            // A session-expiry retry must force a token refresh first: replaying immediately would
            // re-send the same stale token, because SessionProvider's focus-refetch may not have
            // landed yet when the user clicks. `getSession()` round-trips and rotates the token,
            // and the api-client reads it live (lib/api.ts), so the resumed write authenticates.
            if (info.reason === "sessionExpired") await getSession();
            await execute(task, id, nextCarry);
          };
          toast.error(t("toast.error"), {
            id,
            description,
            action: {
              label: t("toast.retry"),
              onClick: () => void retry(),
            },
          });
        }
      }
    }

    return {
      run(task: ImportTask) {
        // Mint a unique toast id WITHOUT painting a throwaway loading toast — execute() owns the
        // initial loading state, so a single toast drives the whole lifecycle.
        const id = `import-${++toastSeq}`;
        void execute(task, id, emptyProgress());
      },
    };
  }, [client, router, t]);

  return <ImportTasksContext.Provider value={value}>{children}</ImportTasksContext.Provider>;
}
