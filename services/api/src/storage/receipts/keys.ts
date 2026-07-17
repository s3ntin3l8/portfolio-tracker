import path from "node:path";
import { extFromMime as _extFromMime } from "../naming.js";

export function sanitiseFilename(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.-]/g, "_")
    .slice(0, 200);
  return base || "document";
}

export function buildReceiptKey(
  userId: string,
  importId: string,
  originalFilename?: string | null,
  mimeType?: string,
): string {
  const filename = originalFilename
    ? sanitiseFilename(originalFilename)
    : `document${mimeType ? _extFromMime(mimeType) : ""}`;
  return `receipts/${userId}/${importId}/${filename}`;
}
