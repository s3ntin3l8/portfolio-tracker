"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ImportFlow,
  type ImportTargetPortfolio,
} from "@/components/import-flow";
import { useImportClient } from "@/lib/use-import-client";
import { useImportTasks } from "@/components/import-tasks-provider";
import { useRouter, usePathname } from "@/i18n/navigation";

// Must match SHARE_CACHE / SHARE_KEY in src/app/sw.ts — where the share-target handler
// stashes the shared screenshot.
const SHARE_CACHE = "share-target";
const SHARE_KEY = "/shared-image";

/** Pull the screenshot the SW stashed for a `?shared=1` navigation, then clear it. */
async function takeSharedImage(): Promise<File | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(SHARE_KEY);
  if (!res) return null;
  const blob = await res.blob();
  await cache.delete(SHARE_KEY);
  const type = blob.type || "image/png";
  const ext = type.split("/")[1] ?? "png";
  return new File([blob], `shared.${ext}`, { type });
}

/**
 * Wires the import flow to the real API. Parsing stays inline (the user reviews drafts and
 * picks a portfolio); the final write is handed to the shell-level `ImportTasksProvider`
 * via `onSubmit`, which closes the modal (`onClose`) and tracks status in a toast.
 */
export function ImportFlowClient({
  portfolios,
  defaultPortfolioId,
  onClose,
}: {
  portfolios: ImportTargetPortfolio[];
  defaultPortfolioId: string;
  onClose?: () => void;
}) {
  const client = useImportClient();
  const { run } = useImportTasks();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [sharedFile, setSharedFile] = useState<File | null>(null);

  // A screenshot shared into the app lands here as `?shared=1` (see sw.ts). Pull it from
  // the cache, feed it to the flow, and drop the query param so a refresh doesn't replay.
  useEffect(() => {
    if (searchParams.get("shared") !== "1") return;
    let active = true;
    void takeSharedImage().then((file) => {
      if (active && file) setSharedFile(file);
      router.replace(pathname);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ImportFlow
      client={client}
      portfolios={portfolios}
      defaultPortfolioId={defaultPortfolioId}
      initialFile={sharedFile}
      onSubmit={run}
      onClose={onClose}
    />
  );
}
