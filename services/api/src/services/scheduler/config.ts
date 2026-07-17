export const QUEUE = "refresh-prices";
export const SCHEDULE_CRON = "*/5 * * * *";

export const SNAPSHOT_QUEUE = "daily-snapshot";
export const SNAPSHOT_CRON = "0 16 * * *";

export const INTRADAY_SNAPSHOT_QUEUE = "intraday-snapshot";
export const INTRADAY_SNAPSHOT_CRON = "*/15 * * * *";

export const TR_SYNC_QUEUE = "tr-sync";
export const TR_SYNC_CRON = "0 * * * *";

export const IBKR_SYNC_QUEUE = "ibkr-sync";

export const SYNC_CLAIM_LEASE_MS = 2 * 60 * 60_000; // 2 hours

export const ANTAM_QUEUE = "scrape-antam";
export const ANTAM_CRON = "0 */4 * * *";

export const NAV_QUEUE = "scrape-nav";
export const NAV_CRON = "0 1,16 * * *";

export const DIVIDEND_QUEUE = "refresh-dividends";
export const DIVIDEND_CRON = "0 6 * * 1";

export const INSTRUMENT_META_QUEUE = "refresh-instrument-metadata";
export const INSTRUMENT_META_CRON = "0 4 * * 0";

export const GC_RECEIPTS_QUEUE = "gc-staged-receipts";
export const GC_RECEIPTS_CRON = "0 3 * * *";

export const RECOMPUTE_QUEUE = "recompute-history";
export const RECOMPUTE_SINGLETON_SECONDS = 30;

export const BACKFILL_STALE_QUEUE = "backfill-stale-history";
export const BACKFILL_STALE_CRON = "0 5 * * *";

export const INSTRUMENT_META_SINGLETON_SECONDS = 6 * 60 * 60; // 6 hours

/**
 * The full descriptor for each scheduled queue, used by the admin jobs panel.
 * `cron: null` means the queue is triggered on-demand (no fixed schedule).
 *
 * #105 note: `triggerJob()` only affects the replica that receives the request.
 *  In a multi-replica setup the pg-boss job is still enqueued in Postgres so any
 *  idle worker replica can pick it up, but `invalidateMarketData()` /
 *  `invalidateScreenshotParser()` (in-process cache only) are NOT propagated.
 *  A LISTEN/NOTIFY fan-out is the proper fix; deferred until >1 replica is in use.
 */
export const JOB_DESCRIPTORS = [
  {
    name: QUEUE,
    label: "Price refresh",
    description: "Refresh last prices for all held instruments during market hours.",
    cron: SCHEDULE_CRON,
  },
  {
    name: SNAPSHOT_QUEUE,
    label: "Daily snapshot",
    description: "Record daily net-worth snapshots for the dashboard chart.",
    cron: SNAPSHOT_CRON,
  },
  {
    name: INTRADAY_SNAPSHOT_QUEUE,
    label: "Intraday snapshot",
    description:
      "Capture a net-worth point every 15 minutes (market-hours-gated) for the 1D/7D value chart.",
    cron: INTRADAY_SNAPSHOT_CRON,
  },
  {
    name: TR_SYNC_QUEUE,
    label: "Trade Republic sync",
    description: "Pull the latest Trade Republic timeline events and stage as draft imports.",
    cron: TR_SYNC_CRON,
  },
  {
    name: IBKR_SYNC_QUEUE,
    label: "Interactive Brokers sync",
    description: "Fetch IBKR Flex EOD statements and stage new transactions as draft imports.",
    cron: "0 2 * * *", // default; overridden by IBKR_SYNC_CRON env at runtime
  },
  {
    name: ANTAM_QUEUE,
    label: "Gold buyback scrape",
    description: "Scrape Antam and Galeri24 buyback rates into the scraped-quotes cache.",
    cron: ANTAM_CRON,
  },
  {
    name: NAV_QUEUE,
    label: "Reksa dana NAV scrape",
    description: "Scrape the Bibit NAV catalogue for all tracked mutual funds.",
    cron: NAV_CRON,
  },
  {
    name: DIVIDEND_QUEUE,
    label: "Dividend refresh",
    description: "Pull announced and historical dividend events from market-data providers.",
    cron: DIVIDEND_CRON,
  },
  {
    name: INSTRUMENT_META_QUEUE,
    label: "Instrument metadata refresh",
    description:
      "Fetch sector/industry/country from market-data providers for held instruments missing a sector.",
    cron: INSTRUMENT_META_CRON,
    supportsForce: true,
  },
  {
    name: GC_RECEIPTS_QUEUE,
    label: "Receipt GC",
    description:
      "Delete staged receipt documents from abandoned draft imports (older than 7 days).",
    cron: GC_RECEIPTS_CRON,
  },
  {
    name: BACKFILL_STALE_QUEUE,
    label: "Backfill stale history",
    description:
      "Find portfolios whose value-over-time history doesn't reach back to inception and backfill them. Idempotent — near-no-op once all portfolios are healed.",
    cron: BACKFILL_STALE_CRON,
    supportsForce: true,
  },
] as const;
