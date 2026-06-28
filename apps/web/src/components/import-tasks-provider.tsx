"use client";

import { createContext, useContext, useMemo } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { accountMismatchFromError } from "@portfolio/api-client";
import { useRouter } from "@/i18n/navigation";
import { useImportClient } from "@/lib/use-import-client";
import { importSkipReason } from "@/lib/import-errors";
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

/**
 * Sum the server-reported counts of a materialize/confirm task into `{ count, excluded }`.
 * `onProgress(current, total, addedSoFar)` fires before each materialize unit (the file
 * about to be written) so the caller can show live per-file progress.
 */
async function runWrites(
  client: ImportClient,
  task: ImportTask,
  onProgress?: (current: number, total: number, addedSoFar: number) => void,
) {
  let count = 0;
  let excluded = 0;
  if (task.kind === "materialize") {
    const units = task.units ?? [];
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]!;
      onProgress?.(i + 1, units.length, count);
      const r = await client.materializeImport(
        unit.importId,
        unit.portfolioId,
        task.acknowledge,
      );
      count += r.materializedCount;
      excluded += r.excludedCashMovements;
    }
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
  }
  return { count, excluded };
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
 * the same task with `acknowledge: true` (the modal is gone, so recovery lives here).
 */
export function ImportTasksProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Import");
  const router = useRouter();
  const client = useImportClient();

  const value = useMemo<ImportTasksContextValue>(() => {
    async function execute(task: ImportTask, id: string | number) {
      toast.loading(t("toast.importing", { label: task.label }), { id });
      try {
        const { count, excluded } = await runWrites(
          client,
          task,
          (current, total, addedSoFar) => {
            // Live per-file progress only makes sense for a multi-file import.
            if (total > 1) {
              toast.loading(t("toast.importingProgress", { current, total }), {
                id,
                description:
                  addedSoFar > 0 ? t("toast.addedSoFar", { count: addedSoFar }) : undefined,
              });
            }
          },
        );
        router.refresh(); // surface the new transactions on whatever screen is open

        // "Imported X of Y" when some drafts didn't land; split the gap into cash
        // (excluded by the portfolio's boundary) vs duplicates the server collapsed.
        const expected = task.expectedCount;
        const shortfall = expected != null ? Math.max(0, expected - count) : 0;
        const cash = excluded;
        const dups = Math.max(0, shortfall - cash);
        const message =
          shortfall > 0
            ? t("toast.successOfTotal", { count, total: expected! })
            : t("toast.success", { count });
        const description =
          [
            cash > 0 ? t("toast.excluded", { count: cash }) : null,
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
        const mismatch = accountMismatchFromError(err);
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
              onClick: () => void execute({ ...task, acknowledge: true }, id),
            },
          });
        } else {
          // The modal is gone, so the only way back is a toast action. Drafts are still
          // staged server-side, so a retry replays the same task.
          toast.error(t("toast.error"), {
            id,
            description: t(`errors.${importSkipReason(err)}`),
            action: {
              label: t("toast.retry"),
              onClick: () => void execute(task, id),
            },
          });
        }
      }
    }

    return {
      run(task: ImportTask) {
        const id = toast.loading(t("toast.importing", { label: task.label }));
        void execute(task, id);
      },
    };
  }, [client, router, t]);

  return (
    <ImportTasksContext.Provider value={value}>{children}</ImportTasksContext.Provider>
  );
}
