# Interactive Brokers — Flex Web Service Setup

This guide walks through connecting an Interactive Brokers account to the portfolio tracker using the **Flex Web Service** — a read-only token-based API that delivers Activity Statement XML over HTTPS. No password is stored; the token is scoped, IP-lockable, and expires on a schedule you control.

## How it works

1. You create an **Activity Flex Query** in the IBKR portal that defines exactly which sections and fields to export.
2. You generate a **Flex Web Service token** that authorises programmatic access to that query.
3. You paste both into the portfolio tracker's Connect dialog.
4. The tracker calls `SendRequest` → `GetStatement` on the Flex endpoint once a day (or on demand) and stages new activity as draft transactions for you to confirm.

---

## Step 1 — Create an Activity Flex Query

Log in to Client Portal at [https://www.interactivebrokers.com/sso/Login](https://www.interactivebrokers.com/sso/Login), then navigate to:

**Reports → Flex Queries → Create New Flex Query → Activity Flex Query**

### Query settings

| Setting                  | Recommended value                                  |
| ------------------------ | -------------------------------------------------- |
| Query name               | `pocket-portfolio-tracker` (or anything memorable) |
| Date Range               | **Last 365 Days**                                  |
| Format                   | XML                                                |
| Period                   | Daily                                              |
| Include Cancelled Trades | No                                                 |

> **Date Range note:** The tracker's dedup system (resolved-events ledger) prevents already-confirmed transactions from being re-staged, so a rolling 365-day window is safe — confirmed events are never duplicated even if they re-appear in a later fetch.

---

### Sections and fields to include

Tick the following sections and, within each section, enable at least the fields listed. Enabling additional fields is harmless; missing a required field will cause that event type to be silently skipped or mis-mapped.

---

#### Trades

Required fields:

| Field                    | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `Asset Category`         | Maps to equity / ETF / bond / fund / crypto        |
| `Symbol`                 | Ticker (used as fallback instrument identifier)    |
| `Description`            | Instrument name                                    |
| `ISIN`                   | Primary instrument resolver                        |
| `Con ID`                 | IB contract ID (secondary resolver)                |
| `Trade ID`               | Stable external ID — used for dedup                |
| `Trade Date`             | Execution date                                     |
| `Currency`               | Trade currency                                     |
| `Quantity`               | Signed quantity (positive = buy, negative = sell)  |
| `Trade Price`            | Price per share / unit                             |
| `IB Commission`          | Brokerage fee (always negative in Flex)            |
| `IB Commission Currency` | Currency of the commission                         |
| `Taxes`                  | Trade-level tax (stamp duty, withholding on trade) |
| `FX Rate To Base`        | FX rate to your account's base currency            |
| `Buy/Sell`               | `BUY` or `SELL`                                    |
| `Level of Detail`        | Enables filtering EXECUTION vs ORDER rows          |

> The tracker skips `ORDER`-level summary rows automatically when both `EXECUTION` and `ORDER` rows are present, so enabling both levels of detail is fine.

---

#### Cash Transactions

Required fields:

| Field             | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `Asset Category`  | Links dividend/interest to an instrument class       |
| `Symbol`          | Instrument ticker (dividend source)                  |
| `Description`     | Full description of the cash event                   |
| `ISIN`            | Instrument ISIN for dividend rows                    |
| `Currency`        | Cash currency                                        |
| `Amount`          | Signed amount (positive = received, negative = paid) |
| `Date/Time`       | Transaction date                                     |
| `Type`            | Transaction type (see below)                         |
| `Transaction ID`  | Stable external ID — used for dedup                  |
| `Level of Detail` | Enables filtering DETAIL vs SUMMARY rows             |

Transaction types the tracker acts on:

| Type value                     | Mapped to                                                  |
| ------------------------------ | ---------------------------------------------------------- |
| `Dividends`                    | `dividend`                                                 |
| `Payment In Lieu Of Dividends` | `dividend`                                                 |
| `Withholding Tax`              | Folded into the matching dividend's `tax` field (see note) |
| `Broker Interest Received`     | `interest`                                                 |
| `Credit Interest`              | `interest`                                                 |
| `Bond Interest Received`       | `interest`                                                 |
| `Deposits/Withdrawals`         | `deposit` (positive) or `withdrawal` (negative)            |

All other types (fees, debit interest, commission adjustments, etc.) are intentionally ignored — they are internal broker bookings, not portfolio-level events.

> **Withholding tax:** IBKR reports dividends as the _net_ amount after withholding. The tracker matches each `Withholding Tax` row to its `Dividends` row by symbol + date, adds the absolute withholding amount to the dividend's `tax` field, and reconstructs the gross dividend. This preserves the correct gross/net split for tax reporting.

---

#### Transfers

Required fields:

| Field              | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `Asset Category`   | Filters out cash-only transfers                                                |
| `Symbol`           | Instrument ticker                                                              |
| `Description`      | Instrument name                                                                |
| `ISIN`             | Instrument ISIN                                                                |
| `Con ID`           | IB contract ID                                                                 |
| `Currency`         | Position currency                                                              |
| `Quantity`         | Signed quantity                                                                |
| `Date`             | Transfer date                                                                  |
| `Type`             | Direction: `IN`, `OUT`, `ACATS IN`, `ACATS OUT`, `INTERNAL IN`, `INTERNAL OUT` |
| `Direction`        | Fallback direction field                                                       |
| `Cost Basis Price` | Per-share carried cost basis (used as transfer price)                          |
| `Cost Basis Money` | Total carried cost (fallback when per-share unavailable)                       |
| `Position Amount`  | Market value at transfer date (last-resort cost proxy)                         |
| `Transaction ID`   | Stable external ID — used for dedup                                            |

Transfers are mapped to `transfer_in` / `transfer_out` at the carried cost basis. If cost basis is unavailable the price defaults to 0 and is flagged as low-confidence in the review screen.

---

#### Open Positions

Required fields:

| Field                    | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `Asset Category`         | Instrument class                                      |
| `Symbol`                 | Ticker                                                |
| `Description`            | Instrument name                                       |
| `ISIN`                   | Instrument ISIN                                       |
| `Con ID`                 | IB contract ID                                        |
| `Currency`               | Position currency                                     |
| `Report Date`            | Snapshot date                                         |
| `Position`               | Quantity held (signed — short positions are negative) |
| `Mark Price`             | EOD price                                             |
| `Position Value`         | Position × mark price (in trade currency)             |
| `Position Value in Base` | Position value in account base currency               |
| `Cost Basis Price`       | Average cost per share                                |
| `Cost Basis Money`       | Total cost basis                                      |

Open Positions are used by the cash/position reconciliation step to compare IBKR's reported holdings against the tracker's derived quantities. Discrepancies are surfaced as reconciliation notes in the Connect dialog.

---

#### Corporate Actions

Required fields:

| Field                | Purpose                             |
| -------------------- | ----------------------------------- |
| `Asset Category`     | Instrument class                    |
| `Symbol`             | Ticker                              |
| `ISIN`               | Instrument ISIN                     |
| `Currency`           | Currency                            |
| `Type`               | CA type code (see below)            |
| `Date/Time`          | Action date                         |
| `Report Date`        | Fallback date                       |
| `Description`        | Human-readable description          |
| `Action Description` | Verbose description (preferred)     |
| `Quantity`           | Share quantity delta                |
| `Transaction ID`     | Stable external ID — used for dedup |
| `Con ID`             | IB contract ID                      |

Only **stock splits** are auto-mapped:

| Type code | Description           |
| --------- | --------------------- |
| `SO`      | Stock split (forward) |
| `FS`      | Forward split         |
| `RS`      | Reverse split         |

Mergers, spinoffs, rights, tender offers, and other corporate action types are skipped — they require manual review. They will be surfaced as import errors in the draft review screen.

---

#### Cash Report

Required fields:

| Field         | Purpose                              |
| ------------- | ------------------------------------ |
| `Currency`    | Cash currency                        |
| `Ending Cash` | Balance as of the statement end date |

The Cash Report is used to compare IBKR's reported ending cash against the tracker's derived cash balance. Differences are displayed in the "Cash reconciliation" panel of the Connect dialog.

---

#### Account Information _(optional but recommended)_

Enable `Account ID` — it populates the account identifier shown in the Connect dialog and helps verify you connected the right account.

---

## Step 2 — Generate a Flex Web Service token

Navigate to:

**Settings → Account Settings → Flex Web Service**

1. Click **Create** (or the ✎ icon if one already exists).
2. Choose an **expiry** — up to 1 year. You will need to regenerate and reconnect when it expires; the tracker shows a "Token expired" status when that happens.
3. Optionally, enter the **IP address** of your server to lock the token to that IP (recommended for production).
4. Click **Generate** and copy the token — it is shown only once.

Note the **Query ID** from the Flex Queries list (it is the numeric ID next to the query you created in Step 1).

---

## Step 3 — Connect in the portfolio tracker

1. Open the portfolio whose brokerage is set to **Interactive Brokers**.
2. Click the pencil (edit) icon → scroll to the **Interactive Brokers Connection** section.
3. Paste the **Flex Token** and the numeric **Query ID**.
4. Click **Connect** — the tracker performs a test fetch to validate the token before saving.
5. Click **Sync now** to pull the first batch of activity.

New transactions appear as drafts on the **Import** page. Review and confirm them to add them to your portfolio.

---

## Sync schedule

Flex statements are end-of-day — intraday data is not available. The tracker syncs once a day at **02:00 UTC** via a background job (configurable via the `IBKR_SYNC_CRON` env var, server-side only). You can also trigger an on-demand sync at any time from the portfolio edit dialog or the portfolios page sync button.

---

## Troubleshooting

| Symptom                              | Likely cause                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Status: "Token expired"              | The Flex Web Service token has passed its expiry date — regenerate it in IBKR portal and reconnect                |
| Status: "Error"                      | Invalid token, IP mismatch, or the Flex query was deleted — check the last error in the dialog                    |
| Dividends imported with wrong amount | `Withholding Tax` rows are missing from your query — enable the field in Cash Transactions                        |
| Transfers show price 0               | `Cost Basis Price` / `Cost Basis Money` fields not included in Transfers section                                  |
| No data after sync                   | Query date range may not cover the activity period, or the query has no Trades/Cash Transactions sections enabled |
| Duplicate drafts                     | Unlikely with dedup active — if it happens, use "Re-import everything" to wipe and re-stage                       |
