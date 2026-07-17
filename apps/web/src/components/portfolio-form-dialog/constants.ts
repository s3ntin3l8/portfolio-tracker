import type { Portfolio } from "@portfolio/api-client";

export const CURRENCIES = ["IDR", "USD", "EUR", "SGD"];

export type EditablePortfolio = Pick<
  Portfolio,
  | "id"
  | "name"
  | "baseCurrency"
  | "accountHolderId"
  | "portfolioType"
  | "brokerage"
  | "accountNumber"
  | "iban"
  | "includeInAggregate"
  | "cashCounted"
  | "allowNegativeCash"
  | "documentRetention"
  | "taxAllowanceAnnual"
  | "transactionCount"
>;

export const NEW_HOLDER = "__new__";
