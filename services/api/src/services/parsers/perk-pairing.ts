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
 * Matching is greedy, one-to-one and deterministic: within a few days (TR credits the perk
 * then executes the savings plan 0–3 days later), the buy's notional (quantity × price)
 * matching the perk amount, and — when the perk carries an instrument (STOCKPERK does;
 * KINDERGELD does not) — the same instrument; the closest-dated eligible buy wins. An
 * unmatched perk keeps its original `bonus_cash` row (e.g. Kindergeld credited but not yet
 * invested).
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

const DAY_MS = 86_400_000;
function dayIndex(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

/**
 * Calendar-day gap a perk and the buy it funds may span. TR credits the perk (e.g.
 * KINDERGELD_BONUS at the start of the month) and the savings plan executes 0–3 days later;
 * 7 days covers that with margin while staying far under the ~28-day savings-plan cycle, so a
 * perk can never reach into an adjacent month's buys.
 */
const WINDOW_DAYS = 7;

/** Gross notional the perk reimburses (fees are separate in the TR export). */
function notional(buy: ParsedTransaction): number {
  return Number(buy.quantity) * Number(buy.price);
}

/**
 * Whether a buy's notional matches the perk's cash amount. Half-a-cent absolute absorbs the
 * cent-rounded perk amount (0.02) vs. the full-precision notional (0.0199) AND stays below the
 * 0.01 gap between the two funded buys — so a 0.01 perk never grabs a 0.02 buy. The 0.2%
 * relative arm keeps a large perk (e.g. a 101.19 STOCKPERK) matching. Mirrors dedup.ts.
 */
const MONEY_ABS_TOL = 0.005;
const MONEY_REL_TOL = 0.002;
function amountsMatch(buyNotional: number, perkAmount: number): boolean {
  const diff = Math.abs(buyNotional - perkAmount);
  return diff <= MONEY_ABS_TOL || diff <= MONEY_REL_TOL * Math.max(buyNotional, perkAmount);
}

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
    const perkDay = dayIndex(perk.executedAt);

    // Eligible buys within the day window whose amount (and instrument, when the perk carries
    // one) matches. Pick the closest-dated, then lowest index — deterministic and keeps a perk
    // from reaching for a farther buy when amounts alone don't disambiguate (e.g. two equal
    // perks + two equal buys in one month).
    const hit = buyIdx
      .filter(({ d: buy, i }) => {
        if (consumedBuy.has(i)) return false;
        if (Math.abs(dayIndex(buy.executedAt) - perkDay) > WINDOW_DAYS) return false;
        if (perkTokens.length > 0) {
          const buyTokens = new Set(identityTokens(buy));
          if (!perkTokens.some((tok) => buyTokens.has(tok))) return false;
        }
        return amountsMatch(notional(buy), perkAmount);
      })
      .sort(
        (a, b) =>
          Math.abs(dayIndex(a.d.executedAt) - perkDay) -
            Math.abs(dayIndex(b.d.executedAt) - perkDay) || a.i - b.i,
      )[0];
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
