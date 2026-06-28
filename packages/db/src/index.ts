import path from "node:path";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

// Absolute path to this package's generated SQL migrations, for the API to apply
// at startup. Resolves relative to the built/aliased module location.
export const migrationsDir = path.resolve(import.meta.dirname, "../drizzle");

// Inferred row types (select) and insert types for each table.
export type User = typeof schema.users.$inferSelect;
export type NewUser = typeof schema.users.$inferInsert;
export type ApiToken = typeof schema.apiTokens.$inferSelect;
export type NewApiToken = typeof schema.apiTokens.$inferInsert;
export type Portfolio = typeof schema.portfolios.$inferSelect;
export type NewPortfolio = typeof schema.portfolios.$inferInsert;
export type AccountHolder = typeof schema.accountHolders.$inferSelect;
export type NewAccountHolder = typeof schema.accountHolders.$inferInsert;
export type Instrument = typeof schema.instruments.$inferSelect;
export type NewInstrument = typeof schema.instruments.$inferInsert;
export type Transaction = typeof schema.transactions.$inferSelect;
export type NewTransaction = typeof schema.transactions.$inferInsert;
export type CorporateAction = typeof schema.corporateActions.$inferSelect;
export type NewCorporateAction = typeof schema.corporateActions.$inferInsert;
export type ScreenshotImport = typeof schema.screenshotImports.$inferSelect;
export type NewScreenshotImport = typeof schema.screenshotImports.$inferInsert;
export type Price = typeof schema.prices.$inferSelect;
export type NewPrice = typeof schema.prices.$inferInsert;
export type LastPrice = typeof schema.lastPrices.$inferSelect;
export type NewLastPrice = typeof schema.lastPrices.$inferInsert;
export type FxRate = typeof schema.fxRates.$inferSelect;
export type NewFxRate = typeof schema.fxRates.$inferInsert;
export type ProviderSetting = typeof schema.providerSettings.$inferSelect;
export type NewProviderSetting = typeof schema.providerSettings.$inferInsert;
export type ProviderUsageRow = typeof schema.providerUsage.$inferSelect;
export type NewProviderUsageRow = typeof schema.providerUsage.$inferInsert;
export type ScrapedQuote = typeof schema.scrapedQuotes.$inferSelect;
export type NewScrapedQuote = typeof schema.scrapedQuotes.$inferInsert;
export type DividendEvent = typeof schema.dividendEvents.$inferSelect;
export type NewDividendEvent = typeof schema.dividendEvents.$inferInsert;
export type ProviderCredential = typeof schema.providerCredentials.$inferSelect;
export type NewProviderCredential = typeof schema.providerCredentials.$inferInsert;
export type VisionProviderSetting = typeof schema.visionProviderSettings.$inferSelect;
export type NewVisionProviderSetting = typeof schema.visionProviderSettings.$inferInsert;
export type AdminAuditEntry = typeof schema.adminAuditLog.$inferSelect;
export type NewAdminAuditEntry = typeof schema.adminAuditLog.$inferInsert;
export type ImportSettingsRow = typeof schema.importSettings.$inferSelect;
export type NewImportSettingsRow = typeof schema.importSettings.$inferInsert;
export type StorageSettingsRow = typeof schema.storageSettings.$inferSelect;
export type NewStorageSettingsRow = typeof schema.storageSettings.$inferInsert;
export type Document = typeof schema.documents.$inferSelect;
export type NewDocument = typeof schema.documents.$inferInsert;
export type TransactionSource = typeof schema.transactionSources.$inferSelect;
export type NewTransactionSource = typeof schema.transactionSources.$inferInsert;
export type IbkrConnection = typeof schema.ibkrConnections.$inferSelect;
export type NewIbkrConnection = typeof schema.ibkrConnections.$inferInsert;
