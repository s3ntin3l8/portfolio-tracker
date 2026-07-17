import { isTradeType } from "@portfolio/core";
import type { ParsedAction, ImportIssue, ParsedTransaction } from "@portfolio/schema";
import { formatDecimal } from "../parsers/numeric.js";
import { collapsePerkFundedAcquisitions } from "../parsers/perk-pairing.js";
import {
  trEventSchema,
  type TrEvent,
  TR_CRYPTO_ISIN,
  RECONCILE_TOLERANCE,
  EVENT_KIND,
  FIXED_ACTIONS,
  TRADE_EVENTS,
  CASH_BY_SIGN,
  CASH_CORPORATE_ACTION,
  SHARE_CORPORATE_ACTION,
  NO_CASH_CORPORATE_ACTION,
  SKIP_EVENTS,
  ATTENTION_SKIPS,
  SECURITY_ACTIONS,
} from "./mapper/taxonomy.js";

import type { MapResult } from "./mapper/classification.js";
export {
  categoryForEventType,
  isCashMovementEvent,
  isCashMovementAction,
} from "./mapper/classification.js";
export type { ImportCategory, MapResult } from "./mapper/classification.js";
export type { ReportDocumentRef } from "./mapper/reports.js";
export { extractReportDocuments } from "./mapper/reports.js";
export { REPORT_TITLE_PREFIXES, REPORT_TITLE_YEAR_RE } from "./mapper/taxonomy.js";
export {
  RECLASSIFICATION_ORIGINAL_SUFFIX,
  rawEventIdFromExternalId,
} from "./mapper/reclassification.js";
import { buildReclassificationSplit } from "./mapper/reclassification.js";

function skip(
  reason: string,
  severity: "info" | "attention",
  ev?: TrEvent,
  code?: ImportIssue["code"],
): MapResult {
  if (!ev) return { skip: true, reason, severity, code };
  return {
    skip: true,
    reason,
    severity,
    code,
    eventId: ev.id,
    eventType: ev.eventType,
    raw: {
      isin: ev.isin ?? null,
      name: ev.title ?? null,
      currency: ev.currency?.toUpperCase() ?? null,
      executedAt: ev.timestamp,
      amount: ev.amount,
      shares: ev.shares ?? null,
    },
  };
}

export function mapTrEventToDraft(raw: unknown): MapResult {
  const parsed = trEventSchema.safeParse(raw);
  if (!parsed.success) {
    return skip(
      `unparseable event: ${parsed.error.issues[0]?.message}`,
      "attention",
      undefined,
      "unparseable_event",
    );
  }
  const ev = parsed.data;

  if (ev.status && ev.status.toUpperCase() !== "EXECUTED") {
    return skip(`non-executed event (${ev.status})`, "info", ev);
  }

  const skipReason = SKIP_EVENTS.get(ev.eventType);
  if (skipReason) {
    return skip(skipReason, ATTENTION_SKIPS.has(ev.eventType) ? "attention" : "info", ev);
  }

  let action: ParsedAction | undefined = FIXED_ACTIONS[ev.eventType];
  if (!action && TRADE_EVENTS.has(ev.eventType)) {
    action = ev.amount < 0 ? "buy" : "sell";
  }
  if (!action && CASH_BY_SIGN.has(ev.eventType)) {
    action = ev.amount < 0 ? "withdrawal" : "deposit";
  }
  if (!action && ev.eventType === CASH_CORPORATE_ACTION) {
    action = ev.isin ? "dividend" : "deposit";
  }
  if (!action && ev.eventType === SHARE_CORPORATE_ACTION) {
    action = ev.amount !== 0 ? "buy" : "bonus";
  }
  if (!action && ev.eventType === NO_CASH_CORPORATE_ACTION && ev.kind === "vorabpauschale") {
    action = "tax";
  }
  if (!action) {
    return skip(`unmapped event type: ${ev.eventType}`, "attention", ev, "unmapped_event_type");
  }

  const amount = Math.abs(ev.amount);
  const fees = Math.abs(ev.fees ?? 0);
  const isSecurity = SECURITY_ACTIONS.has(action);

  if (isSecurity && !ev.isin) {
    return skip(`${ev.eventType} without an ISIN`, "attention", ev);
  }

  let quantity = "0";
  let price = formatDecimal(amount);
  let confidence = 1;
  let sellTaxOverride: number | null = null;

  if (isTradeType(action)) {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(`${ev.eventType} without a share count`, "attention", ev);
    }
    quantity = formatDecimal(shares);
    if (action === "sell") {
      if (ev.executedPrice != null) {
        price = formatDecimal(Math.abs(ev.executedPrice));
        const notional = shares * Math.abs(ev.executedPrice);
        sellTaxOverride = Math.round((notional - fees - amount) * 100) / 100;
      } else {
        const sellTax = Math.abs(ev.tax ?? 0);
        price = formatDecimal((amount + fees + sellTax) / shares);
      }
    } else {
      price = formatDecimal((amount - fees) / shares);
    }

    if (ev.executedPrice != null && amount > 0) {
      const notional = shares * Math.abs(ev.executedPrice);
      if (Math.abs(notional - amount) > Math.max(amount * RECONCILE_TOLERANCE, 0.5)) {
        confidence = 0.5;
      }
    }
  }

  if (action === "transfer_in" || action === "transfer_out") {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(`${ev.eventType} without a share count`, "attention", ev);
    }
    quantity = formatDecimal(shares);
    price = "0";
  }

  if (action === "bonus") {
    const shares = Math.abs(ev.shares ?? 0);
    if (shares === 0) {
      return skip(
        `${ev.eventType} without a share count — check the event details`,
        "attention",
        ev,
      );
    }
    quantity = formatDecimal(shares);
    price = "0";
  }

  if (action === "tax") {
    price = formatDecimal(amount !== 0 ? amount : Math.abs(ev.tax ?? 0));
    quantity = "0";
    if (ev.kind === "vorabpauschale" && ev.vorabBase == null) {
      confidence = 0.5;
    }
  }

  const assetClass = ev.isin && TR_CRYPTO_ISIN.test(ev.isin) ? "crypto" : "equity";

  const draft: ParsedTransaction = {
    assetClass,
    action,
    ticker: null,
    isin: ev.isin ?? null,
    wkn: ev.wkn ?? null,
    name: ev.title ?? ev.isin ?? ev.eventType,
    quantity,
    unit: "shares",
    price,
    fees: formatDecimal(fees),
    total: formatDecimal(amount),
    currency: ev.currency.toUpperCase(),
    executedAt: new Date(ev.timestamp),
    confidence,
    externalId: ev.id,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
    kind:
      ev.kind ??
      (ev.eventType === SHARE_CORPORATE_ACTION && action === "buy"
        ? "reinvestment"
        : (EVENT_KIND[ev.eventType] ?? null)),
    tax:
      action === "tax"
        ? null
        : sellTaxOverride != null
          ? formatDecimal(sellTaxOverride)
          : ev.tax != null
            ? formatDecimal(Math.abs(ev.tax))
            : null,
    executedPrice: ev.executedPrice != null ? formatDecimal(ev.executedPrice) : null,
    fxRate: ev.fxRate != null ? formatDecimal(ev.fxRate) : null,
    venue: ev.venue ?? null,
    description: ev.description ?? null,
    documentRefs: ev.documentRefs ?? null,
    vorabBase: ev.vorabBase != null ? formatDecimal(ev.vorabBase) : null,
  };
  return { draft };
}

export function mapTrEvents(rawEvents: unknown[]): {
  drafts: ParsedTransaction[];
  errors: ImportIssue[];
} {
  const drafts: ParsedTransaction[] = [];
  const errors: ImportIssue[] = [];
  rawEvents.forEach((raw, i) => {
    const result = mapTrEventToDraft(raw);
    if ("draft" in result) {
      const parsed = trEventSchema.safeParse(raw);
      const ev = parsed.success ? parsed.data : null;
      const split = ev ? buildReclassificationSplit(ev) : null;
      if (split) {
        drafts.push(...split);
      } else if (ev && ev.originalAmount != null && ev.correctionAmount != null) {
        drafts.push({ ...result.draft, kind: "reclassification-unresolved" });
      } else {
        drafts.push(result.draft);
      }
    } else
      errors.push({
        line: i,
        message: result.reason,
        severity: result.severity,
        code: result.code,
        eventId: result.eventId,
        eventType: result.eventType,
        raw: result.raw,
      });
  });
  return { drafts: collapsePerkFundedAcquisitions(drafts), errors };
}
