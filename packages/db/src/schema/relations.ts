import { relations } from "drizzle-orm";
import { users, apiTokens } from "./users.js";
import { accountHolders } from "./account-holders.js";
import { portfolios } from "./portfolios.js";
import { instruments } from "./instruments.js";
import { transactions } from "./transactions.js";
import { transactionSources } from "./transaction-sources.js";
import { screenshotImports } from "./screenshot-imports.js";
import { trConnections } from "./connections.js";
import { userPreferences } from "./user-preferences.js";
import { documents } from "./documents.js";
import { loans } from "./loans.js";
import { prices } from "./dividends-prices.js";
import { corporateActions } from "./anomalies-corp-actions.js";
import { dividendEvents } from "./dividends-prices.js";

export const usersRelations = relations(users, ({ one, many }) => ({
  portfolios: many(portfolios),
  accountHolders: many(accountHolders),
  trConnection: one(trConnections, {
    fields: [users.id],
    references: [trConnections.userId],
  }),
  preferences: one(userPreferences, {
    fields: [users.id],
    references: [userPreferences.userId],
  }),
  apiTokens: many(apiTokens),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.userId], references: [users.id] }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));

export const accountHoldersRelations = relations(accountHolders, ({ one, many }) => ({
  user: one(users, { fields: [accountHolders.userId], references: [users.id] }),
  portfolios: many(portfolios),
}));

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  user: one(users, { fields: [portfolios.userId], references: [users.id] }),
  accountHolder: one(accountHolders, {
    fields: [portfolios.accountHolderId],
    references: [accountHolders.id],
  }),
  transactions: many(transactions),
  loans: many(loans),
}));

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  transactions: many(transactions),
  prices: many(prices),
  corporateActions: many(corporateActions),
  dividendEvents: many(dividendEvents),
  loans: many(loans),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  portfolio: one(portfolios, {
    fields: [transactions.portfolioId],
    references: [portfolios.id],
  }),
  instrument: one(instruments, {
    fields: [transactions.instrumentId],
    references: [instruments.id],
  }),
  loan: one(loans, {
    fields: [transactions.loanId],
    references: [loans.id],
  }),
  sources: many(transactionSources),
}));

export const transactionSourcesRelations = relations(transactionSources, ({ one }) => ({
  transaction: one(transactions, {
    fields: [transactionSources.transactionId],
    references: [transactions.id],
  }),
  import: one(screenshotImports, {
    fields: [transactionSources.importId],
    references: [screenshotImports.id],
  }),
  document: one(documents, {
    fields: [transactionSources.documentId],
    references: [documents.id],
  }),
}));

export const loansRelations = relations(loans, ({ one, many }) => ({
  portfolio: one(portfolios, {
    fields: [loans.portfolioId],
    references: [portfolios.id],
  }),
  instrument: one(instruments, {
    fields: [loans.instrumentId],
    references: [instruments.id],
  }),
  transactions: many(transactions),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  user: one(users, { fields: [documents.userId], references: [users.id] }),
  portfolio: one(portfolios, {
    fields: [documents.portfolioId],
    references: [portfolios.id],
  }),
  import: one(screenshotImports, {
    fields: [documents.importId],
    references: [screenshotImports.id],
  }),
  transaction: one(transactions, {
    fields: [documents.transactionId],
    references: [transactions.id],
  }),
}));
