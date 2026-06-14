import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

// Inferred row types (select) and insert types for each table.
export type User = typeof schema.users.$inferSelect;
export type NewUser = typeof schema.users.$inferInsert;
export type Portfolio = typeof schema.portfolios.$inferSelect;
export type NewPortfolio = typeof schema.portfolios.$inferInsert;
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
