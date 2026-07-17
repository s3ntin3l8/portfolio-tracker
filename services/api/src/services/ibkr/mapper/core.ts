import type { z } from "zod";
import { Decimal } from "decimal.js";
import {
  parsedTransactionSchema,
  type ParsedAction,
  type ParsedTransaction,
} from "@portfolio/schema";
import { shortHash } from "../../parsers/hash.js";
import { CASH_TX_TYPES, parseIbkrDate, selectCashRows } from "../flex-parse.js";
import { assetClass, CA_SPLIT_TYPES, absStr, strNum } from "./helpers.js";
import type { FlexStatement, MapFlexResult } from "./types.js";

export function mapFlexToDrafts(
  statement: FlexStatement,
  opts: { baseCurrency?: string } = {},
): MapFlexResult {
  const drafts: ParsedTransaction[] = [];
  const errors: MapFlexResult["errors"] = [];

  function push(raw: z.input<typeof parsedTransactionSchema>, context: unknown) {
    const parsed = parsedTransactionSchema.safeParse(raw);
    if (parsed.success) {
      drafts.push(parsed.data);
    } else {
      errors.push({
        message: parsed.error.issues[0]?.message ?? "validation failed",
        raw: context,
      });
    }
  }

  // ── 1. Trades ────────────────────────────────────────────────────────────
  for (const trade of statement.trades) {
    // Skip ORDER-level summaries when EXECUTION rows are also present.
    if (trade.levelOfDetail && trade.levelOfDetail.toUpperCase() === "ORDER") {
      continue;
    }

    // Cancelled/partial-cancel rows: BUY (Ca.) / SELL (Ca.) are reversals —
    // treat them like their non-Ca. counterparts so the sign logic still works.
    const buySellRaw = (trade.buySell ?? "").toUpperCase();
    if (!buySellRaw.startsWith("BUY") && !buySellRaw.startsWith("SELL")) {
      errors.push({ message: `Unrecognised buySell value: ${trade.buySell}`, raw: trade });
      continue;
    }
    const action: ParsedAction = buySellRaw.startsWith("BUY") ? "buy" : "sell";

    const executedAt = parseIbkrDate(trade.tradeDate);
    if (!executedAt) {
      errors.push({ message: `Unparseable tradeDate: ${trade.tradeDate}`, raw: trade });
      continue;
    }

    // quantity in the Flex is signed (positive=buy, negative=sell); we always store abs.
    const qty = absStr(trade.quantity);
    const price = strNum(trade.tradePrice);
    const currency = trade.currency ?? "USD";

    // Commission is negative in Flex; taxes is the trade-level tax (stamp duty etc.).
    const fees = String(
      Math.abs(Number(strNum(trade.ibCommission))) + Math.abs(Number(strNum(trade.taxes))),
    );

    const externalId = trade.tradeID
      ? `ibkr:trade:${trade.tradeID}`
      : `ibkr:trade:${shortHash([trade.symbol, action, executedAt, qty, price, currency].join("|"))}`;

    push(
      {
        assetClass: assetClass(trade.assetCategory),
        action,
        ticker: trade.symbol || undefined,
        isin: trade.isin || undefined,
        name: trade.description || trade.symbol || undefined,
        quantity: qty,
        unit: trade.assetCategory?.toUpperCase() === "CRYPTO" ? "units" : "shares",
        price,
        fees,
        currency,
        fxRate: trade.fxRateToBase ? strNum(trade.fxRateToBase) : undefined,
        executedAt,
        externalId,
        confidence: 1,
      },
      trade,
    );
  }

  // ── 2. Cash transactions ─────────────────────────────────────────────────
  //
  // Withholding-tax rows need to be merged into the matching dividend's `tax`
  // field rather than emitted as separate transactions.  Build an index of
  // dividend rows first (by symbol + date), then fold in the withholding taxes.

  // Index: symbol|date → index in dividendRows
  const dividendRows: {
    tx: (typeof statement.cashTransactions)[number];
    taxAmt: number; // accumulated withholding tax (positive = cost to holder)
    idx: number; // index in the output drafts array (filled after push)
  }[] = [];
  const dividendIndex = new Map<string, number>(); // symbol|date → dividendRows index

  // First pass: separate dividends/withholding-tax from other cash transactions.
  const otherCash: (typeof statement.cashTransactions)[number][] = [];
  for (const tx of statement.cashTransactions) {
    if (tx.levelOfDetail && tx.levelOfDetail.toUpperCase() !== "DETAIL") {
      // Skip SUMMARY-level cash rows (they are totals, not individual events).
      continue;
    }
    const type = tx.type ?? "";
    if (type === CASH_TX_TYPES.DIVIDENDS || type === CASH_TX_TYPES.PAYMENT_IN_LIEU) {
      const date = parseIbkrDate(tx.dateTime);
      if (date) {
        const key = `${tx.symbol ?? ""}|${date}`;
        dividendIndex.set(key, dividendRows.length);
        dividendRows.push({ tx, taxAmt: 0, idx: -1 });
      } else {
        otherCash.push(tx);
      }
    } else if (type === CASH_TX_TYPES.WITHHOLDING_TAX) {
      const date = parseIbkrDate(tx.dateTime);
      const key = `${tx.symbol ?? ""}|${date ?? ""}`;
      const dividendIdx = dividendIndex.get(key);
      if (dividendIdx !== undefined) {
        // Accumulate the absolute withholding tax amount for this dividend.
        dividendRows[dividendIdx]!.taxAmt += Math.abs(Number(strNum(tx.amount)));
      } else {
        // No matching dividend found — emit as a standalone fee.
        otherCash.push(tx);
      }
    } else {
      otherCash.push(tx);
    }
  }

  // Emit dividends with their merged withholding tax.
  for (const row of dividendRows) {
    const { tx, taxAmt } = row;
    const date = parseIbkrDate(tx.dateTime);
    if (!date) continue;

    const externalId = tx.transactionID
      ? `ibkr:cash:${tx.transactionID}`
      : `ibkr:cash:${shortHash([tx.symbol ?? "", date, tx.amount ?? ""].join("|"))}`;

    // The Flex "Dividends" cash-transaction amount is GROSS (before withholding);
    // a separate "Withholding Tax" row carries the tax, which we've already merged
    // into `taxAmt` above. `price` must hold the NET cash actually credited so that
    // downstream FSA/income logic (which computes gross = price + tax, matching the
    // TR/DKB convention — see packages/core/src/tax.ts) doesn't double-count the
    // withholding. When taxAmt is 0 (no matching withholding row — e.g. tax handled
    // via the annual return instead), net === gross, so this is a no-op in that case.
    const grossAmount = absStr(tx.amount);
    const netPrice =
      taxAmt > 0 ? Decimal.max(0, new Decimal(grossAmount).minus(taxAmt)).toFixed(2) : grossAmount;

    push(
      {
        assetClass: assetClass(tx.assetCategory),
        action: "dividend" as ParsedAction,
        ticker: tx.symbol || undefined,
        isin: tx.isin || undefined,
        name: tx.description || tx.symbol || undefined,
        quantity: "0",
        unit: "shares",
        price: netPrice,
        fees: "0",
        tax: taxAmt > 0 ? String(taxAmt) : undefined,
        currency: tx.currency ?? "USD",
        executedAt: date,
        externalId,
        confidence: 1,
      },
      tx,
    );
  }

  // Emit other cash transactions.
  for (const tx of otherCash) {
    const type = tx.type ?? "";
    const date = parseIbkrDate(tx.dateTime);
    if (!date) {
      errors.push({ message: `Unparseable dateTime: ${tx.dateTime}`, raw: tx });
      continue;
    }

    const amount = Number(strNum(tx.amount));
    let action: ParsedAction;

    if (
      type === CASH_TX_TYPES.BROKER_INTEREST ||
      type === CASH_TX_TYPES.CREDIT_INTEREST ||
      type === CASH_TX_TYPES.BOND_INTEREST_RECEIVED ||
      type === CASH_TX_TYPES.ACCRUALS_RECEIVED
    ) {
      action = "interest";
    } else if (type === CASH_TX_TYPES.DEPOSITS_WITHDRAWALS) {
      action = amount >= 0 ? "deposit" : "withdrawal";
    } else if (type === CASH_TX_TYPES.TAX_REVERSAL && amount >= 0) {
      // Tax reversals are positive income — treat as interest.
      action = "interest";
    } else {
      // Other fees, debit interest, adjustments, negative tax reversals — skip silently.
      // These are internal broker bookings, not portfolio-level events.
      continue;
    }

    const externalId = tx.transactionID
      ? `ibkr:cash:${tx.transactionID}`
      : `ibkr:cash:${shortHash([type, date, tx.amount ?? "", tx.currency ?? ""].join("|"))}`;

    push(
      {
        assetClass: null, // cash movements have no instrument
        action,
        ticker: undefined,
        isin: undefined,
        name: tx.description || type || undefined,
        quantity: "0",
        unit: "shares",
        price: absStr(tx.amount),
        fees: "0",
        currency: tx.currency ?? "USD",
        executedAt: date,
        externalId,
        confidence: 1,
      },
      tx,
    );
  }

  // ── 3. Transfers (position transfers / Depotübertrag) ────────────────────
  for (const xfer of statement.transfers) {
    // Skip cash transfers (internal moves, settlement flows).
    const cat = (xfer.assetCategory ?? "").toUpperCase();
    if (cat === "CASH" || cat === "") continue;

    const date = parseIbkrDate(xfer.date);
    if (!date) {
      errors.push({ message: `Unparseable transfer date: ${xfer.date}`, raw: xfer });
      continue;
    }

    // Direction: prefer explicit `type` field (IBKR uses "IN"/"OUT" or "ACATS IN" etc.);
    // fall back to `direction`.
    const typeRaw = (xfer.type ?? "").toUpperCase();
    const dirRaw = (xfer.direction ?? "").toUpperCase();
    const isIn =
      typeRaw === "IN" || typeRaw.includes(" IN") || typeRaw === "ACATS IN" || dirRaw === "IN";
    const isOut =
      typeRaw === "OUT" || typeRaw.includes(" OUT") || typeRaw === "ACATS OUT" || dirRaw === "OUT";

    if (!isIn && !isOut) {
      errors.push({ message: `Unrecognised transfer direction: ${xfer.type}`, raw: xfer });
      continue;
    }

    const action: ParsedAction = isIn ? "transfer_in" : "transfer_out";
    const qty = absStr(xfer.quantity);

    // Carried cost per share: prefer explicit costBasisPrice, then derive from
    // costBasisMoney / quantity; fall back to 0 (unknown cost basis).
    let price = "0";
    if (xfer.costBasisPrice && Number(strNum(xfer.costBasisPrice)) > 0) {
      price = strNum(xfer.costBasisPrice);
    } else if (xfer.costBasisMoney && Number(qty) > 0) {
      price = String(Math.abs(Number(strNum(xfer.costBasisMoney))) / Number(qty));
    } else if (xfer.positionAmount && Number(qty) > 0) {
      price = String(Math.abs(Number(strNum(xfer.positionAmount))) / Number(qty));
    }

    const externalId = xfer.transactionID
      ? `ibkr:xfer:${xfer.transactionID}`
      : `ibkr:xfer:${shortHash([xfer.symbol ?? "", action, date, qty].join("|"))}`;

    push(
      {
        assetClass: assetClass(xfer.assetCategory),
        action,
        ticker: xfer.symbol || undefined,
        isin: xfer.isin || undefined,
        name: xfer.description || xfer.symbol || undefined,
        quantity: qty,
        unit: cat === "CRYPTO" ? "units" : "shares",
        price,
        fees: "0",
        currency: xfer.currency ?? "USD",
        executedAt: date,
        externalId,
        confidence: 0.85, // carried-cost derivation is best-effort
      },
      xfer,
    );
  }

  // ── 4. Corporate actions (splits only) ──────────────────────────────────
  for (const ca of statement.corporateActions) {
    const caType = (ca.type ?? "").toUpperCase();
    if (!CA_SPLIT_TYPES.has(caType)) {
      // Mergers, spinoffs, rights, etc. are too varied — skip for now.
      continue;
    }

    const date = parseIbkrDate(ca.dateTime ?? ca.reportDate ?? "");
    if (!date) continue;
    if (!ca.symbol && !ca.isin) continue;

    // Splits are captured as corporate actions in the app, not as buy/sell
    // transactions — but ParsedTransaction doesn't have a "split" action.
    // Emit as low-confidence drafts tagged with a description so the user
    // can review them; the confirm flow will create the right corp-action row.
    const externalId = ca.transactionID
      ? `ibkr:ca:${ca.transactionID}`
      : `ibkr:ca:${shortHash([ca.symbol ?? "", caType, date].join("|"))}`;

    push(
      {
        assetClass: assetClass(ca.assetCategory),
        action: "bonus" as ParsedAction, // closest available; the review screen shows description
        ticker: ca.symbol || undefined,
        isin: ca.isin || undefined,
        name: ca.actionDescription || ca.description || `Split (${ca.type})`,
        quantity: absStr(ca.quantity),
        unit: "shares",
        price: "0",
        fees: "0",
        currency: ca.currency ?? "USD",
        executedAt: date,
        externalId,
        confidence: 0.5, // low-confidence: user should review split events
      },
      ca,
    );
  }

  // ── 5. Opening cash balance ──────────────────────────────────────────────
  //
  // IBKR's CashReport carries the account's standing cash via startingCash/endingCash,
  // but the *funding* deposit may be years old and permanently outside a rolling Flex
  // window — so it never appears as a CashTransaction row. Without it, cash-inside
  // portfolios show €0 and the cash reconciliation reports the whole balance as a diff.
  //
  // Book the window's startingCash as a single anchored `deposit` per currency. The
  // externalId is intentionally DATE-LESS (`ibkr:opening:<account>:<ccy>`) so a rolling
  // window can't change it: the dedup ledger anchors the first-seen opening balance and
  // every later sync re-emits then dedupes it (which also keeps the per-window cash
  // reconciliation self-consistent: startingCash + in-window flows = endingCash).
  const baseCcy = statement.baseCurrency || opts.baseCurrency;
  const openingRows = selectCashRows(statement.cashReport, baseCcy);
  const openingFromDate = parseIbkrDate(statement.fromDate);
  for (const { row, currency } of openingRows) {
    // strNum maps an absent/empty startingCash to "0", so this also skips the
    // no-Starting-Cash-column case (surfaced as a diagnostic issue below instead).
    const startNum = Number(strNum(row.startingCash));
    if (startNum === 0) continue; // nothing to book for a flat opening balance
    if (!openingFromDate) continue; // can't date the opening balance

    // A negative standing balance is a margin/debit balance — sign-split into a
    // withdrawal (mirroring the in-window Deposits/Withdrawals handler) so it never
    // lands as a negative-amount "deposit" (which would corrupt the contribution total).
    push(
      {
        assetClass: null,
        action: (startNum >= 0 ? "deposit" : "withdrawal") as ParsedAction,
        ticker: undefined,
        isin: undefined,
        name: "IBKR opening balance",
        quantity: "0",
        unit: "shares",
        price: absStr(row.startingCash),
        fees: "0",
        currency,
        executedAt: openingFromDate,
        externalId: `ibkr:opening:${statement.accountId}:${currency}`,
        confidence: 1,
      },
      row,
    );
  }

  // Diagnostic for the "standing cash only" account (nothing else mapped) where we still
  // could not book an opening balance — so the cash would silently vanish. Scoped to the
  // empty-account signature (drafts.length === 0) so it never fires for normal statements
  // (e.g. the activity fixture, whose CashReport rows also lack startingCash). Two causes:
  //   A. resolvable currency but the Flex query omits the Starting Cash column;
  //   B. a startingCash value exists but the currency can't be resolved (BASE_SUMMARY + unknown base).
  if (drafts.length === 0) {
    const resolvableNoStart = openingRows.find(
      ({ row }) => !row.startingCash && Number(strNum(row.endingCash)) !== 0,
    );
    const unresolvableWithStart = statement.cashReport.find(
      (r) => r.startingCash && Number(strNum(r.startingCash)) !== 0,
    );
    if (resolvableNoStart) {
      errors.push({
        message:
          "IBKR reports a standing cash balance but the Flex query has no Starting Cash " +
          "column; enable 'Starting Cash' in the query's Cash Report section so the " +
          "opening balance can be booked",
        raw: resolvableNoStart.row,
      });
    } else if (unresolvableWithStart) {
      errors.push({
        message:
          "IBKR cash report only exposes a BASE_SUMMARY row and the account base " +
          "currency is unknown; opening balance not booked",
        raw: unresolvableWithStart,
      });
    }
  }

  return { drafts, errors };
}
