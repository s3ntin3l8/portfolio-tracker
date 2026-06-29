import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Mock next-auth's useSession (hoisted so the factory can reference the spy).
const { useSessionMock } = vi.hoisted(() => ({ useSessionMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

import { useApiClient } from "../src/lib/api";

function stubFetch() {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    text: async () => "[]",
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => vi.unstubAllGlobals());

describe("useApiClient", () => {
  it("forwards the session access token as a Bearer", async () => {
    useSessionMock.mockReturnValue({ data: { accessToken: "tok-123" } });
    const fetchSpy = stubFetch();

    const { result } = renderHook(() => useApiClient());
    await result.current.listPortfolios();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok-123",
    );
  });

  it("sends no auth header when there is no session", async () => {
    useSessionMock.mockReturnValue({ data: null });
    const fetchSpy = stubFetch();

    const { result } = renderHook(() => useApiClient());
    await result.current.listPortfolios();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(
      (init.headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it("reads the LATEST token after a re-render, not a render-time snapshot", async () => {
    // The client built while the token was "tok-A" must send "tok-B" once the session rotates —
    // this is what keeps a long backgrounded import from 401ing on a stale captured token.
    useSessionMock.mockReturnValue({ data: { accessToken: "tok-A" } });
    const fetchSpy = stubFetch();

    const { result, rerender } = renderHook(() => useApiClient());
    const clientBeforeRotation = result.current;

    useSessionMock.mockReturnValue({ data: { accessToken: "tok-B" } });
    rerender();

    await clientBeforeRotation.listPortfolios();
    const init = fetchSpy.mock.calls.at(-1)![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-B");
  });
});
