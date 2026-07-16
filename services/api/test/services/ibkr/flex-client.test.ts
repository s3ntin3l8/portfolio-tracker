import { describe, it, expect } from "vitest";
import { createFlexClient, IbkrFlexError } from "../../../src/services/ibkr/flex-client.js";

// Helpers for building XML responses mimicking the Flex Web Service.

function sendRequestSuccess(referenceCode: string, url: string) {
  return `<?xml version="1.0"?><FlexStatementResponse timestamp="2024-01-01 00:00:00">
<Status>Success</Status>
<ReferenceCode>${referenceCode}</ReferenceCode>
<Url>${url}</Url>
</FlexStatementResponse>`;
}

function sendRequestError(code: string, message: string) {
  return `<?xml version="1.0"?><FlexStatementResponse>
<Status>Fail</Status>
<ErrorCode>${code}</ErrorCode>
<ErrorMessage>${message}</ErrorMessage>
</FlexStatementResponse>`;
}

function statementGenerating() {
  return `<?xml version="1.0"?><FlexStatementResponse>
<Status>Fail</Status>
<ErrorCode>1019</ErrorCode>
<ErrorMessage>Statement generation in progress.</ErrorMessage>
</FlexStatementResponse>`;
}

function statementXml() {
  return `<?xml version="1.0"?><FlexQueryResponse><FlexStatements count="1"/></FlexQueryResponse>`;
}

function makeFetch(
  responses: Map<string, { body: string; ok?: boolean; status?: number }>,
): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const key = [...responses.keys()].find((k) => url.includes(k));
    const entry = key ? responses.get(key) : undefined;
    if (!entry) throw new Error(`Unexpected fetch: ${url}`);
    const ok = entry.ok !== false;
    return {
      ok,
      status: entry.status ?? (ok ? 200 : 500),
      text: async () => entry.body,
    } as Response;
  };
}

describe("createFlexClient — fetchFlexStatement", () => {
  it("fetches and returns the statement XML on success", async () => {
    const STMT_URL = "https://flex.ibkr.com/GetStatement";
    const fetches = new Map([
      ["SendRequest", { body: sendRequestSuccess("REF123", STMT_URL) }],
      [STMT_URL, { body: statementXml() }],
    ]);
    const client = createFlexClient({
      baseUrl: "https://flex.ibkr.com",
      fetch: makeFetch(fetches),
    });
    const xml = await client.fetchFlexStatement("TOKEN", "QUERY");
    expect(xml).toContain("FlexQueryResponse");
  });

  it("retries on 1019 and succeeds when statement becomes ready", async () => {
    const STMT_URL = "https://flex.ibkr.com/GetStatement";
    let getCount = 0;
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("SendRequest")) {
        return {
          ok: true,
          status: 200,
          text: async () => sendRequestSuccess("R1", STMT_URL),
        } as Response;
      }
      getCount++;
      // First two attempts: still generating; third: ready.
      const body = getCount < 3 ? statementGenerating() : statementXml();
      return { ok: true, status: 200, text: async () => body } as Response;
    };
    const client = createFlexClient({ baseUrl: "https://flex.ibkr.com", fetch: fetchFn });
    const xml = await client.fetchFlexStatement("T", "Q");
    expect(xml).toContain("FlexQueryResponse");
    expect(getCount).toBe(3);
  });

  it("throws IbkrFlexError(expired) on error code 1012", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => sendRequestError("1012", "Token has expired."),
      }) as Response;
    const client = createFlexClient({ baseUrl: "https://x.com", fetch: fetchFn });
    await expect(client.fetchFlexStatement("T", "Q")).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("throws IbkrFlexError(error) on error code 1015", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => sendRequestError("1015", "Invalid token or IP mismatch."),
      }) as Response;
    const client = createFlexClient({ baseUrl: "https://x.com", fetch: fetchFn });
    await expect(client.fetchFlexStatement("T", "Q")).rejects.toMatchObject({
      code: "error",
    });
  });

  it("throws IbkrFlexError on unexpected error code", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => sendRequestError("9999", "Unknown."),
      }) as Response;
    const client = createFlexClient({ baseUrl: "https://x.com", fetch: fetchFn });
    await expect(client.fetchFlexStatement("T", "Q")).rejects.toBeInstanceOf(IbkrFlexError);
  });

  it("throws when SendRequest returns no ReferenceCode", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          `<?xml version="1.0"?><FlexStatementResponse><Status>Success</Status></FlexStatementResponse>`,
      }) as Response;
    const client = createFlexClient({ baseUrl: "https://x.com", fetch: fetchFn });
    await expect(client.fetchFlexStatement("T", "Q")).rejects.toBeInstanceOf(IbkrFlexError);
  });

  it("throws on HTTP error from SendRequest", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      ({ ok: false, status: 503, text: async () => "Service unavailable" }) as Response;
    const client = createFlexClient({ baseUrl: "https://x.com", fetch: fetchFn });
    await expect(client.fetchFlexStatement("T", "Q")).rejects.toBeInstanceOf(IbkrFlexError);
  });
});
