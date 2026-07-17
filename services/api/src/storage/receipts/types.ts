export interface StoreReceiptOptions {
  userId: string;
  importId: string;
  buf: Buffer;
  mimeType: string;
  originalFilename?: string | null;
  source?: string | null;
  sourceEventId?: string | null;
  status?: "staged" | "retained";
}

export interface FinalizeReceiptsOptions {
  importId: string;
  portfolioId: string;
  retain: boolean;
}

export interface DocumentMeta {
  id: string;
  storageKey: string;
  mimeType: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  storedAt: Date;
  source: string | null;
  importId: string | null;
  transactionId: string | null;
  portfolioId: string | null;
  userId: string;
}

export interface DocumentSummary {
  id: string;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  storedAt: Date;
}

export type StoreReceiptResult = { ok: true; documentId: string } | { ok: false; error: string };
