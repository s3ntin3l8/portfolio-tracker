import type { ImportIssue, ParsedTransaction } from "@portfolio/schema";
import {
  FIXED_ACTIONS,
  TRADE_EVENTS,
  CARD_EVENTS,
  CASH_BY_SIGN,
  CASH_CORPORATE_ACTION,
  SHARE_CORPORATE_ACTION,
  NO_CASH_CORPORATE_ACTION,
} from "./taxonomy.js";

export type ImportCategory = "trade" | "income" | "cashflow" | "card";

export type MapResult =
  | { draft: ParsedTransaction }
  | {
      skip: true;
      reason: string;
      severity: "info" | "attention";
      code?: ImportIssue["code"];
      eventId?: string;
      eventType?: string;
      raw?: ImportIssue["raw"];
    };

export function categoryForEventType(eventType: string): ImportCategory {
  if (CARD_EVENTS.has(eventType)) return "card";
  if (TRADE_EVENTS.has(eventType)) return "trade";
  if (eventType === CASH_CORPORATE_ACTION) return "income";
  if (eventType === SHARE_CORPORATE_ACTION) return "income";
  if (eventType === NO_CASH_CORPORATE_ACTION) return "income";
  const action = FIXED_ACTIONS[eventType];
  if (
    action === "buy" ||
    action === "sell" ||
    action === "savings_plan" ||
    action === "transfer_in" ||
    action === "transfer_out"
  )
    return "trade";
  if (action === "dividend" || action === "coupon" || action === "interest") return "income";
  return "cashflow";
}

export function isCashMovementEvent(eventType: string): boolean {
  if (CARD_EVENTS.has(eventType)) return true;
  if (CASH_BY_SIGN.has(eventType)) return true;
  return isCashMovementAction(FIXED_ACTIONS[eventType] ?? "");
}

export function isCashMovementAction(action: string): boolean {
  return action === "deposit" || action === "withdrawal";
}
