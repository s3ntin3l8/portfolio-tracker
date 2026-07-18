"use client";

import { useEffect, useState } from "react";
import type { ApiClient, TrConnection } from "@portfolio/api-client";
import { Spinner } from "@/components/ui/spinner";
import { TrConnectFlow } from "@/components/tr-connect-flow";
import type { OnboardingTheme } from "../theme";

/**
 * The "Connect Trade Republic" add-data card opens this dedicated sub-step (not the
 * portfolio-edit dialog) — it reuses the real `TrConnectFlow` (same connecting/
 * awaiting/connected states as everywhere else) against the portfolio just created in
 * this flow, and calls `onConnected` once the connection actually completes.
 */
export function AddDataTrConnect({
  th,
  api,
  portfolioId,
  cashCounted,
  onConnected,
  loadingLabel,
  unavailableLabel,
}: {
  th: OnboardingTheme;
  api: Pick<
    ApiClient,
    | "connectTr"
    | "verifyTr"
    | "syncTr"
    | "disconnectTr"
    | "getTrConnection"
    | "reimportTr"
    | "reprocessTrDocuments"
  >;
  portfolioId: string;
  cashCounted: boolean;
  onConnected: () => void;
  loadingLabel: string;
  unavailableLabel: string;
}) {
  const [connection, setConnection] = useState<TrConnection | null | false>(null);

  useEffect(() => {
    let active = true;
    api
      .getTrConnection()
      .then((conn) => {
        if (active) setConnection(conn);
      })
      .catch(() => {
        if (active) setConnection(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- api is stable (memoized by useApiClient)
  }, []);

  async function handleChanged() {
    try {
      const conn = await api.getTrConnection();
      setConnection(conn);
      if (conn.status === "connected") onConnected();
    } catch {
      // Leave the last known state on screen — TrConnectFlow surfaces its own errors.
    }
  }

  if (connection === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "24px 0" }}>
        <Spinner size="sm" />
        <span style={{ font: "500 13px 'Plus Jakarta Sans'", color: th.subColor }}>
          {loadingLabel}
        </span>
      </div>
    );
  }
  if (connection === false) {
    return (
      <p style={{ font: "500 13px 'Plus Jakarta Sans'", color: th.subColor }}>{unavailableLabel}</p>
    );
  }

  return (
    <TrConnectFlow
      client={api}
      portfolioId={portfolioId}
      cashCounted={cashCounted}
      initial={connection}
      onChanged={handleChanged}
    />
  );
}
