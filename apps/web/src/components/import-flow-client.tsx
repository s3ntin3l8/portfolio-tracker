"use client";

import {
  ImportFlow,
  type ImportClient,
  type ImportResult,
} from "@/components/import-flow";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

/**
 * Wires the import flow to the real API. The api-client returns ParsedTransaction
 * drafts (executedAt typed as Date) while ImportFlow works with string dates; they
 * are the same JSON over the wire, so the boundary is bridged with casts here.
 */
export function ImportFlowClient({ portfolioId }: { portfolioId: string }) {
  const api = useApiClient();
  const router = useRouter();

  const client: ImportClient = {
    importScreenshot: (pid, image, mimeType) =>
      api.importScreenshot(pid, image, mimeType) as unknown as Promise<ImportResult>,
    importCsv: (pid, content, format) =>
      api.importCsv(pid, content, format) as unknown as Promise<ImportResult>,
    confirmImport: async (importId, drafts) => {
      const res = await api.confirmImport(
        importId,
        drafts as unknown as Parameters<typeof api.confirmImport>[1],
      );
      router.refresh(); // surface the new transactions on other screens
      return res;
    },
  };

  return <ImportFlow client={client} portfolioId={portfolioId} />;
}
