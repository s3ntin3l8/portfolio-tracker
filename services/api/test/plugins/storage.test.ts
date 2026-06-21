import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";

// A fake storage driver that records calls without touching real storage.
function makeInertStorage(): StorageProvider & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    put: async (key) => { puts.push(key); },
    getSignedUrl: async (key) => `https://fake.storage/${key}?signed=1`,
    delete: async () => {},
    exists: async () => false,
    get: async () => null,
    move: async () => {},
  };
}

describe("storage plugin / buildApp injection seam", () => {
  describe("with an injected fake storage", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    const fakeStorage = makeInertStorage();

    beforeAll(async () => {
      app = await buildApp({ storage: fakeStorage });
    });

    afterAll(async () => {
      await app.close();
      await closeDb();
    });

    it("decorates app.storage with the injected driver", () => {
      expect(app.storage).toBe(fakeStorage);
    });

    it("app.storage conforms to the StorageProvider interface", async () => {
      await app.storage.put("smoke/test.txt", Buffer.from("hi"), {
        mimeType: "text/plain",
      });
      expect(fakeStorage.puts).toContain("smoke/test.txt");

      const url = await app.storage.getSignedUrl("smoke/test.txt");
      expect(url).toContain("signed=1");

      const present = await app.storage.exists("smoke/test.txt");
      expect(present).toBe(false);
    });
  });

  describe("with real storage wired from env defaults", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      // No opts.storage — the real storagePlugin runs. We don't need a live MinIO
      // for this test: we only assert that app.storage is defined and is an object.
      // The bucket ensure is best-effort and will fail silently against localhost:9000.
      app = await buildApp();
    });

    afterAll(async () => {
      await app.close();
      await closeDb();
    });

    it("decorates app.storage (real provider instance)", () => {
      expect(app.storage).toBeDefined();
      expect(typeof app.storage.put).toBe("function");
      expect(typeof app.storage.getSignedUrl).toBe("function");
      expect(typeof app.storage.delete).toBe("function");
      expect(typeof app.storage.exists).toBe("function");
    });
  });
});
