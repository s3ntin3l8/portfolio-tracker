/**
 * Unit tests for services/api/src/storage/receipts.ts.
 *
 * buildReceiptKey — pure unit tests, no DB or app required.
 * storeReceipt best-effort — verify a storage failure is swallowed (no throw).
 */
import { describe, it, expect } from "vitest";
import { buildReceiptKey, storeReceipt } from "../../src/storage/receipts.js";
import type { StorageProvider } from "../../src/storage/types.js";

// ---------------------------------------------------------------------------
// buildReceiptKey
// ---------------------------------------------------------------------------

describe("buildReceiptKey", () => {
  it("produces receipts/{userId}/{importId}/{filename}", () => {
    expect(buildReceiptKey("user1", "imp1", "statement.pdf")).toBe(
      "receipts/user1/imp1/statement.pdf",
    );
  });

  it("strips directory traversal from filename", () => {
    expect(buildReceiptKey("u", "i", "../../etc/passwd")).toBe("receipts/u/i/passwd");
  });

  it("falls back to 'document.pdf' when filename is null and mimeType is application/pdf", () => {
    expect(buildReceiptKey("u", "i", null, "application/pdf")).toBe(
      "receipts/u/i/document.pdf",
    );
  });

  it("falls back to 'document.csv' for text/csv", () => {
    expect(buildReceiptKey("u", "i", undefined, "text/csv")).toBe("receipts/u/i/document.csv");
  });

  it("falls back to bare 'document' when neither filename nor mime is given", () => {
    expect(buildReceiptKey("u", "i")).toBe("receipts/u/i/document");
  });

  it("always starts with receipts/", () => {
    const key = buildReceiptKey("abc", "def", "x.png");
    expect(key).toMatch(/^receipts\//);
  });
});

// ---------------------------------------------------------------------------
// storeReceipt — best-effort behaviour
// ---------------------------------------------------------------------------

function makeFailingStorage(): StorageProvider {
  return {
    put: async () => { throw new Error("storage is offline"); },
    getSignedUrl: async (k) => k,
    delete: async () => {},
    exists: async () => false,
    get: async () => null,
    move: async () => {},
  };
}

/** Minimal app-like mock: log + storage. storeReceipt catches failures before touching DB. */
function makeMinimalApp(storage: StorageProvider) {
  const errors: unknown[] = [];
  return {
    storage,
    // storeReceipt only calls app.db if storage.put succeeds — not reached here.
    db: null as never,
    log: {
      warn: () => {},
      debug: () => {},
      info: () => {},
      error: (...args: unknown[]) => errors.push(args),
    },
    _errors: errors,
  };
}

describe("storeReceipt — best-effort", () => {
  it("does not throw when storage.put fails, returns ok:false", async () => {
    const app = makeMinimalApp(makeFailingStorage());
    const result = await storeReceipt(app as never, {
      userId: "u1",
      importId: "imp1",
      buf: Buffer.from("hello"),
      mimeType: "text/plain",
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("storage put failed");
  });

  it("emits an error log (not warn) when storage.put fails", async () => {
    const app = makeMinimalApp(makeFailingStorage());
    await storeReceipt(app as never, {
      userId: "u1",
      importId: "imp1",
      buf: Buffer.from("hello"),
      mimeType: "text/plain",
    });
    expect(app._errors.length).toBeGreaterThan(0);
  });
});
