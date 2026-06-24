"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { EditablePortfolio } from "@/components/portfolio-form-dialog";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300_000; // 5 min — same ceiling as runner exportTimeoutMs

export interface PortfolioSyncConfig {
  initialSyncing: boolean;
}

/**
 * The ⋯ overflow menu on a portfolio card.
 * Lives in its own client component so the server-side card can remain RSC
 * while the DropdownMenu + Dialog interaction (which requires client event
 * handlers) is isolated here.
 *
 * Pass `trSync` / `ibkrSync` when the portfolio has an active TR / IBKR connection
 * respectively — the menu will show a Sync item and the trigger icon spins while
 * a sync is in flight.
 */
export function PortfolioCardMenu({
  portfolio,
  trSync,
  ibkrSync,
}: {
  portfolio: EditablePortfolio;
  trSync?: PortfolioSyncConfig;
  ibkrSync?: PortfolioSyncConfig;
}) {
  const tf = useTranslations("PortfolioForm");
  const ttr = useTranslations("TradeRepublic");
  const tibkr = useTranslations("InteractiveBrokers");
  const api = useApiClient();
  const router = useRouter();

  // ─── TR sync ─────────────────────────────────────────────────────────────────
  const [trSyncing, setTrSyncing] = useState(trSync?.initialSyncing ?? false);
  const trPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trTickRef = useRef<number>(0);

  function stopTrPoll() {
    if (trPollRef.current !== null) {
      clearInterval(trPollRef.current);
      trPollRef.current = null;
    }
  }

  function startTrPoll() {
    stopTrPoll();
    trTickRef.current = 0;
    trPollRef.current = setInterval(() => void pollTr(), POLL_INTERVAL_MS);
  }

  async function pollTr() {
    trTickRef.current += 1;
    if (trTickRef.current * POLL_INTERVAL_MS > POLL_TIMEOUT_MS) {
      stopTrPoll();
      setTrSyncing(false);
      toast.error(ttr("errors.tr_sync_failed"));
      return;
    }
    try {
      const conn = await api.getTrConnection();
      if (!conn.syncing) {
        stopTrPoll();
        setTrSyncing(false);
        if (conn.lastError) toast.error(conn.lastError);
        else router.refresh();
      }
    } catch {
      // transient — keep polling
    }
  }

  async function handleTrSync() {
    if (trSyncing) return;
    setTrSyncing(true);
    try {
      await api.syncTr();
      startTrPoll();
    } catch {
      setTrSyncing(false);
      toast.error(ttr("errors.tr_sync_failed"));
    }
  }

  useEffect(() => {
    if (trSync?.initialSyncing) startTrPoll();
    return () => stopTrPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── IBKR sync ───────────────────────────────────────────────────────────────
  const [ibkrSyncing, setIbkrSyncing] = useState(ibkrSync?.initialSyncing ?? false);
  const ibkrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ibkrTickRef = useRef<number>(0);

  function stopIbkrPoll() {
    if (ibkrPollRef.current !== null) {
      clearInterval(ibkrPollRef.current);
      ibkrPollRef.current = null;
    }
  }

  function startIbkrPoll() {
    stopIbkrPoll();
    ibkrTickRef.current = 0;
    ibkrPollRef.current = setInterval(() => void pollIbkr(), POLL_INTERVAL_MS);
  }

  async function pollIbkr() {
    ibkrTickRef.current += 1;
    if (ibkrTickRef.current * POLL_INTERVAL_MS > POLL_TIMEOUT_MS) {
      stopIbkrPoll();
      setIbkrSyncing(false);
      toast.error(tibkr("errors.ibkr_sync_failed"));
      return;
    }
    try {
      const conn = await api.getIbkrConnection();
      if (!conn.syncing) {
        stopIbkrPoll();
        setIbkrSyncing(false);
        if (conn.lastError) toast.error(conn.lastError);
        else router.refresh();
      }
    } catch {
      // transient — keep polling
    }
  }

  async function handleIbkrSync() {
    if (ibkrSyncing) return;
    setIbkrSyncing(true);
    try {
      await api.syncIbkr();
      startIbkrPoll();
    } catch {
      setIbkrSyncing(false);
      toast.error(tibkr("errors.ibkr_sync_failed"));
    }
  }

  useEffect(() => {
    if (ibkrSync?.initialSyncing) startIbkrPoll();
    return () => stopIbkrPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Delete ──────────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: Event) {
    e.preventDefault(); // keep menu open during the two-step confirm flow
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await api.deletePortfolio(portfolio.id);
      // Drop the switcher's selection if it pointed at the now-deleted portfolio.
      if (document.cookie.includes(`${SELECTED_PORTFOLIO_COOKIE}=${portfolio.id}`)) {
        document.cookie = `${SELECTED_PORTFOLIO_COOKIE}=all; path=/; max-age=0; samesite=lax`;
      }
      router.refresh();
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────────
  const anySyncing = trSyncing || ibkrSyncing;

  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="More options">
          {anySyncing ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <MoreHorizontal className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PortfolioFormDialog
          mode="edit"
          portfolio={portfolio}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Pencil className="size-4" />
              {tf("edit")}
            </DropdownMenuItem>
          }
        />

        {trSync && (
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); void handleTrSync(); }}
            disabled={trSyncing}
          >
            <RefreshCw className={cn("size-4", trSyncing && "animate-spin")} />
            {ttr("syncNow")}
          </DropdownMenuItem>
        )}

        {ibkrSync && (
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); void handleIbkrSync(); }}
            disabled={ibkrSyncing}
          >
            <RefreshCw className={cn("size-4", ibkrSyncing && "animate-spin")} />
            {tibkr("syncNow")}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={(e) => void handleDelete(e)}
          disabled={deleting}
          className={cn(confirmDelete && "text-destructive focus:text-destructive")}
        >
          <Trash2 className="size-4" />
          {confirmDelete ? tf("confirmDelete") : tf("delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
