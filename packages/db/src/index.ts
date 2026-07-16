import path from "node:path";
import * as schema from "./schema/index.js";
export { schema };
import type { users, apiTokens } from "./schema/users.js";
import type { accountHolders } from "./schema/account-holders.js";
import type { portfolios } from "./schema/portfolios.js";
import type { instruments } from "./schema/instruments.js";
import type { screenshotImports } from "./schema/screenshot-imports.js";
import type { ibkrConnections } from "./schema/connections.js";
import type {
  providerSettings,
  providerUsage,
  scrapedQuotes,
  providerCredentials,
  visionProviderSettings,
  adminAuditLog,
  importSettings,
  storageSettings,
} from "./schema/admin.js";
import type { documents } from "./schema/documents.js";
import type { transactions } from "./schema/transactions.js";
import type { transactionSources } from "./schema/transaction-sources.js";
import type { corporateActions, dismissedAnomalies } from "./schema/anomalies-corp-actions.js";
import type { dividendEvents, prices, lastPrices } from "./schema/dividends-prices.js";
import type { benchmarkPrices, fxRates } from "./schema/user-preferences.js";

export * from "./schema/enums.js";
export * from "./schema/users.js";
export * from "./schema/account-holders.js";
export * from "./schema/portfolios.js";
export * from "./schema/instruments.js";
export * from "./schema/screenshot-imports.js";
export * from "./schema/connections.js";
export * from "./schema/admin.js";
export * from "./schema/documents.js";
export * from "./schema/transactions.js";
export * from "./schema/transaction-sources.js";
export * from "./schema/anomalies-corp-actions.js";
export * from "./schema/loans.js";
export * from "./schema/dividends-prices.js";
export * from "./schema/snapshots.js";
export * from "./schema/targets-tax.js";
export * from "./schema/user-preferences.js";
export * from "./schema/relations.js";

export const migrationsDir = path.resolve(import.meta.dirname, "../drizzle");

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
export type Portfolio = typeof portfolios.$inferSelect;
export type NewPortfolio = typeof portfolios.$inferInsert;
export type AccountHolder = typeof accountHolders.$inferSelect;
export type NewAccountHolder = typeof accountHolders.$inferInsert;
export type Instrument = typeof instruments.$inferSelect;
export type NewInstrument = typeof instruments.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type CorporateAction = typeof corporateActions.$inferSelect;
export type NewCorporateAction = typeof corporateActions.$inferInsert;
export type DismissedAnomaly = typeof dismissedAnomalies.$inferSelect;
export type NewDismissedAnomaly = typeof dismissedAnomalies.$inferInsert;
export type ScreenshotImport = typeof screenshotImports.$inferSelect;
export type NewScreenshotImport = typeof screenshotImports.$inferInsert;
export type Price = typeof prices.$inferSelect;
export type NewPrice = typeof prices.$inferInsert;
export type LastPrice = typeof lastPrices.$inferSelect;
export type NewLastPrice = typeof lastPrices.$inferInsert;
export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
export type ProviderSetting = typeof providerSettings.$inferSelect;
export type NewProviderSetting = typeof providerSettings.$inferInsert;
export type ProviderUsageRow = typeof providerUsage.$inferSelect;
export type NewProviderUsageRow = typeof providerUsage.$inferInsert;
export type ScrapedQuote = typeof scrapedQuotes.$inferSelect;
export type NewScrapedQuote = typeof scrapedQuotes.$inferInsert;
export type DividendEvent = typeof dividendEvents.$inferSelect;
export type NewDividendEvent = typeof dividendEvents.$inferInsert;
export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type NewProviderCredential = typeof providerCredentials.$inferInsert;
export type VisionProviderSetting = typeof visionProviderSettings.$inferSelect;
export type NewVisionProviderSetting = typeof visionProviderSettings.$inferInsert;
export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditEntry = typeof adminAuditLog.$inferInsert;
export type ImportSettingsRow = typeof importSettings.$inferSelect;
export type NewImportSettingsRow = typeof importSettings.$inferInsert;
export type StorageSettingsRow = typeof storageSettings.$inferSelect;
export type NewStorageSettingsRow = typeof storageSettings.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type TransactionSource = typeof transactionSources.$inferSelect;
export type NewTransactionSource = typeof transactionSources.$inferInsert;
export type IbkrConnection = typeof ibkrConnections.$inferSelect;
export type NewIbkrConnection = typeof ibkrConnections.$inferInsert;
export type BenchmarkPrice = typeof benchmarkPrices.$inferSelect;
export type NewBenchmarkPrice = typeof benchmarkPrices.$inferInsert;
