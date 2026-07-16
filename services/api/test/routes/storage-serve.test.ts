import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { FolderProvider } from "../../src/storage/folder-provider.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let provider: FolderProvider;

const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long!!";
const TTL = 300;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-serve-test-"));
  provider = new FolderProvider({
    basePath: tmpDir,
    publicUrl: "",
    signingSecret: SIGNING_SECRET,
    signedUrlTtl: TTL,
  });
  // Put a test file
  await provider.put("receipts/test.pdf", Buffer.from("PDF-data"), {
    mimeType: "application/pdf",
    originalFilename: "receipt.pdf",
  });

  // Build app with the FolderProvider injected. The serving route uses
  // getStorageProvider() which returns the injected storage if set — we
  // patch the module-level cache via the injection seam.
  app = await buildApp({ storage: provider });
});

afterAll(async () => {
  await app.close();
  await closeDb();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /storage/:key — folder provider serving", () => {
  it("serves a file with a valid signed URL (token extracted from the URL)", async () => {
    const signedUrl = await provider.getSignedUrl("receipts/test.pdf", TTL);
    // signedUrl is root-relative (/storage/...) — strip the host part if present
    const urlPath = signedUrl.startsWith("http")
      ? new URL(signedUrl).pathname + "?" + new URL(signedUrl).search
      : signedUrl;

    const res = await app.inject({ method: "GET", url: urlPath });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("PDF-data");
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("receipt.pdf");
  });

  it("returns 403 when the sig is tampered", async () => {
    const signedUrl = await provider.getSignedUrl("receipts/test.pdf");
    const url = new URL("http://localhost" + signedUrl);
    url.searchParams.set("sig", "tampered");
    const urlPath = url.pathname + url.search;

    const res = await app.inject({ method: "GET", url: urlPath });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when exp is in the past", async () => {
    // Build a URL with an already-expired timestamp but correct sig
    const { createHmac } = await import("node:crypto");
    const past = Math.floor(Date.now() / 1000) - 10;
    const sig = createHmac("sha256", SIGNING_SECRET)
      .update(`receipts/test.pdf:${past}`)
      .digest("base64url");
    const url = `/storage/receipts/test.pdf?exp=${past}&sig=${sig}`;

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when exp or sig is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/storage/receipts/test.pdf" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when exp is non-numeric (NaN)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/storage/receipts/test.pdf?exp=not-a-number&sig=anysig",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("propagates non-ENOENT filesystem errors as 500", async () => {
    const permError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const spy = vi.spyOn(provider, "readFile").mockRejectedValueOnce(permError);

    const signedUrl = await provider.getSignedUrl("receipts/test.pdf", TTL);
    const urlPath = signedUrl.startsWith("http")
      ? new URL(signedUrl).pathname + "?" + new URL(signedUrl).search
      : signedUrl;

    const res = await app.inject({ method: "GET", url: urlPath });
    expect(res.statusCode).toBe(500);
    spy.mockRestore();
  });

  it("returns 404 for a key that does not exist (valid token)", async () => {
    const signedUrl = await provider.getSignedUrl("missing/file.txt");
    const urlPath = signedUrl.startsWith("http")
      ? new URL(signedUrl).pathname + "?" + new URL(signedUrl).search
      : signedUrl;

    const res = await app.inject({ method: "GET", url: urlPath });
    expect(res.statusCode).toBe(404);
  });
});
