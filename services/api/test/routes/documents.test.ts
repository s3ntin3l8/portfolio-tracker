/**
 * Integration tests for the tax-reports inbox routes (routes/documents.ts):
 *   - GET /documents scopes to the caller, defaults to category=tax_report
 *   - POST /documents (multipart) stores a retained row + a storage object
 *   - POST /documents rejects non-PDF uploads
 *   - GET /documents/:id/url returns a signed URL, 403s for another user's document
 *   - DELETE /documents/:id removes both the row and the storage object
 *
 * Uses buildApp({ storage: makeTrackingStorage() }) — same pattern as
 * imports-receipts.test.ts — so no real S3/MinIO is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import type { StorageProvider } from "../../src/storage/types.js";

const ISSUER = "https://auth.test/application/o/portfolio/";
const AUDIENCE = "portfolio-tracker";

type App = Awaited<ReturnType<typeof buildApp>>;

function makeTrackingStorage(): StorageProvider & {
  puts: string[];
  deletes: string[];
  data: Map<string, Buffer>;
} {
  const puts: string[] = [];
  const deletes: string[] = [];
  const data = new Map<string, Buffer>();
  return {
    puts,
    deletes,
    data,
    put: async (key, body) => {
      puts.push(key);
      data.set(key, body instanceof Buffer ? body : Buffer.from("bytes"));
    },
    getSignedUrl: async (key) => `https://fake.storage/${key}?sig=test`,
    delete: async (key) => {
      deletes.push(key);
      data.delete(key);
    },
    exists: async (key) => data.has(key),
    get: async (key) => data.get(key) ?? null,
    move: async (src, dest) => {
      const buf = data.get(src);
      if (buf) {
        data.set(dest, buf);
        data.delete(src);
      }
    },
  };
}

/** Build a raw multipart/form-data payload with a file part plus optional text fields.
 *  Mirrors the helper in imports.test.ts (avoids form-auto-content's ESM/CJS interop issue). */
function multipartUpload(
  buf: Buffer,
  contentType: string,
  fields: Record<string, string> = {},
  filename = "report.pdf",
) {
  const boundary = "----PortfolioTestBoundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

/** Same as multipartUpload but with the file part FIRST and fields after — this is the
 *  order the real client (`api-client`'s `uploadDocument`) actually sends
 *  (`form.append("file", ...)` before `form.append("portfolioId", ...)`), unlike
 *  `multipartUpload` above which puts fields first. Regression guard: `@fastify/multipart`
 *  only finishes populating `part.fields` once the file stream has been fully drained, so
 *  a route that reads fields declared after the file in the wire order needs to await
 *  `part.toBuffer()` first — verifies that actually works end-to-end. */
function multipartUploadFileFirst(
  buf: Buffer,
  contentType: string,
  fields: Record<string, string> = {},
  filename = "report.pdf",
) {
  const boundary = "----PortfolioTestBoundaryFileFirst";
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    buf,
    Buffer.from(`\r\n`),
  ];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

async function makeToken(privateKey: CryptoKey, sub: string) {
  return new SignJWT({ email: `${sub}@test.example` })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

let app: App;
let store: ReturnType<typeof makeTrackingStorage>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  process.env.AUTHENTIK_ISSUER = ISSUER;
  process.env.AUTHENTIK_AUDIENCE = AUDIENCE;
  process.env.RATE_LIMIT_MAX = "50000";
  store = makeTrackingStorage();
  app = await buildApp({ authKey: kp.publicKey, storage: store });
}, 30_000);

afterAll(async () => {
  await app.close();
  await closeDb();
  delete process.env.AUTHENTIK_ISSUER;
  delete process.env.AUTHENTIK_AUDIENCE;
  delete process.env.RATE_LIMIT_MAX;
});

async function setup(sub: string) {
  const t = await makeToken(privateKey, sub);
  await app.inject({ method: "GET", url: "/me", headers: auth(t) }); // upsert user
  const portRes = await app.inject({
    method: "POST",
    url: "/portfolios",
    headers: auth(t),
    payload: { name: "Test", baseCurrency: "IDR" },
  });
  const portfolioId = (portRes.json() as { id: string }).id;
  return { t, portfolioId };
}

// portfolioId defaults to the owning user's own portfolio; pass `fields.portfolioId` to
// override (e.g. testing a cross-user portfolio id, or omitting it to test the 400).
async function upload(t: string, portfolioId: string, fields: Record<string, string> = {}) {
  const { headers, payload } = multipartUpload(Buffer.from("%PDF-1.4 fake pdf"), "application/pdf", {
    portfolioId,
    ...fields,
  });
  return app.inject({ method: "POST", url: "/documents", headers: { ...headers, ...auth(t) }, payload });
}

describe("GET /documents", () => {
  it("is empty for a fresh user", async () => {
    const { t } = await setup("doc-list-empty");
    const res = await app.inject({ method: "GET", url: "/documents", headers: auth(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("scopes results to the calling user only", async () => {
    const userA = await setup("doc-list-a");
    const userB = await setup("doc-list-b");
    await upload(userA.t, userA.portfolioId, { taxYear: "2025" });

    const resA = await app.inject({ method: "GET", url: "/documents", headers: auth(userA.t) });
    const resB = await app.inject({ method: "GET", url: "/documents", headers: auth(userB.t) });
    expect(resA.json()).toHaveLength(1);
    expect(resB.json()).toEqual([]);
  });

  it("filters to one portfolio via ?portfolioId=, when the user has more than one", async () => {
    const { t, portfolioId: firstPortfolioId } = await setup("doc-list-multi-portfolio");
    const secondPortRes = await app.inject({
      method: "POST",
      url: "/portfolios",
      headers: auth(t),
      payload: { name: "Second", baseCurrency: "IDR" },
    });
    const secondPortfolioId = (secondPortRes.json() as { id: string }).id;

    // Distinct byte content per upload — same bytes would content-hash-dedup regardless of
    // portfolioId (storeInboxDocument's idempotency is keyed on (userId, sourceEventId)
    // only), which would defeat this test's "two real documents" premise.
    await upload(t, firstPortfolioId, { taxYear: "2024" });
    const second = multipartUpload(Buffer.from("%PDF-1.4 a different fake pdf"), "application/pdf", {
      portfolioId: secondPortfolioId,
      taxYear: "2025",
    });
    await app.inject({ method: "POST", url: "/documents", headers: { ...second.headers, ...auth(t) }, payload: second.payload });

    const scoped = await app.inject({
      method: "GET",
      url: `/documents?portfolioId=${firstPortfolioId}`,
      headers: auth(t),
    });
    const rows = scoped.json() as Array<{ portfolioId: string; taxYear: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ portfolioId: firstPortfolioId, taxYear: 2024 });

    const all = await app.inject({ method: "GET", url: "/documents", headers: auth(t) });
    expect((all.json() as unknown[])).toHaveLength(2);
  });
});

describe("POST /documents", () => {
  it("uploads a PDF and stores a retained document + a storage object", async () => {
    const { t, portfolioId } = await setup("doc-upload-1");
    const putsBefore = store.puts.length;
    const res = await upload(t, portfolioId, { taxYear: "2025" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; duplicate: boolean; category: string; taxYear: number };
    expect(body.duplicate).toBe(false);
    expect(body.category).toBe("tax_report");
    expect(body.taxYear).toBe(2025);
    expect(store.puts.slice(putsBefore).some((k) => k.startsWith("inbox/"))).toBe(true);

    const list = await app.inject({ method: "GET", url: "/documents", headers: auth(t) });
    const rows = list.json() as Array<{ id: string; taxYear: number | null; source: string; portfolioId: string }>;
    expect(rows.find((r) => r.id === body.id)).toMatchObject({ taxYear: 2025, source: "upload", portfolioId });
  });

  it("accepts fields sent after the file part, matching the real client's field order", async () => {
    // The api-client appends the file part before category/taxYear/portfolioId — the
    // opposite order from this suite's `upload()` helper. Confirms the route (which awaits
    // part.toBuffer() before reading part.fields) actually handles that production order.
    const { t, portfolioId } = await setup("doc-upload-file-first-order");
    const { headers, payload } = multipartUploadFileFirst(Buffer.from("%PDF-1.4 fake pdf, file-first order"), "application/pdf", {
      portfolioId,
      taxYear: "2025",
    });
    const res = await app.inject({ method: "POST", url: "/documents", headers: { ...headers, ...auth(t) }, payload });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { category: string; taxYear: number };
    expect(body.category).toBe("tax_report");
    expect(body.taxYear).toBe(2025);
  });

  it("rejects a non-PDF upload with 415", async () => {
    const { t, portfolioId } = await setup("doc-upload-reject");
    const { headers, payload } = multipartUpload(Buffer.from("not a pdf"), "image/png", { portfolioId }, "photo.png");
    const res = await app.inject({ method: "POST", url: "/documents", headers: { ...headers, ...auth(t) }, payload });
    expect(res.statusCode).toBe(415);
  });

  it("rejects an upload with no portfolioId with 400", async () => {
    const { t } = await setup("doc-upload-no-portfolio");
    const { headers, payload } = multipartUpload(Buffer.from("%PDF-1.4 fake pdf"), "application/pdf", {});
    const res = await app.inject({ method: "POST", url: "/documents", headers: { ...headers, ...auth(t) }, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_fields" });
  });

  it("rejects an upload targeting another user's portfolio with 404", async () => {
    const userA = await setup("doc-upload-cross-a");
    const userB = await setup("doc-upload-cross-b");
    const res = await upload(userB.t, userA.portfolioId);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "portfolio_not_found" });
  });

  it("re-uploading the identical bytes is a no-op (content-hash dedup)", async () => {
    const { t, portfolioId } = await setup("doc-upload-dedup");
    const first = await upload(t, portfolioId, { taxYear: "2024" });
    const second = await upload(t, portfolioId, { taxYear: "2024" });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);

    const list = await app.inject({ method: "GET", url: "/documents", headers: auth(t) });
    expect((list.json() as unknown[]).length).toBe(1);
  });
});

describe("GET /documents/:documentId/url", () => {
  it("returns a signed URL for the owner", async () => {
    const { t, portfolioId } = await setup("doc-url-owner");
    const uploaded = await upload(t, portfolioId);
    const documentId = (uploaded.json() as { id: string }).id;

    const res = await app.inject({ method: "GET", url: `/documents/${documentId}/url`, headers: auth(t) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toContain("inbox/");
  });

  it("returns 403 for another user's document (IDOR guard)", async () => {
    const userA = await setup("doc-url-idor-a");
    const userB = await setup("doc-url-idor-b");
    const uploaded = await upload(userA.t, userA.portfolioId);
    const documentId = (uploaded.json() as { id: string }).id;

    const res = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/url`,
      headers: auth(userB.t),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for an unknown document id", async () => {
    const { t } = await setup("doc-url-404");
    const res = await app.inject({
      method: "GET",
      url: `/documents/00000000-0000-0000-0000-000000000000/url`,
      headers: auth(t),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /documents/:documentId", () => {
  it("removes both the row and the storage object", async () => {
    const { t, portfolioId } = await setup("doc-delete-1");
    const uploaded = await upload(t, portfolioId);
    const documentId = (uploaded.json() as { id: string }).id;

    // Resolve this specific document's storage key via its signed URL (the fake provider
    // encodes the key in the URL) — scanning store.puts globally would risk matching a
    // different test's still-live object with the same "inbox/" prefix.
    const urlRes = await app.inject({ method: "GET", url: `/documents/${documentId}/url`, headers: auth(t) });
    const key = (urlRes.json() as { url: string }).url.replace("https://fake.storage/", "").split("?")[0];
    expect(store.data.has(key)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/documents/${documentId}`, headers: auth(t) });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/documents", headers: auth(t) });
    expect((list.json() as Array<{ id: string }>).find((d) => d.id === documentId)).toBeUndefined();
    expect(store.data.has(key)).toBe(false);
  });

  it("returns 403 when another user attempts the delete", async () => {
    const userA = await setup("doc-delete-idor-a");
    const userB = await setup("doc-delete-idor-b");
    const uploaded = await upload(userA.t, userA.portfolioId);
    const documentId = (uploaded.json() as { id: string }).id;

    const res = await app.inject({
      method: "DELETE",
      url: `/documents/${documentId}`,
      headers: auth(userB.t),
    });
    expect(res.statusCode).toBe(403);
  });
});
