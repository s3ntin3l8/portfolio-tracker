import { and, desc, eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { FastifyBaseLogger } from "fastify";
import { isAcquisitionType } from "@portfolio/core";
import {
  ibkrConnections,
  portfolios,
  screenshotImports,
  transactions,
  trResolvedEvents,
} from "@portfolio/db";
import type { ImportIssue, ParsedTransaction } from "@portfolio/schema";
import type { DB } from "../../db/client.js";
import type { EncryptionService } from "../encryption.js";
import type { IbkrFlexClient } from "./flex-client.js";
import { IbkrFlexError } from "./flex-client.js";
import { parseFlexXml, selectCashRows } from "./flex-parse.js";
import { mapFlexToDrafts } from "./mapper.js";
import { materializeDrafts } from "../materialize-drafts.js";
import type { CashReconciliation } from "../pytr/sync.js";

export type { CashReconciliation };

type IbkrConnectionRow = typeof ibkrConnections.$inferSelect;

export interface IbkrSyncResult {
  status: "connected" | "expired" | "error";
  importId?: string;
  drafts?: number;
  errors?: number;
  reconciliation?: CashReconciliation;
}

interface CollectorJson {
  drafts: ParsedTransaction[];
  errors: ImportIssue[];
}

/** Derive cash balances from Flex CashReport for reconciliation. */
function reconcileCash(
  drafts: ParsedTransaction[],
  cashReport: { currency: string; endingCash: string }[],
): CashReconciliation | undefined {
  if (cashReport.length === 0) return undefined;

  // NOTE: this runs over `allDrafts` (every event mapped this sync), not `newDrafts`.
  // The mapper re-emits the opening-balance deposit every sync, so it is always counted
  // here even after it has been deduped out of `newDrafts`. Do not switch to `newDrafts`
  // — that would drop the opening balance and resurrect a phantom diff.
  const derived = new Map<string, Decimal>();
  for (const d of drafts) {
    const action = d.action as string;
    const amt = new Decimal(d.price ?? "0");
    const prev = derived.get(d.currency) ?? new Decimal(0);
    if (action === "deposit" || action === "interest" || action === "dividend") {
      derived.set(d.currency, prev.add(amt));
    } else if (action === "withdrawal") {
      derived.set(d.currency, prev.sub(amt));
    } else if (isAcquisitionType(action)) {
      const total = amt.mul(new Decimal(d.quantity ?? "0")).add(new Decimal(d.fees ?? "0"));
      derived.set(d.currency, prev.sub(total));
    } else if (action === "sell") {
      const total = amt.mul(new Decimal(d.quantity ?? "0")).sub(new Decimal(d.fees ?? "0"));
      derived.set(d.currency, prev.add(total));
    }
  }

  const cash = cashReport.map(({ currency, endingCash }) => {
    // Render reported and derived at the same (cent) precision so a sub-cent broker
    // figure (e.g. 9.9981) doesn't read as a mismatch against a rounded derived total.
    const reportedStr = new Decimal(endingCash).toFixed(2);
    const derivedStr = (derived.get(currency) ?? new Decimal(0)).toFixed(2);
    const diff = new Decimal(reportedStr).sub(new Decimal(derivedStr)).toFixed(2);
    return {
      currency,
      reported: reportedStr,
      derived: derivedStr,
      // Normalize "-0.00" to a clean "0.00" so the UI shows "match".
      diff: diff === "-0.00" ? "0.00" : diff,
    };
  });
  return { checkedAt: new Date().toISOString(), cash };
}

/**
 * Sync one IBKR connection: decrypt token, fetch Flex statement, parse into drafts,
 * diff against the resolved-events ledger and the open collector draft.
 *
 * Structured like pytr/sync.ts but without the Python runner or 2FA complexity.
 * All IBKR events use source='ibkr' in the ledger so they can't collide with pytr IDs.
 */
export async function syncIbkrConnection(
  db: DB,
  encryption: EncryptionService,
  flexClient: IbkrFlexClient,
  connection: IbkrConnectionRow,
  log?: FastifyBaseLogger,
): Promise<IbkrSyncResult> {
  if (!connection.portfolioId) {
    log?.warn({ connectionId: connection.id }, "ibkr sync skipped: no portfolio linked");
    return { status: "error" };
  }

  const token = encryption.decryptString(connection.tokenEnc);
  const { queryId, portfolioId } = connection;
  const connectionId = connection.id;

  let xml: string;
  try {
    log?.debug({ connectionId }, "ibkr flex fetch starting");
    xml = await flexClient.fetchFlexStatement(token, queryId);
  } catch (err) {
    const status = err instanceof IbkrFlexError && err.code === "expired" ? "expired" : "error";
    const lastError = err instanceof Error ? err.message : "sync failed";
    log?.warn({ connectionId, status, lastError }, "ibkr connection flipped");
    await db
      .update(ibkrConnections)
      .set({ status, lastError, syncing: false, updatedAt: new Date() })
      .where(eq(ibkrConnections.id, connectionId));
    return { status };
  }

  // Portfolio base currency — fallback when the statement lacks AccountInformation, and
  // the label for IBKR's BASE_SUMMARY cash row.
  const [portfolio] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  const baseCurrency = portfolio?.baseCurrency ?? "";

  // Parse statements — a Flex export can contain multiple accounts; take all.
  const statements = parseFlexXml(xml);
  const allDrafts: ParsedTransaction[] = [];
  const allErrors: ImportIssue[] = [];
  for (const stmt of statements) {
    const { drafts, errors } = mapFlexToDrafts(stmt, { baseCurrency });
    allDrafts.push(...drafts);
    allErrors.push(
      ...errors.map((e) => ({
        message: e.message,
        severity: "attention" as const,
        line: e.line ?? 0,
      })),
    );
  }

  // Update the connection's flexAccountId from the first statement.
  const newAccountId = statements[0]?.accountId ?? null;

  // 1. Load the resolved ledger for this portfolio + source='ibkr'.
  const resolvedRows = await db
    .select({ eventId: trResolvedEvents.eventId })
    .from(trResolvedEvents)
    .where(and(eq(trResolvedEvents.portfolioId, portfolioId), eq(trResolvedEvents.source, "ibkr")));
  const resolved = new Set(resolvedRows.map((r) => r.eventId));

  // Every ibkr transaction already materialized (ANY status) — its event must not be
  // re-created this sync. Only seed the durable "confirmed" ledger from genuinely-confirmed
  // rows (normal/cash_neutral), never from drafts/archived.
  const ibkrRows = await db
    .select({ ext: transactions.externalId, status: transactions.status })
    .from(transactions)
    .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.source, "ibkr")));
  const existingTxIds = new Set(ibkrRows.map((r) => r.ext).filter((x): x is string => Boolean(x)));
  const confirmedIds = ibkrRows
    .filter((r) => r.status === "normal" || r.status === "cash_neutral")
    .map((r) => r.ext)
    .filter((x): x is string => Boolean(x));
  if (confirmedIds.length) {
    await db
      .insert(trResolvedEvents)
      .values(
        confirmedIds.map((eventId) => ({
          portfolioId,
          source: "ibkr",
          eventId,
          resolution: "confirmed",
        })),
      )
      .onConflictDoNothing();
    for (const id of confirmedIds) resolved.add(id);
  }

  // 2. Find the open collector draft (parser='ibkr').
  const [collector] = await db
    .select()
    .from(screenshotImports)
    .where(
      and(
        eq(screenshotImports.userId, connection.userId),
        eq(screenshotImports.portfolioId, portfolioId),
        eq(screenshotImports.parser, "ibkr"),
        eq(screenshotImports.status, "draft"),
      ),
    )
    .orderBy(desc(screenshotImports.createdAt))
    .limit(1);
  const existing = collector ? (collector.parsedJson as CollectorJson) : null;
  const stagedIds = new Set<string>(
    (existing?.drafts ?? []).map((d) => d.externalId).filter((x): x is string => Boolean(x)),
  );

  // 3. New = not resolved, not already a transaction row, not staged in a legacy collector.
  const newDrafts = allDrafts.filter((d) => {
    const id = d.externalId;
    if (!id) return true; // always include drafts without stable IDs
    return !resolved.has(id) && !existingTxIds.has(id) && !stagedIds.has(id);
  });
  const newErrors = allErrors;

  log?.debug(
    { connectionId, total: allDrafts.length, new: newDrafts.length, errors: newErrors.length },
    "ibkr events mapped",
  );

  // 4. Carry forward any legacy staged drafts (pre-migration collectors) not yet resolved,
  //    then materialize the lot as status='draft' transactions.
  const keptDrafts = (existing?.drafts ?? []).filter(
    (d) => !d.externalId || !resolved.has(d.externalId),
  );
  const draftsToMaterialize = [...keptDrafts, ...newDrafts];
  const mergedErrors = newErrors;

  // 5. Maintain a single stable anchor import (provenance for transactions.importId + holder
  //    of residual attention errors). Reuse the open ibkr import if present; create when
  //    there is anything to anchor. Never discarded once created (keeps the importId FK valid).
  let importId: string | undefined = collector?.id;
  const anchorStatus = mergedErrors.length > 0 ? "draft" : "confirmed";
  const anchorJson: CollectorJson = { drafts: [], errors: mergedErrors };
  if (!importId && (draftsToMaterialize.length > 0 || mergedErrors.length > 0)) {
    const [imp] = await db
      .insert(screenshotImports)
      .values({
        userId: connection.userId,
        portfolioId,
        parser: "ibkr",
        parsedJson: anchorJson,
        status: anchorStatus,
      })
      .returning();
    importId = imp.id;
  }

  let materializedDrafts = 0;
  if (importId && draftsToMaterialize.length > 0) {
    const res = await materializeDrafts(
      { db, log },
      {
        drafts: draftsToMaterialize,
        targetPortfolioId: portfolioId,
        source: "ibkr",
        importId,
        status: "draft",
        isEu: true,
      },
    );
    materializedDrafts = res.written.length;
    if (res.collapsed.length > 0) {
      await db
        .insert(trResolvedEvents)
        .values(
          res.collapsed.map((eventId) => ({
            portfolioId,
            source: "ibkr",
            eventId,
            resolution: "confirmed",
          })),
        )
        .onConflictDoNothing();
    }
  }

  if (collector) {
    await db
      .update(screenshotImports)
      .set({ parsedJson: anchorJson, status: anchorStatus })
      .where(eq(screenshotImports.id, collector.id));
  }
  log?.info(
    { connectionId, importId, materialized: materializedDrafts, errors: mergedErrors.length },
    "ibkr drafts materialized",
  );

  // 6. Cash reconciliation from Flex CashReport. Resolve to real ISO currencies (mapping
  //    IBKR's BASE_SUMMARY aggregate to the base currency, but only when no real
  //    per-currency rows exist) so "BASE_SUMMARY" never leaks into the reconciliation UI.
  const stmtBaseCcy = statements[0]?.baseCurrency || baseCurrency;
  const cashReport = selectCashRows(statements[0]?.cashReport ?? [], stmtBaseCcy).map(
    ({ row, currency }) => ({ currency, endingCash: row.endingCash ?? "0" }),
  );
  const reconciliation = reconcileCash(allDrafts, cashReport);

  // 7. Update connection.
  await db
    .update(ibkrConnections)
    .set({
      status: "connected",
      lastSyncAt: new Date(),
      lastError: null,
      syncing: false,
      updatedAt: new Date(),
      ...(newAccountId ? { flexAccountId: newAccountId } : {}),
      ...(reconciliation ? { lastReconciliation: reconciliation } : {}),
    })
    .where(eq(ibkrConnections.id, connectionId));

  log?.info({ connectionId, reconciled: !!reconciliation }, "ibkr connection synced");

  return {
    status: "connected",
    importId,
    drafts: materializedDrafts,
    errors: newErrors.length,
    reconciliation,
  };
}
