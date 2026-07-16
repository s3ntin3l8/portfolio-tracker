import type {
  InboxDocument,
  DocumentCategory,
  ImportRecord,
  ImportDetail,
  UnmappedEventType,
} from "@portfolio/api-client";
import { getServerApi, getSelectedPortfolioId } from "./_shared.js";

export async function loadDocuments(category?: DocumentCategory): Promise<InboxDocument[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolioId = await getSelectedPortfolioId();
    return await api.listDocuments(category, portfolioId ?? undefined);
  } catch {
    return [];
  }
}

export async function loadImports(): Promise<ImportRecord[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listImports();
  } catch {
    return [];
  }
}

export async function loadUnmappedEventTypes(): Promise<UnmappedEventType[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.getUnmappedEventTypes();
  } catch {
    return [];
  }
}

export async function loadImport(importId: string): Promise<ImportDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getImport(importId);
  } catch {
    return null;
  }
}
