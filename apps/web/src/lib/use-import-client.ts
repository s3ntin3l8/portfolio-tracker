"use client";

import { useMemo } from "react";
import { useApiClient } from "@/lib/api";
import type { ImportClient, ImportResult } from "@/components/import-flow";

/**
 * Builds the {@link ImportClient} the import flow needs, bound to the session via
 * {@link useApiClient}. Shared by `ImportFlowClient` (parse) and `ImportTasksProvider`
 * (the backgrounded materialize/confirm write) so both speak to the API the same way.
 *
 * The api-client returns ParsedTransaction drafts (executedAt typed as Date) while the
 * import flow works with string dates; they are the same JSON over the wire, so the
 * boundary is bridged with casts here.
 *
 * Note: route revalidation (`router.refresh()`) lives in `ImportTasksProvider` — the
 * always-mounted owner of the write — not in this adapter, so it fires exactly once.
 */
export function useImportClient(): ImportClient {
  const api = useApiClient();
  return useMemo<ImportClient>(
    () => ({
      importScreenshot: (file, force, batchId) =>
        api.importScreenshot(file, force, batchId) as unknown as Promise<ImportResult>,
      importCsv: (content, filename, format, force, batchId) =>
        api.importCsv(content, filename, format, force, batchId) as unknown as Promise<ImportResult>,
      confirmImport: (
        importId,
        drafts,
        contracts,
        portfolioId,
        acknowledgeAccountMismatch,
        acknowledgeDuplicates,
      ) =>
        api.confirmImport(
          importId,
          drafts as unknown as Parameters<typeof api.confirmImport>[1],
          contracts as unknown as Parameters<typeof api.confirmImport>[2],
          portfolioId,
          acknowledgeAccountMismatch,
          acknowledgeDuplicates,
        ),
      materializeImport: (importId, portfolioId, acknowledgeAccountMismatch) =>
        api.materializeImport(importId, portfolioId, acknowledgeAccountMismatch),
      checkAccounts: (units) => api.checkAccounts(units),
      uploadDocument: (file, opts) => api.uploadDocument(file, opts),
    }),
    [api],
  );
}
