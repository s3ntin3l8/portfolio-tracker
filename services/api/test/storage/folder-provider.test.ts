import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { FolderProvider } from "../../src/storage/folder-provider.js";

const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long!!";
const TTL = 3600;

let tmpDir: string;
let provider: FolderProvider;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "folder-provider-test-"));
  provider = new FolderProvider({
    basePath: tmpDir,
    publicUrl: "https://example.com",
    signingSecret: SIGNING_SECRET,
    signedUrlTtl: TTL,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("FolderProvider", () => {
  describe("put", () => {
    it("writes the file and a sidecar with mimeType", async () => {
      await provider.put("receipts/test.pdf", Buffer.from("PDF-data"), {
        mimeType: "application/pdf",
        originalFilename: "test.pdf",
      });

      const filePath = path.join(tmpDir, "receipts/test.pdf");
      const data = await fs.readFile(filePath);
      expect(data.toString()).toBe("PDF-data");

      const meta = JSON.parse(await fs.readFile(`${filePath}.meta.json`, "utf8"));
      expect(meta.mimeType).toBe("application/pdf");
      expect(meta.originalFilename).toBe("test.pdf");
    });

    it("creates parent directories as needed", async () => {
      await provider.put("deep/nested/dir/file.txt", Buffer.from("hi"), {
        mimeType: "text/plain",
      });
      const filePath = path.join(tmpDir, "deep/nested/dir/file.txt");
      expect(await fs.readFile(filePath, "utf8")).toBe("hi");
    });

    it("omits originalFilename from sidecar when not provided", async () => {
      await provider.put("file.txt", Buffer.from("x"), { mimeType: "text/plain" });
      const meta = JSON.parse(await fs.readFile(path.join(tmpDir, "file.txt.meta.json"), "utf8"));
      expect(meta.originalFilename).toBeUndefined();
    });
  });

  describe("exists", () => {
    it("returns true for a file that was put", async () => {
      await provider.put("file.txt", Buffer.from("x"), { mimeType: "text/plain" });
      expect(await provider.exists("file.txt")).toBe(true);
    });

    it("returns false for a missing key", async () => {
      expect(await provider.exists("does-not-exist.txt")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes the file and sidecar", async () => {
      await provider.put("file.txt", Buffer.from("x"), { mimeType: "text/plain" });
      await provider.delete("file.txt");
      expect(await provider.exists("file.txt")).toBe(false);
      // Sidecar should also be gone
      await expect(fs.readFile(path.join(tmpDir, "file.txt.meta.json"))).rejects.toThrow();
    });

    it("no-ops when the file does not exist", async () => {
      await expect(provider.delete("missing.txt")).resolves.not.toThrow();
    });
  });

  describe("getSignedUrl", () => {
    it("returns a URL with exp and sig query params", async () => {
      const url = await provider.getSignedUrl("receipts/file.pdf", 300);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/storage/receipts/file.pdf");
      expect(parsed.searchParams.has("exp")).toBe(true);
      expect(parsed.searchParams.has("sig")).toBe(true);
    });

    it("uses the default TTL when no expiresInSeconds is provided", async () => {
      const url = await provider.getSignedUrl("file.pdf");
      const parsed = new URL(url);
      const exp = parseInt(parsed.searchParams.get("exp")!, 10);
      const now = Math.floor(Date.now() / 1000);
      // exp should be ~now + TTL (3600)
      expect(exp).toBeGreaterThanOrEqual(now + TTL - 2);
      expect(exp).toBeLessThanOrEqual(now + TTL + 2);
    });

    it("HMAC is verifiable with the same secret", async () => {
      const url = await provider.getSignedUrl("docs/file.pdf", 600);
      const parsed = new URL(url);
      const exp = parseInt(parsed.searchParams.get("exp")!, 10);
      const sig = parsed.searchParams.get("sig")!;
      // Recompute the HMAC and compare
      const expected = createHmac("sha256", SIGNING_SECRET)
        .update(`docs/file.pdf:${exp}`)
        .digest("base64url");
      expect(sig).toBe(expected);
    });

    it("produces root-relative URLs when publicUrl is empty", async () => {
      const pRelative = new FolderProvider({
        basePath: tmpDir,
        publicUrl: "",
        signingSecret: SIGNING_SECRET,
        signedUrlTtl: TTL,
      });
      const url = await pRelative.getSignedUrl("file.pdf");
      expect(url).toMatch(/^\/storage\/file\.pdf\?/);
    });

    it("throws when signingSecret is empty", async () => {
      const p = new FolderProvider({
        basePath: tmpDir,
        publicUrl: "",
        signingSecret: "",
        signedUrlTtl: TTL,
      });
      await expect(p.getSignedUrl("key")).rejects.toThrow(/signing secret/);
    });
  });

  describe("verifyToken", () => {
    it("returns true for a valid unexpired token", async () => {
      const url = await provider.getSignedUrl("test.pdf", 300);
      const parsed = new URL(url);
      const exp = parseInt(parsed.searchParams.get("exp")!, 10);
      const sig = parsed.searchParams.get("sig")!;
      expect(provider.verifyToken("test.pdf", exp, sig)).toBe(true);
    });

    it("returns false for a tampered signature", async () => {
      const url = await provider.getSignedUrl("test.pdf", 300);
      const parsed = new URL(url);
      const exp = parseInt(parsed.searchParams.get("exp")!, 10);
      expect(provider.verifyToken("test.pdf", exp, "tampered-sig")).toBe(false);
    });

    it("returns false for an expired token", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const sig = createHmac("sha256", SIGNING_SECRET)
        .update(`test.pdf:${past}`)
        .digest("base64url");
      expect(provider.verifyToken("test.pdf", past, sig)).toBe(false);
    });

    it("returns false when signingSecret is empty", () => {
      const p = new FolderProvider({
        basePath: tmpDir,
        publicUrl: "",
        signingSecret: "",
        signedUrlTtl: TTL,
      });
      expect(p.verifyToken("k", 9999999999, "sig")).toBe(false);
    });
  });

  describe("path traversal rejection", () => {
    it("rejects a key with '..'", async () => {
      await expect(
        provider.put("../escape.txt", Buffer.from("x"), { mimeType: "text/plain" }),
      ).rejects.toThrow(/escapes base directory/);
    });

    it("rejects an absolute key", async () => {
      await expect(
        provider.put("/etc/passwd", Buffer.from("x"), { mimeType: "text/plain" }),
      ).rejects.toThrow(/must be relative/);
    });

    it("rejects a deeply nested traversal", async () => {
      await expect(provider.exists("subdir/../../etc/shadow")).rejects.toThrow(
        /escapes base directory/,
      );
    });
  });

  describe("stats", () => {
    it("returns zero counts on an empty directory", async () => {
      const s = await provider.stats();
      expect(s.objectCount).toBe(0);
      expect(s.totalBytes).toBe(0);
    });

    it("counts files and bytes, skipping .meta.json sidecars", async () => {
      await provider.put("a.txt", Buffer.from("hello"), { mimeType: "text/plain" });
      await provider.put("b.txt", Buffer.from("world!"), { mimeType: "text/plain" });

      const s = await provider.stats();
      expect(s.objectCount).toBe(2);
      expect(s.totalBytes).toBe(11); // "hello" (5) + "world!" (6)
    });

    it("returns freeBytes and diskTotalBytes", async () => {
      const s = await provider.stats();
      expect(typeof s.freeBytes).toBe("number");
      expect(typeof s.diskTotalBytes).toBe("number");
      expect(s.diskTotalBytes!).toBeGreaterThan(0);
    });
  });

  describe("readFile", () => {
    it("returns data and metadata", async () => {
      await provider.put("doc.pdf", Buffer.from("PDF"), {
        mimeType: "application/pdf",
        originalFilename: "document.pdf",
      });
      const { data, meta } = await provider.readFile("doc.pdf");
      expect(data.toString()).toBe("PDF");
      expect(meta.mimeType).toBe("application/pdf");
      expect(meta.originalFilename).toBe("document.pdf");
    });

    it("throws ENOENT for a missing key", async () => {
      await expect(provider.readFile("missing.txt")).rejects.toThrow();
    });
  });
});
