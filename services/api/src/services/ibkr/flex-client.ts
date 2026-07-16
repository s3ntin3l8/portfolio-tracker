/**
 * IBKR Flex Web Service client.
 *
 * Two-step HTTP GET flow:
 *   1. SendRequest — submits the query and returns a ReferenceCode + URL.
 *   2. GetStatement — polls the returned URL until the statement is ready (code 1019
 *      = "generating") or an error is returned.
 *
 * Error codes:
 *   1012 — token expired → throws IbkrFlexError with code "expired"
 *   1015 — invalid/IP-blocked token → throws IbkrFlexError with code "error"
 *   1019 — statement still generating → retry (up to MAX_RETRIES)
 */

const DEFAULT_BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5_000;

export class IbkrFlexError extends Error {
  constructor(
    public readonly code: "expired" | "error",
    message: string,
  ) {
    super(message);
    this.name = "IbkrFlexError";
  }
}

export interface FlexClientOptions {
  baseUrl?: string;
  /** Injected fetch for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface IbkrFlexClient {
  fetchFlexStatement(token: string, queryId: string): Promise<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseErrorCode(xml: string): string | null {
  const m = xml.match(/<ErrorCode>\s*(\d+)\s*<\/ErrorCode>/);
  return m?.[1] ?? null;
}

function parseFieldValue(xml: string, field: string): string | null {
  const re = new RegExp(`<${field}>([^<]*)</${field}>`);
  const m = xml.match(re);
  return m?.[1]?.trim() ?? null;
}

function mapErrorCode(code: string | null, message: string): IbkrFlexError {
  if (code === "1012") return new IbkrFlexError("expired", `Token expired (1012): ${message}`);
  if (code === "1015") return new IbkrFlexError("error", `Invalid token (1015): ${message}`);
  return new IbkrFlexError("error", `Flex error (${code ?? "unknown"}): ${message}`);
}

export function createFlexClient(opts: FlexClientOptions = {}): IbkrFlexClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  async function get(url: string): Promise<string> {
    const res = await fetchFn(url);
    if (!res.ok) throw new IbkrFlexError("error", `HTTP ${res.status} from Flex`);
    return res.text();
  }

  return {
    async fetchFlexStatement(token: string, queryId: string): Promise<string> {
      // Step 1: submit the query
      const sendUrl = `${baseUrl}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
      const sendXml = await get(sendUrl);

      const sendErrorCode = parseErrorCode(sendXml);
      if (sendErrorCode && sendErrorCode !== "0") {
        const msg = parseFieldValue(sendXml, "ErrorMessage") ?? "Flex error";
        throw mapErrorCode(sendErrorCode, msg);
      }

      const status = parseFieldValue(sendXml, "Status");
      const referenceCode = parseFieldValue(sendXml, "ReferenceCode");
      const statementUrl = parseFieldValue(sendXml, "Url");

      if (status !== "Success" || !referenceCode || !statementUrl) {
        const msg =
          parseFieldValue(sendXml, "ErrorMessage") ?? "SendRequest returned no ReferenceCode";
        throw mapErrorCode(sendErrorCode, msg);
      }

      // Step 2: poll GetStatement until ready
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(RETRY_DELAY_MS);

        const getUrl = `${statementUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`;
        const stmtXml = await get(getUrl);

        const getErrorCode = parseErrorCode(stmtXml);
        if (getErrorCode === "1019") continue; // statement still generating — retry
        if (getErrorCode && getErrorCode !== "0") {
          const msg = parseFieldValue(stmtXml, "ErrorMessage") ?? "Flex error";
          throw mapErrorCode(getErrorCode, msg);
        }

        // Success — the XML is the statement itself (starts with FlexQueryResponse or similar)
        return stmtXml;
      }

      throw new IbkrFlexError("error", `Flex statement not ready after ${MAX_RETRIES} retries`);
    },
  };
}
