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

import { SessionErrorGuard } from "../src/components/session-error-guard";

beforeEach(() => {
  signInMock.mockReset();
  useSessionMock.mockReset();
});

describe("SessionErrorGuard", () => {
  it("forces a fresh sign-in when the refresh failed", () => {
    useSessionMock.mockReturnValue({
      data: { error: "RefreshAccessTokenError" },
    });
    render(<SessionErrorGuard />);
    expect(signInMock).toHaveBeenCalledWith("authentik");
  });

  it("forces a fresh sign-in when no refresh token was ever issued", () => {
    useSessionMock.mockReturnValue({ data: { error: "RefreshTokenMissing" } });
    render(<SessionErrorGuard />);
    expect(signInMock).toHaveBeenCalledWith("authentik");
  });

  it("does nothing for a healthy session", () => {
    useSessionMock.mockReturnValue({ data: { accessToken: "tok-123" } });
    render(<SessionErrorGuard />);
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("does nothing when signed out", () => {
    useSessionMock.mockReturnValue({ data: null });
    render(<SessionErrorGuard />);
    expect(signInMock).not.toHaveBeenCalled();
  });
});
