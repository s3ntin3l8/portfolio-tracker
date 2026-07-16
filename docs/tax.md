# Tax Reporting

How the tracker estimates tax for two structurally different regimes — German
realization-based capital-gains tax and Indonesian final (withholding-style) tax — and
the user-level switch between them. **Both are estimates, not tax advice** (see the
"out of scope" notes below); the tracker doesn't file anything, it surfaces the numbers
you'd need to.

## The `taxRegime` switch

`userPreferences.taxRegime` (`packages/db/src/schema.ts`) is a per-user, global setting —
`"DE"` (default) or `"ID"` — read/written via `GET`/`PUT /me/preferences`
(`services/api/src/routes/preferences.ts`). It decides which of the two modules below
computes tax-facing numbers for every portfolio the user owns; there is no per-portfolio
override.

- **`"DE"`** — German Sparerpauschbetrag/Kapitalertragsteuer logic
  (`packages/core/src/tax.ts`), realization-based: tax depends on _closed_ gains,
  netted against a per-holder annual allowance.
- **`"ID"`** — Indonesian final-tax logic (`packages/core/src/tax-id.ts`): a flat rate
  applied to _gross proceeds/income_, withheld at source, with no allowance or
  loss-netting concept at all.

**Ordering gotcha:** `GET /portfolios/:id/sparplan` (`services/api/src/routes/
transactions/sparplan.ts`) reads `taxRegime` _before_ checking whether the portfolio's
FSA (`taxAllowanceAnnual`) is configured. An Indonesian user will almost never have an
FSA set, so if the FSA guard ran first (as it originally did) the `"ID"` branch would
never be reached — it would always short-circuit to `taxUnavailable: true`. If you touch
this route, keep the regime check first.

This is unrelated to `costBasisMode` (see [below](#costbasismode-not-a-tax-setting)),
which is a separate global preference that affects P&L/cost-basis math, not tax.

## German regime (`packages/core/src/tax.ts`)

Computes YTD usage of the **Sparerpauschbetrag** (§20 EStG annual tax-free allowance)
from a FIFO `TradeLog`, plus tax-loss-harvesting suggestions. Explicitly **out of
scope**: church-tax surtax calculation, Günstigerprüfung (the option to have gains taxed
at one's personal income-tax rate instead of the flat Kapitalertragsteuer, when that's
cheaper).

### Two-level Freistellungsauftrag (FSA) — don't conflate these

There are two different `taxAllowanceAnnual` columns, on two different tables:

| Column                              | Meaning                                                                                                                                      | Scope         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `accountHolders.taxAllowanceAnnual` | The **legal cap**: how much Sparerpauschbetrag this real person actually has (default €1,000 single / €2,000 jointly assessed with a spouse) | Per holder    |
| `portfolios.taxAllowanceAnnual`     | The **allocation**: how much of that cap this specific depot's FSA is set to                                                                 | Per portfolio |

A holder with two depots might set portfolio A's FSA to €600 and portfolio B's to €400,
summing to their €1,000 cap. `GET /portfolios/:id/tax` computes this distribution
(`totalAllocatedForHolder` vs. `holderAllowanceCap` in `services/api/src/routes/
transactions/tax.ts`) and returns it as `holderDistribution` — the edit modal uses it to
show "€X of €cap allocated" and to raise an `overAllocated` warning. **This is a warning
only, not a DB constraint** — nothing stops you from over-allocating across portfolios;
the tax computation for each portfolio still uses that portfolio's own
`taxAllowanceAnnual` regardless.

A portfolio with no FSA configured (`taxAllowanceAnnual` is `null`) can't compute German
tax at all — the route returns `422 tax_allowance_not_configured`, and the `/sparplan`
route returns `taxUnavailable: true` instead of erroring.

### Teilfreistellung (partial exemption)

Fund gains/losses and Vorabpauschale are multiplied by `(1 − tfRate)` before counting
against the allowance. The rate comes from `instruments.partialExemptionRate` when set,
else a hardcoded default by asset class (`services/api/src/routes/transactions/tax.ts`):
ETF → **30%**, mutual fund → **15%**, everything else → **0%** (no exemption). Worked
example (from `packages/core/test/tax.test.ts`): a closed equity-ETF trade with a
€1,000 realized gain and a 30% Teilfreistellung rate tf-adjusts to **€700** — against a
€1,000 allowance, that leaves €300 remaining.

### Two-pot loss netting (Verlustverrechnungstöpfe)

Gains/losses are split into two pots that **never spill into each other**:

- **Aktienverlusttopf (stock pot)** — realized share-sale (assetClass `"equity"`)
  gains/losses only.
- **Allgemeiner Verlusttopf (general pot)** — fund/bond/derivative gains/losses, all
  dividend/interest/coupon income, and the Vorabpauschale net (accrual − credit).

Each pot nets internally and floors at 0 independently _before_ summing into `usedYtd` —
a big stock loss can never offset a fund gain. **Gold and crypto are excluded from both
pots entirely**: they fall under §23 EStG private-sale rules, a separate regime from the
§20 Kapitalerträge this allowance covers.

A per-pot, per-holder **loss carry-forward** from the prior year's tax certificate
(`lossCarryforward` table, keyed by `holderId` + `taxYear` + `pot`) is subtracted from
that pot's net gain/loss before its floor — it's a settled raw euro figure, already
Teilfreistellung-adjusted when originally booked, never re-adjusted here. It's only
applied when a holder has exactly one portfolio (`carryForwardApplied` in the route);
splitting one holder's trades across multiple portfolios and expecting the same
carry-forward to apply to each independently isn't supported.

### Vorabpauschale (§18(3) InvStG advance lump-sum fund tax)

Split across two files by responsibility: `trade-log.ts` owns the _share-accounting_
side (per-instrument accrual pool on `Trade.vorabByYear`, and a disposal credit on
`TradeLeg.vorabCredit` to avoid double-taxing the same amount when the fund is later
sold); `tax.ts` owns the _tax-netting_ side — it Teilfreistellung-adjusts both the
accrual and the credit, in the same per-trade loop that handles realized gains, and
folds the net (accrual − credit) into the general pot.

### Harvest suggestions

`harvestSuggestions()` ranks open positions by tf-adjusted unrealized gain and shows how
much of each could be realized against the _remaining_ allowance — each suggestion is
computed **independently** against the same `remaining` figure (a per-row "if I harvest
only this one" ceiling), not sequentially. `harvestSummary()` is the sequential version:
it walks a list of suggestions best-first and allocates the _shared_ remaining allowance
across them, so the combined total never exceeds `remaining × taxRate` (naively summing
independent per-row suggestions would overcount, since each row assumes the full
allowance is still available).

Both use `projectedRemaining` when a rest-of-year income forecast is available
(`restOfYearForecastGross()` in `tax.ts`'s route file — projects dividends via each
instrument's trailing-12-month withholding ratio, announced `dividend_events`, and bond
coupons), falling back to the realized `remaining` otherwise.

### Where it surfaces

- `GET /portfolios/:portfolioId/tax` — single-portfolio allowance usage + harvest
  suggestions + FSA distribution.
- `GET /networth/tax` — aggregated across all of a holder's portfolios (or filtered by
  `holderId`), merging trade logs with `mergeTradeLogs()` before computing usage.
- `/tax` page in the web app renders both, including the FSA over-allocation warning.

## Indonesian final-tax regime (`packages/core/src/tax-id.ts`)

A flat, **withheld-at-source** tax with no annual allowance, no loss-netting, and no
realization dependency on when a gain was locked in — it taxes _proceeds and gross
income_, not gains:

| Event                    | Rate     | Base                                                                     |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| Every disposal (sell)    | **0.1%** | Gross sale proceeds (not gain)                                           |
| Dividend / coupon income | **10%**  | Gross amount (net received + any withholding already on the transaction) |

**Design-fidelity note (intentional):** dividend/coupon tax is always computed as
`gross × 10%`, ignoring whatever a broker may have already withheld on the underlying
transaction. This mirrors the flat-estimate framing used for the German path too ("an
estimate, not a filed tax figure") — it is not meant to net against real withholding, so
it isn't a bug to "fix" if the numbers don't match a real Indonesian tax bill.

Realized gain (`IdYearInput.realized` / `IdDisposalLot.gain`) is carried through the
output purely for display — it's informational, since ID final tax is never actually
levied on gains.

Unlike the DE path, this module has no dedicated API route. It's computed directly in
the web app's server components (`apps/web/src/app/[locale]/(app)/tax/
tax-detail-section.tsx`, `apps/web/src/app/[locale]/(app)/reports/page.tsx`) from a
trade log that page already loaded, since the computation is a stateless roll-up with no
allowance/carry-forward state to fetch.

## `costBasisMode` — not a tax setting

`userPreferences.costBasisMode` (`"purchase_price"` default, or `"total_paid"`) is a
**separate** global preference from `taxRegime` — it changes how cost basis is computed
for FIFO/average-cost trade logs and P&L generally (`packages/core/src/valuation.ts`,
`CostBasisMode`), not anything tax-specific. It's unrelated to either tax module above;
don't assume a `taxRegime` change implies a `costBasisMode` change or vice versa. (A
same-named `costBasisMode` column also exists on the `loans` table for gold cicilan
contracts — display-only there, purely about which cost figure a loan's summary shows,
and entirely unrelated to this user-level preference.)

## References

- `packages/core/src/tax.ts` — German Sparerpauschbetrag/Teilfreistellung/two-pot
  netting/Vorabpauschale/harvest logic.
- `packages/core/src/tax-id.ts` — Indonesian final-tax logic.
- `packages/core/src/trade-log.ts` — `Trade.vorabByYear` / `TradeLeg.vorabCredit`
  (Vorabpauschale share-accounting), FIFO/average trade-log construction.
- `packages/core/src/valuation.ts` — `CostBasisMode`.
- `services/api/src/routes/transactions/tax.ts` — `/portfolios/:id/tax`,
  `/networth/tax`, rest-of-year income forecast.
- `services/api/src/routes/transactions/sparplan.ts` — the `taxRegime`-before-FSA-guard
  ordering.
- `services/api/src/routes/preferences.ts` — `GET`/`PUT /me/preferences`.
- `packages/db/src/schema.ts` — `userPreferences.taxRegime`/`costBasisMode`,
  `accountHolders.taxAllowanceAnnual`/`capitalGainsTaxRate`/`churchTax`/`taxResidence`,
  `portfolios.taxAllowanceAnnual`, `lossCarryforward`, `instruments.partialExemptionRate`.
- `apps/web/src/app/[locale]/(app)/tax/`, `apps/web/src/app/[locale]/(app)/reports/` —
  the pages that render both regimes.
