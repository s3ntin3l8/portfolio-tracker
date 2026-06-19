import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract the text layer of a PDF as a single flattened, space-joined stream — the input
 * the deterministic DKB-PDF parser ({@link ./dkb-pdf.ts}) expects. Returns "" for an
 * image-only/scanned PDF with no text layer (so the caller falls back to vision).
 */
export async function extractPdfText(data: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}
