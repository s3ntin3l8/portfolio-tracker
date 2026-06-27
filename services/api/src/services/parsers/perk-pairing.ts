import type { ParsedTransaction } from "@portfolio/schema";

/**
 * Collapse a Trade Republic **perk-funded acquisition** — a savings-plan / buy paired with a
 * same-day broker cash credit that funds it (STOCKPERK, KINDERGELD_BONUS, BONUS) — into a
 * single `bonus` (free-share) transaction.
 *
 * The raw TR export records the perk as two rows: the `BUY` (cash out, shares in) and a
 * `CASH` credit (cash in, no shares). Kept apart, the buy is mis-counted as contributed
 * capital and the buy-before-credit ordering trips the negative-cash guard. Collapsed, the
 * shares are received free: quantity from the buy, cost basis at the buy's price (FMV), cash
 * flow 0, never a contribution (`kind:"bonus"`, see contributions.ts isExternalAcquisition).
 *
 * Both mappers (CSV `parseTrCsv`, live `pytr` sync) run this over their full candidate batch
 * so the representation is identical regardless of source. The perk's source event is folded
 * into the merged row's `extraSources` (the buy's externalId stays primary) so the audit
 * trail and re-import / resolved-events-ledger dedup stay intact.
 *
 * Matching is greedy, one-to-one and deterministic: same calendar day, the buy's notional
 * (quantity × price) within one cent of the perk amount, and — when the perk carries an
 * instrument (STOCKPERK does; KINDERGELD does not) — the same instrument. An unmatched perk
 * keeps its original `bonus_cash` row (e.g. Kindergeld credited but not yet invested).
 */

/** A perk cash credit emitted by the mappers: a broker bonus with no share leg. */
function isPerkCredit(t: ParsedTransaction): boolean {
  return t.action === "bonus_cash" && t.kind === "bonus";
}

/** A share acquisition a perk could fund. */
function isFundableBuy(t: ParsedTransaction): boolean {
  return (t.action === "buy" || t.action === "savings_plan") && Number(t.quantity) > 0;
}

/**
 * Identity tokens used to confirm a perk funds a given buy. A STOCKPERK credit keeps only the
 * instrument *name* (its ISIN is stripped — it's booked as cash income), while the buy carries
 * ISIN + name, so we match on any shared token rather than a single canonical key. KINDERGELD
 * carries no instrument at all → empty, so it pairs on amount + day alone.
 */
function identityTokens(t: ParsedTransaction): string[] {
  return [t.isin, t.ticker, t.wkn, t.name].filter(
    (x): x is string => x != null && x !== "",
  );
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/** Gross notional the perk reimburses (fees are separate in the TR export). */
function notional(buy: ParsedTransaction): number {
  return Number(buy.quantity) * Number(buy.price);
}

/** One cent — absorbs the perk amount being rounded to cents vs. the full-precision notional. */
const MONEY_TOL = 0.0105;

export function collapsePerkFundedAcquisitions(
  drafts: ParsedTransaction[],
): ParsedTransaction[] {
  // Index fundable buys not yet consumed, in a stable order so matching is deterministic.
  const buyIdx = drafts
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => isFundableBuy(d))
    .sort((a, b) => a.d.executedAt.getTime() - b.d.executedAt.getTime() || a.i - b.i);
  const consumedBuy = new Set<number>();
  // draftIndex of a matched buy -> the perk that funded it (folded into extraSources).
  const merged = new Map<number, ParsedTransaction>();
  const droppedPerk = new Set<number>();

  const perks = drafts
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => isPerkCredit(d))
    .sort((a, b) => a.d.executedAt.getTime() - b.d.executedAt.getTime() || a.i - b.i);

  for (const { d: perk, i: perkI } of perks) {
    const perkAmount = Number(perk.price);
    const perkTokens = identityTokens(perk);
    const perkDay = dayKey(perk.executedAt);

    const hit = buyIdx.find(({ d: buy, i }) => {
      if (consumedBuy.has(i)) return false;
      if (dayKey(buy.executedAt) !== perkDay) return false;
      // When the perk carries an instrument identity, require it to overlap the buy's.
      if (perkTokens.length > 0) {
        const buyTokens = new Set(identityTokens(buy));
        if (!perkTokens.some((tok) => buyTokens.has(tok))) return false;
      }
      return Math.abs(notional(buy) - perkAmount) <= MONEY_TOL;
    });
    if (!hit) continue; // no funding buy → leave the perk as a plain bonus_cash row

    consumedBuy.add(hit.i);
    droppedPerk.add(perkI);
    const buy = hit.d;
    merged.set(hit.i, {
      ...buy,
      action: "bonus",
      kind: "bonus",
      // The buy's externalId stays primary (it carries the shares); the perk credit is
      // folded in as a consumed sibling so both TR events are recorded.
      extraSources: [
        ...(buy.extraSources ?? []),
        perk.externalId
          ? { externalId: perk.externalId, raw: { collapsedFrom: "perk_cash_credit" } }
          : { externalId: `perk:${perkI}`, raw: { collapsedFrom: "perk_cash_credit" } },
      ],
    });
  }

  if (merged.size === 0 && droppedPerk.size === 0) return drafts;
  return drafts
    .map((d, i) => merged.get(i) ?? d)
    .filter((_, i) => !droppedPerk.has(i));
}
