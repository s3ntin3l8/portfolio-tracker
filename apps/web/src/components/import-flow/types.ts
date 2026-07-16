"use client";

import type { AccountMismatch, ImportIssue, DocumentCategory } from "@portfolio/api-client";

export type { ImportIssue } from "@portfolio/api-client";

export interface ImportDraft {
  assetClass: string;
  action: string;
  ticker?: string | null;
  isin?: string | null;
  wkn?: string | null;
  name?: string | null;
  quantity: string;
  unit: string;
  price: string;
  fees?: string | null;
  tax?: string | null;
  total?: string | null;
  currency: string;
  executedAt: string;
  confidence: number;
  externalId?: string | null;
  orderRef?: string | null;
  taxComponents?: Record<string, string> | null;
  likelyDuplicate?: import("@portfolio/api-client").LikelyDuplicate | null;
}

export interface ImportContractScheduleRow {
  n: number;
  dueDate: string;
  pokok: string;
  sewaModal: string;
  angsuran: string;
  sisaPokok: string;
}

export interface ImportContract {
  provider?: string | null;
  contractNo?: string | null;
  currency: string;
  grams: string;
  goldName?: string | null;
  purchasePrice: string;
  downPayment: string;
  adminFee: string;
  discount: string;
  principal: string;
  marginTotal: string;
  tenorMonths: number;
  monthlyInstallment: string;
  startDate: string;
  costBasisMode: "purchase_price" | "total_paid";
  schedule: ImportContractScheduleRow[];
  confidence: number;
}

export interface ImportResult {
  importId: string;
  drafts: ImportDraft[];
  contracts?: ImportContract[];
  errors: ImportIssue[];
  alreadyExists?: boolean;
  alreadyConfirmed?: boolean;
  matchedPortfolioId?: string | null;
  suggestedPortfolioId?: string | null;
  accountMismatch?: AccountMismatch | null;
  materialized?: boolean;
  materializedCount?: number;
  isReport?: boolean;
  reportCategory?: DocumentCategory;
  reportTaxYear?: number | null;
  reportTitle?: string;
}

export type ReviewDraft = ImportDraft & { uid: string; importId: string; _serverIdx: number };

export function newBatchId(): string | undefined {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : undefined;
}

let uidCounter = 0;
export function withUid(draft: ImportDraft, importId: string, serverIdx: number): ReviewDraft {
  const uid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `draft-${uidCounter++}`;
  return { ...draft, uid, importId, _serverIdx: serverIdx };
}

export function stripUid(draft: ReviewDraft): ImportDraft {
  const copy: ImportDraft & { uid?: string; importId?: string; _serverIdx?: number } = { ...draft };
  delete copy.uid;
  delete copy.importId;
  delete copy._serverIdx;
  return copy;
}

export interface ImportClient {
  importScreenshot(file: File | Blob, force?: boolean, batchId?: string): Promise<ImportResult>;
  importCsv(
    content: string,
    filename?: string,
    format?: CsvFormat,
    force?: boolean,
    batchId?: string,
  ): Promise<ImportResult>;
  confirmImport(
    importId: string,
    drafts: ImportDraft[],
    contracts?: ImportContract[],
    portfolioId?: string,
    acknowledgeAccountMismatch?: boolean,
    acknowledgeDuplicates?: boolean,
  ): Promise<{ confirmed: number; excludedCashMovements?: number; enriched?: number }>;
  materializeImport(
    importId: string,
    portfolioId: string,
    acknowledgeAccountMismatch?: boolean,
  ): Promise<{ materializedCount: number; excludedCashMovements: number; enrichedCount: number }>;
  checkAccounts(
    units: MaterializeUnit[],
  ): Promise<{ mismatches: ({ importId: string } & AccountMismatch)[] }>;
  uploadDocument(
    file: File | Blob,
    opts: { category?: DocumentCategory; taxYear?: number; portfolioId: string },
  ): Promise<{ id: string; duplicate: boolean }>;
}

export interface MaterializeUnit {
  importId: string;
  portfolioId: string;
}

export interface ImportTask {
  kind: "materialize" | "confirm";
  label: string;
  acknowledge: boolean;
  expectedCount?: number;
  units?: MaterializeUnit[];
  importId?: string;
  drafts?: ImportDraft[];
  contracts?: ImportContract[];
  portfolioId?: string;
}

export type Step = "upload" | "parsing" | "review" | "report";
export type CsvFormat = "auto" | "generic" | "dkb" | "ibkr" | "coinbase";

export interface ImportTargetPortfolio {
  id: string;
  name: string;
  brokerage: string | null;
  accountHolder: string | null;
}

export const STEPS: Step[] = ["upload", "review"];

const SAMPLE_DRAFT: ImportDraft = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold (Tabungan Emas)",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  fees: "0",
  currency: "IDR",
  executedAt: "2026-02-08",
  confidence: 0.94,
};

export const demoClient: ImportClient = {
  importScreenshot: async () => ({
    importId: "demo",
    drafts: [SAMPLE_DRAFT],
    contracts: [],
    errors: [],
  }),
  importCsv: async () => ({
    importId: "demo",
    drafts: [SAMPLE_DRAFT],
    contracts: [],
    errors: [],
  }),
  confirmImport: async (_id, drafts, contracts) => ({
    confirmed: drafts.length + (contracts?.length ?? 0),
  }),
  materializeImport: async () => ({
    materializedCount: 0,
    excludedCashMovements: 0,
    enrichedCount: 0,
  }),
  checkAccounts: async () => ({ mismatches: [] }),
  uploadDocument: async () => ({ id: "demo", duplicate: false }),
};

export type PortfolioByImportMap = Map<string, string>;

export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_error"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

export function isCsvFile(file: File): boolean {
  return (
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.toLowerCase().endsWith(".csv")
  );
}

export interface SkippedFile {
  file: string;
  reason: import("@/lib/import-errors").ImportSkipReason;
  provider?: string;
  originalFile?: File;
}

export type ParseOutcome =
  | { status: "ok"; importId: string; filename: string; result: ImportResult }
  | { status: "materialized"; count: number }
  | { status: "skipped"; skip: SkippedFile }
  | { status: "report"; file: string; title: string };

export interface FileStatus {
  filename: string;
  status: "pending" | "parsing" | "done" | "failed";
}

export type IssueMap = Map<string, ImportIssue[]>;
export type GroupMap = Map<string, string>;

export interface ReviewGroup {
  importId: string;
  filename: string;
}
