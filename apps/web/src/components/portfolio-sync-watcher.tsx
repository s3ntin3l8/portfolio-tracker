"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import type { PortfolioSyncConfig } from "@/components/portfolio-card-menu";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300_000; // 5 min — same ceiling as runner exportTimeoutMs

/**
 * Headless — no rendered output. Polls a portfolio's TR/IBKR sync status and calls
 * `router.refresh()` once it finishes, so the list's `SYNCING…`/`CONNECTED` status badge
 * (computed server-side in `settings/portfolios/page.tsx`) picks up the new state without
 * a manual reload.
 *
 * Extracted from `PortfolioCardMenu`'s poll effects (unchanged logic) so the list can keep
 * auto-updating a syncing portfolio's badge now that the card's `⋯` menu — and its "Sync
 * now" trigger — moved into the portfolio edit page (`portfolio-edit-form.tsx`'s connection
 * sections already run their own polling while that page is open; this component covers
 * the *list* view, where no menu/edit-page poller is mounted). No local "syncing" state of
 * its own — it doesn't render anything, so it only needs to know when to stop polling.
 */
export function PortfolioSyncWatcher({
  trSync,
  ibkrSync,
}: {
  trSync?: PortfolioSyncConfig;
  ibkrSync?: PortfolioSyncConfig;
}) {
  const ttr = useTranslations("TradeRepublic");
  const tibkr = useTranslations("InteractiveBrokers");
  const api = useApiClient();
  const router = useRouter();

  const trPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ibkrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!trSync?.initialSyncing) return;
    let tick = 0;
    const poll = async () => {
      tick += 1;
      if (tick * POLL_INTERVAL_MS > POLL_TIMEOUT_MS) {
        if (trPollRef.current !== null) clearInterval(trPollRef.current);
        toast.error(ttr("errors.tr_sync_failed"));
        return;
      }
      try {
        const conn = await api.getTrConnection();
        if (!conn.syncing) {
          if (trPollRef.current !== null) clearInterval(trPollRef.current);
          if (conn.lastError) toast.error(conn.lastError);
          else router.refresh();
        }
      } catch {
        // transient — keep polling
      }
    };
    trPollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (trPollRef.current !== null) clearInterval(trPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ibkrSync?.initialSyncing) return;
    let tick = 0;
    const poll = async () => {
      tick += 1;
      if (tick * POLL_INTERVAL_MS > POLL_TIMEOUT_MS) {
        if (ibkrPollRef.current !== null) clearInterval(ibkrPollRef.current);
        toast.error(tibkr("errors.ibkr_sync_failed"));
        return;
      }
      try {
        const conn = await api.getIbkrConnection();
        if (!conn.syncing) {
          if (ibkrPollRef.current !== null) clearInterval(ibkrPollRef.current);
          if (conn.lastError) toast.error(conn.lastError);
          else router.refresh();
        }
      } catch {
        // transient — keep polling
      }
    };
    ibkrPollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (ibkrPollRef.current !== null) clearInterval(ibkrPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
