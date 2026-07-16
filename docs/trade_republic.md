# Trade Republic

Trade Republic sync runs the vendored **pytr** entrypoints
(`services/api/python/tr_login.py`, `tr_export.py`) as Python subprocesses. The API
spawns them using the interpreter named by **`PYTR_PYTHON_BIN`**
(`services/api/src/services/pytr/runner.ts`, default `python3`). If that interpreter has
no `pytr` installed, `tr_login.py` exits with `pytr not installed` and the route returns
**502 `tr_pairing_failed`** — the web UI shows the generic _"Something went wrong. Please
try again."_

Production handles this in the `Dockerfile` (a venv at `/opt/pytr-venv`). Local dev needs
the same two steps:

## Setup

```sh
make pytr-venv            # creates .venv-pytr and installs pytr (pinned in requirements.txt)
```

Then set the interpreter in your root `.env` to the venv's python, using an **absolute**
path (the subprocess is spawned with cwd under `services/api`, so a relative path is
ambiguous):

```
PYTR_PYTHON_BIN=/abs/path/to/pocket-portfolio-tracker/.venv-pytr/bin/python
```

Restart `make dev` so the API re-reads `.env`.

Verify the interpreter can import pytr:

```sh
.venv-pytr/bin/python -c "from pytr.api import TradeRepublicApi; print('ok')"
```

## Pairing (v2 push-approval)

Trade Republic killed the v1 SMS login; pytr 0.4.9 uses the **v2 push-approval** flow.
On **Connect**, enter your TR phone number and PIN — Trade Republic sends a push to your
**TR mobile app**. There is no SMS code: foreground the app and **approve the login
there**. The pairing window is bounded (`PYTR_APPROVAL_TIMEOUT_S`, default 180s on the
Python side); approve promptly or the attempt expires and you start over.

## How sync works

Once paired, `syncTrConnection()` (`services/api/src/services/pytr/sync.ts`) is the
orchestrator: it resumes the saved cookie session, exports the **full timeline** (every
event pytr has ever seen — the export is idempotent, not incremental, since every event
carries a stable id), then reconciles that timeline against what's already
confirmed/staged rather than blindly inserting. Each concern lives in its own module,
called in sequence from `sync.ts`:

1. **Cancellations** (`cancellation.ts`) — un-import any confirmed transaction whose
   source event now reports `CANCELED`/`CANCELLED` (e.g. TR restates an annual dividend).
2. **Resolved-events ledger** (`tr_resolved_events` table, `packages/db/src/schema.ts`) —
   the durable, TR-specific dedup layer (distinct from the general cross-source dedup in
   `CLAUDE.md`): every event already confirmed or discarded is recorded here, keyed by
   `(portfolioId, source="pytr", eventId)`, so a later sync never re-stages it even if the
   confirmed transaction was manually deleted. Seeded once from any pre-existing confirmed
   `pytr` transactions so the ledger is durable from the first sync after deploy.
3. **Self-heal discarded events** — on every sync, each ledger entry marked `discarded`
   (an auto-skipped "info" event, e.g. `CARD_VERIFICATION`) is re-run through the mapper;
   if the mapper can now produce a draft (because a later deploy taught it that event
   type), it's evicted from the ledger and re-staged. `confirmed` entries are never
   re-evaluated.
4. **Mapping** (`mapper.ts`) — new, not-yet-resolved, not-yet-staged events are mapped to
   draft transactions (see "Event mapping" below).
5. **Materialize** — drafts land directly in the main `transactions` table as
   `status='draft'` (idempotent via the `externalId` unique index), not in a legacy
   review-only staging area. A single stable "anchor" `imports` row per connection holds
   any residual unmapped events as attention-level issues.
6. **Documents** (`documents.ts`, `reports.ts`) — best-effort postbox PDF and annual-report
   download for the newly-staged drafts (see "Documents" below).
7. **Reconciliation** (`reconcile.ts`) — TR's own reported cash/position balances vs. what
   the full mapped timeline derives (see "Reconciliation" below), then the rolling cookie
   session is re-encrypted and saved to extend its life.

A sync is **boundary-aware** (issue #326): a cash-inside portfolio (`cashCounted=true`,
e.g. a Tagesgeld/Festgeld sub-account) imports every event including deposits,
withdrawals, and card spending; a cash-outside (invest-only) portfolio excludes genuine
cash movements so they don't manufacture phantom flows against a value boundary that
excludes cash (see `CLAUDE.md`'s "one boundary per portfolio"). Unknown/unmapped event
types are never excluded by this filter — they always surface as attention gaps. Flipping
a portfolio's boundary re-stages any previously-excluded events on the next sync.

## Event mapping

`mapper.ts` maps TR's timeline event taxonomy (validated against a real 912-event
account) to internal transaction actions. Highlights, not an exhaustive list:

| TR event type(s)                                                                    | Action                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDER_EXECUTED`, `TRADE_INVOICE`, `TRADING_TRADE_EXECUTED`                         | `buy`/`sell` (by the sign of the booked amount)                                                                                                                |
| `SAVINGS_PLAN_EXECUTED`, `TRADING_SAVINGSPLAN_EXECUTED`, `SAVEBACK_AGGREGATE`       | `savings_plan`                                                                                                                                                 |
| `SPARE_CHANGE_AGGREGATE` (round-ups)                                                | `buy`, tagged `kind: "roundup"`                                                                                                                                |
| `CREDIT`                                                                            | `dividend`                                                                                                                                                     |
| `INTEREST_PAYOUT`, `INTEREST_PAYOUT_CREATED`                                        | `interest`                                                                                                                                                     |
| `TRANSFER_IN`/`TRANSFER_OUT`/`SSP_SECURITIES_TRANSFER_INCOMING`                     | `transfer_in`/`transfer_out` (Depotübertrag, cash-neutral, carried cost 0 at import)                                                                           |
| `SSP_CORPORATE_ACTION_CASH`                                                         | `dividend` if tied to an ISIN, else `deposit`                                                                                                                  |
| `SSP_CORPORATE_ACTION_INSTRUMENT`                                                   | `buy` (dividend reinvestment) or `bonus` (free share issue, amount 0)                                                                                          |
| `SSP_CORPORATE_ACTION_NO_CASH` with `kind: "vorabpauschale"`                        | `tax` — the Vorabpauschale (German advance lump-sum fund tax) taxable base is carried separately in `vorabBase`, read directly by `packages/core`'s tax module |
| `EARNINGS`                                                                          | `tax`                                                                                                                                                          |
| `PAYMENT_INBOUND*`, `INCOMING_TRANSFER*`, `ACCOUNT_TRANSFER_INCOMING`               | `deposit`                                                                                                                                                      |
| `PAYMENT_OUTBOUND`, `OUTGOING_TRANSFER*`, `CARD_TRANSACTION`, `CARD_ATM_WITHDRAWAL` | `withdrawal`                                                                                                                                                   |

Only `EXECUTED` events become drafts; a `PENDING` event is skipped (re-evaluated once it
settles). Purely administrative/notification events (order lifecycle, documents created,
account/profile changes, FSA change notifications) are recorded as `info`-severity skips
with a reason — never silently dropped — so they don't pollute the "unmapped event type"
attention gap the mapper reserves for genuinely unrecognized events. A trade's executed
price × share count is cross-checked against the booked total; a mismatch beyond a small
tolerance drops the draft's confidence to 0.5 so it's flagged for review rather than
trusted.

**Dividend corrections.** TR periodically restates a dividend after the fact (e.g. a
withholding-tax true-up). When the restated event resolves cleanly, the mapper splits it
into two bookings: the original amount re-attributed to its true distribution period, and
the correction delta effective in the period it was discovered — so neither the original
period's income nor the current period's true-up is misdated or double-counted.

**Sell tax.** When TR reports an execution price for a sell, its tax is derived
algebraically from the net proceeds (`tax = notional − fees − netCredited`) rather than
trusted from the feed's own preliminary `tax` field — TR's trade-time tax estimate is
provisional and is later revised by a settlement PDF or a "Steuerliche Optimierung"
true-up; deriving from the net amount TR actually credited is the only value for which
the cash-flow identity holds exactly.

## Reconciliation

`reconcile.ts` maps the **entire** raw timeline (not just what's been confirmed) to
compare TR's own reported cash balance and per-ISIN positions against what the mapper
derives — this answers "did the mapper account for every cash/share movement TR knows
about," independent of the cash-boundary staging filter and of how much the user has
actually confirmed. A cash-diff jump of more than €1 since the previous sync is logged as
a drift warning. A manual `adjustment` transaction (or a manual, negative-priced income
row correcting a known feed-side ghost dividend) is folded into the derived side at read
time, so booking a true-up actually clears the reconciliation gap instead of only fixing
the holdings-cash number on a different screen. Results surface in the portfolio's Connect
dialog.

## Documents

Two independent, best-effort document paths, both non-fatal on failure:

- **Per-transaction postbox PDFs** (`documents.ts`) — downloaded only when the portfolio
  has `documentRetention=true`, and only for newly-staged drafts (future-only: enabling
  retention doesn't retroactively backfill PDFs for already-confirmed events). A
  **denylist** (not an allowlist) of known-noise `postboxType` codes
  (`SAVINGS_PLAN_CREATED`, `BENEFIT_CASH_REWARD_INVOICE`, `BENEFIT_ACTIVATED`, `INFO`,
  plus any `COSTS_INFO*`/`CONFIRM_ORDER*`/`*_EX_ANTE` type) is skipped — deliberately not
  an allowlist, since roughly 30% of TR postbox documents have an empty/unknown
  `postboxType` and some of those are real settlements. After storing, retained
  settlement/dividend PDFs are parsed to fill in tax/fee/price detail the timeline event
  alone doesn't carry (`services/api/src/services/enrichment.ts`).
- **Account-level tax reports** (`reports.ts`) — TR's annual "Jährlicher Steuerbericht" and
  its legacy-named siblings never become a draft transaction (they carry no cash/share
  movement); instead their attached PDF is fetched into the user's tax-reports inbox
  (`storeInboxDocument`, category `tax_report`) every sync, independent of the
  `documentRetention` toggle. Idempotent per `(userId, sourceEventId)`.

## Sync schedule

TR sync runs **hourly** via a background job (`TR_SYNC_QUEUE`, cron `0 * * * *`,
`services/api/src/services/scheduler.ts`) — deliberately gentle on TR's API, since TR
data isn't intraday anyway. You can also trigger an on-demand sync at any time from the
portfolio's Connect dialog (`POST /tr/connection/sync`); repeated clicks are deduplicated
via a 30-second singleton key so they don't queue duplicate jobs.

`POST /tr/connection/reimport` wipes all confirmed/staged `pytr` transactions, the
resolved-events ledger, and any linked documents for the connection's portfolio, so the
next sync re-stages the entire timeline from scratch — the escape hatch for a mapper bug
that mis-booked historical data.

## Relevant config

| Var                 | Default   | Purpose                                                                                                           |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `PYTR_PYTHON_BIN`   | `python3` | Interpreter that runs the pytr entrypoints; point at the venv python.                                             |
| `PYTR_WAF_STRATEGY` | `awswaf`  | AWS-WAF token strategy. `awswaf` is no-browser; `playwright` needs a bundled Chromium (not installed by default). |
| `PYTR_ENABLED`      | `true`    | Master switch for the TR feature (subprocess + routes).                                                           |
| `DB_ENCRYPTION_KEY` | —         | Required: phone/PIN/session are encrypted at rest. Missing → 503 `encryption_required`.                           |

Document retention (`documentRetention`) and the cash boundary (`cashCounted`) that gate
document downloads and event filtering above are per-portfolio settings, not env vars —
set them on the portfolio itself, not in `.env`.
