import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// Mock next-auth's useSession + signIn (hoisted so the factory can reference the spies).
const { useSessionMock, signInMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  signInMock: vi.fn(),
}));
vi.mock("next-auth/react", () => ({
  useSession: useSessionMock,
  signIn: signInMock,
}));

const refreshMock = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

import { SessionErrorGuard } from "../src/components/session-error-guard";

beforeEach(() => {
  signInMock.mockReset();
  useSessionMock.mockReset();
  refreshMock.mockReset();
});

describe("SessionErrorGuard", () => {
  it("forces a fresh sign-in when the refresh failed", () => {
    useSessionMock.mockReturnValue({
      data: { error: "RefreshAccessTokenError" },
      status: "authenticated",
    });
    render(<SessionErrorGuard />);
    expect(signInMock).toHaveBeenCalledWith("authentik");
  });

  it("forces a fresh sign-in when no refresh token was ever issued", () => {
    useSessionMock.mockReturnValue({
      data: { error: "RefreshTokenMissing" },
      status: "authenticated",
    });
    render(<SessionErrorGuard />);
    expect(signInMock).toHaveBeenCalledWith("authentik");
  });

  it("does nothing for a healthy session", () => {
    useSessionMock.mockReturnValue({
      data: { accessToken: "tok-123" },
      status: "authenticated",
    });
    render(<SessionErrorGuard />);
    expect(signInMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("does nothing when signed out", () => {
    useSessionMock.mockReturnValue({
      data: null,
      status: "unauthenticated",
    });
    render(<SessionErrorGuard />);
    expect(signInMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refreshes the router when serverSessionExpired is true and status is authenticated", () => {
    useSessionMock.mockReturnValue({
      data: { accessToken: "tok-123" },
      status: "authenticated",
    });
    render(<SessionErrorGuard serverSessionExpired={true} />);
    expect(refreshMock).toHaveBeenCalled();
  });

  it("does not refresh the router when serverSessionExpired is true but status is loading", () => {
    useSessionMock.mockReturnValue({
      data: null,
      status: "loading",
    });
    render(<SessionErrorGuard serverSessionExpired={true} />);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refreshes the router on visibilitychange when backgrounded for more than 2 minutes", () => {
    useSessionMock.mockReturnValue({
      data: { accessToken: "tok-123" },
      status: "authenticated",
    });

    vi.useFakeTimers();
    const systemTime = Date.now();
    vi.setSystemTime(systemTime);

    render(<SessionErrorGuard />);

    // Mock document.visibilityState
    const visibilityStateSpy = vi.spyOn(document, "visibilityState", "get");

    // 1. App goes to background
    visibilityStateSpy.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    // 2. Advance time by 3 minutes (180,000 ms)
    vi.setSystemTime(systemTime + 180_000);

    // 3. App comes back to foreground
    visibilityStateSpy.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(refreshMock).toHaveBeenCalled();

    vi.useRealTimers();
    visibilityStateSpy.mockRestore();
  });

  it("does not refresh the router on visibilitychange when backgrounded for less than 2 minutes", () => {
    useSessionMock.mockReturnValue({
      data: { accessToken: "tok-123" },
      status: "authenticated",
    });

    vi.useFakeTimers();
    const systemTime = Date.now();
    vi.setSystemTime(systemTime);

    render(<SessionErrorGuard />);

    const visibilityStateSpy = vi.spyOn(document, "visibilityState", "get");

    // 1. App goes to background
    visibilityStateSpy.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    // 2. Advance time by 1 minute (60,000 ms)
    vi.setSystemTime(systemTime + 60_000);

    // 3. App comes back to foreground
    visibilityStateSpy.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(refreshMock).not.toHaveBeenCalled();

    vi.useRealTimers();
    visibilityStateSpy.mockRestore();
  });
});
